"""Хранение нитей и реплик общего чата агентов.

Текст ответа пишется в БД до объявления успеха задачи; прерванный рестартом
ответ (``running``) помечается ``interrupted``.
"""

import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import delete, func, select

from app.models import db
from app.schemas.agent_chat import (
    AgentMessageOut,
    AgentMessagesPage,
    AgentThreadCreate,
    AgentThreadOut,
    AgentThreadsPage,
)
from app.services.agent_chat.roles import AgentChatError
from app.services.agent_chat.roles import utcnow as _utcnow


def _set(row: Any, **fields: Any) -> None:
    """Мутация ORM-строки: setattr с переменными — mypy и ruff без замечаний."""
    for name, value in fields.items():
        setattr(row, name, value)


def message_out(row: db.AgentMessage) -> AgentMessageOut:
    """Типизированная реплика."""
    return AgentMessageOut.model_validate({
        "id": row.id, "thread_id": row.thread_id, "author": row.author_kind,
        "role_id": row.role_id, "addressees": list(row.addressees or []),
        "status": row.status, "text": row.text, "model": row.model,
        "error": row.error, "warnings": list(row.warnings or []),
        "latency_ms": row.latency_ms, "created_at": row.created_at,
        "finished_at": row.finished_at,
    })


def _thread_out(row: db.AgentThread, messages: int) -> AgentThreadOut:
    """Нить с честным числом реплик."""
    return AgentThreadOut.model_validate({
        "id": row.id, "title": row.title, "messages": messages,
        "created_at": row.created_at,
    })


async def create_thread(payload: AgentThreadCreate) -> AgentThreadOut:
    """Новая пустая нить."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = db.AgentThread(
            id=str(uuid.uuid4()), title=payload.title.strip(),
            created_at=_utcnow(),
        )
        session.add(row)
        await session.commit()
        return _thread_out(row, 0)


async def list_threads() -> AgentThreadsPage:
    """Нити, новые сверху, с числом реплик."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        counts: dict[str, int] = {}
        count_pairs: Sequence[Any] = (await session.execute(
            select(db.AgentMessage.thread_id, func.count())
            .group_by(db.AgentMessage.thread_id),
        )).all()
        for pair in count_pairs:
            counts[str(pair[0])] = int(pair[1])
        rows = (await session.scalars(
            select(db.AgentThread).order_by(db.AgentThread.created_at.desc(), db.AgentThread.id),
        )).all()
        return AgentThreadsPage(items=[
            _thread_out(row, int(counts.get(str(row.id), 0))) for row in rows
        ])


async def require_thread(thread_id: str) -> None:
    """Отсутствующая нить — 404."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        if await session.get(db.AgentThread, thread_id) is None:
            raise AgentChatError(404, "Нить чата не найдена")


async def delete_thread(thread_id: str) -> None:
    """Удаляет нить вместе с репликами."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentThread, thread_id)
        if row is None:
            raise AgentChatError(404, "Нить чата не найдена")
        running = await session.scalar(
            select(db.AgentMessage.id).where(
                db.AgentMessage.thread_id == thread_id,
                db.AgentMessage.status == "running",
            ).limit(1),
        )
        if running is not None:
            raise AgentChatError(409, "Дождитесь завершения ответов, прежде чем удалять нить")
        await session.execute(
            delete(db.AgentMessage).where(db.AgentMessage.thread_id == thread_id),
        )
        await session.delete(row)
        await session.commit()


async def list_messages(thread_id: str) -> AgentMessagesPage:
    """Переписка нити по времени."""
    await require_thread(thread_id)
    async with db.AsyncSessionLocal() as session:
        rows = (await session.scalars(
            select(db.AgentMessage).where(db.AgentMessage.thread_id == thread_id)
            .order_by(db.AgentMessage.created_at, db.AgentMessage.id),
        )).all()
        return AgentMessagesPage(items=[message_out(row) for row in rows])


async def get_message(thread_id: str, message_id: str) -> AgentMessageOut:
    """Реплика нити; чужая/отсутствующая — 404."""
    await require_thread(thread_id)
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentMessage, message_id)
        if row is None or row.thread_id != thread_id:
            raise AgentChatError(404, "Реплика не найдена в этой нити")
        return message_out(row)


async def add_exchange(
    thread_id: str, text: str, role_ids: list[str],
) -> tuple[AgentMessageOut, list[AgentMessageOut]]:
    """Реплика исследователя и по ожидающей строке на каждого адресата."""
    await require_thread(thread_id)
    now = _utcnow()
    async with db.AsyncSessionLocal() as session:
        question_id = str(uuid.uuid4())
        question = db.AgentMessage(
            id=question_id, thread_id=thread_id, author_kind="researcher",
            role_id=None, question_id=None, addressees=role_ids, status="ok", text=text,
            warnings=[], created_at=now, finished_at=now,
        )
        session.add(question)
        replies = [
            db.AgentMessage(
                id=str(uuid.uuid4()), thread_id=thread_id, author_kind="agent",
                role_id=role_id, question_id=question_id,
                addressees=[], status="running", text=None,
                warnings=[], created_at=now,
            )
            for role_id in role_ids
        ]
        session.add_all(replies)
        await session.commit()
        return message_out(question), [message_out(row) for row in replies]


async def restart_reply(thread_id: str, message_id: str) -> AgentMessageOut:
    """Повтор неудавшегося ответа: та же строка снова «running»."""
    await require_thread(thread_id)
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentMessage, message_id)
        if row is None or row.thread_id != thread_id or row.author_kind != "agent":
            raise AgentChatError(404, "Ответ агента не найден в этой нити")
        if row.status not in ("failed", "interrupted"):
            raise AgentChatError(409, "Повторить можно только неудавшийся ответ")
        warnings = list(row.warnings or [])
        if row.error:
            # След прошлой попытки не стираем: ошибка уходит в warnings реплики.
            warnings.append(f"Предыдущая попытка: {row.error}")
        _set(
            row, status="running", error=None, text=None, warnings=warnings,
            latency_ms=None, finished_at=None,
        )
        await session.commit()
        return message_out(row)


async def history_before(thread_id: str, message_id: str) -> list[AgentMessageOut]:
    """История до исходного вопроса ответа, без будущих реплик и коллег этого обмена."""
    await require_thread(thread_id)
    async with db.AsyncSessionLocal() as session:
        reply = await session.get(db.AgentMessage, message_id)
        if reply is None or reply.thread_id != thread_id:
            raise AgentChatError(404, "Ответ не найден в этой нити")
        question_id = reply.question_id
    if not question_id:
        raise AgentChatError(409, "У ответа не найден исходный вопрос")
    page = await list_messages(thread_id)
    question_index = next(
        (index for index, item in enumerate(page.items) if item.id == question_id),
        None,
    )
    if question_index is None:
        raise AgentChatError(409, "Исходный вопрос ответа не найден в переписке")
    return [
        item for item in page.items[:question_index + 1]
        if item.author == "researcher" or item.status == "ok"
    ]


async def save_reply(
    message_id: str, *, text: str, model: str | None, warnings: list[str],
    latency_ms: float | None,
) -> None:
    """Успешный ответ — запись до объявления успеха задачи."""
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentMessage, message_id)
        if row is not None:
            # След прошлых неудачных попыток переживает успех (см. restart_reply).
            prior_all: Any = row.warnings
            prior = [
                str(item) for item in list(prior_all or [])
                if str(item).startswith("Предыдущая попытка:")
            ]
            _set(
                row, status="ok", text=text, model=model,
                warnings=[*prior, *warnings],
                latency_ms=latency_ms, error=None, finished_at=_utcnow(),
            )
            await session.commit()


async def mark_failed(message_id: str, error: str, model: str | None = None) -> None:
    """Честный отказ ответа."""
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentMessage, message_id)
        if row is not None:
            _set(row, status="failed", error=error, model=model, finished_at=_utcnow())
            await session.commit()


async def attach_job(message_id: str, job_id: str) -> None:
    """Связь ответа с задачей очереди."""
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentMessage, message_id)
        if row is not None:
            _set(row, job_id=job_id)
            await session.commit()


async def mark_interrupted() -> int:
    """Старт приложения: «running» без живой задачи — прервано рестартом."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        rows = (await session.scalars(
            select(db.AgentMessage).where(db.AgentMessage.status == "running"),
        )).all()
        for row in rows:
            _set(
                row, status="interrupted", finished_at=_utcnow(),
                error="Прервано перезапуском сервера — повторите ответ",
            )
        await session.commit()
        return len(rows)
