"""Хранение боковой консультации (срез 0015): нити чата и append-only реплики.

Принципы §8 ``docs/rules/consilium.md``: реплики не правятся (повтор неудавшегося
ответа — новая строка), текст ответа пишется в БД до объявления успеха задачи,
состояние прерванной операции живёт в строке сообщения (``status='running'`` при
рестарте процесса переводится в ``interrupted``).
"""

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models import db
from app.schemas.consilium import (
    ConsiliumChatMessageCreate,
    ConsiliumChatMessageOut,
    ConsiliumChatMessageRetry,
    ConsiliumChatMessagesPage,
    ConsiliumChatOut,
    ConsiliumChatSendOut,
    ConsiliumChatsPage,
)
from app.services.consilium import store


def _set(row: Any, **fields: Any) -> None:
    """Мутация ORM-строки: setattr с переменными — mypy и ruff без замечаний."""
    for name, value in fields.items():
        setattr(row, name, value)


def _message_out(row: db.ConsiliumChatMessage) -> ConsiliumChatMessageOut:
    """Типизированная реплика консультации."""
    return ConsiliumChatMessageOut.model_validate({
        "id": row.id, "case_id": row.case_id, "chat_id": row.chat_id,
        "author": row.author_kind, "role": row.role, "status": row.status,
        "text": row.text, "model": row.model,
        "instruction_version": row.instruction_version,
        "snapshot_id": row.snapshot_id, "warnings": row.warnings,
        "error": row.error, "latency_ms": row.latency_ms,
        "created_at": row.created_at, "finished_at": row.finished_at,
    })


def _chat_out(row: db.ConsiliumChat, messages: int) -> ConsiliumChatOut:
    """Нить консультации с честным числом реплик."""
    return ConsiliumChatOut.model_validate({
        "id": row.id, "case_id": row.case_id, "role": row.role,
        "messages": messages, "created_at": row.created_at,
    })


async def _require_chat(
    session: AsyncSession, case_id: str, chat_id: str,
) -> db.ConsiliumChat:
    """Чужая/отсутствующая нить — 404, не пустая переписка."""
    row = await session.get(db.ConsiliumChat, chat_id)
    if row is None or row.case_id != case_id:
        raise store.ConsiliumError(404, "Нить консультации не найдена в этом исследовании")
    return row


async def _require_no_running(session: AsyncSession, chat_id: str) -> None:
    """В нити один идущий ответ: новый запрос к советнику — 409 до завершения."""
    running = int(await session.scalar(select(func.count()).select_from(
        db.ConsiliumChatMessage,
    ).where(
        db.ConsiliumChatMessage.chat_id == chat_id,
        db.ConsiliumChatMessage.author_kind == "advisor",
        db.ConsiliumChatMessage.status == "running",
    )) or 0)
    if running:
        raise store.ConsiliumError(409, "Советник уже отвечает — дождитесь ответа")


async def list_chats(case_id: str) -> ConsiliumChatsPage:
    """Нити консультаций дела с числом реплик (хронологически, старые сверху)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        rows = (await session.scalars(select(db.ConsiliumChat).where(
            db.ConsiliumChat.case_id == case_id,
        ).order_by(db.ConsiliumChat.created_at, db.ConsiliumChat.id))).all()
        counts: dict[str, int] = {}
        message_rows: Sequence[str] = (await session.scalars(
            select(db.ConsiliumChatMessage.chat_id).where(
                db.ConsiliumChatMessage.case_id == case_id,
            ),
        )).all()
        for chat_key in message_rows:
            counts[str(chat_key)] = counts.get(str(chat_key), 0) + 1
        return ConsiliumChatsPage(total=len(rows), items=[
            _chat_out(row, counts.get(str(row.id), 0)) for row in rows
        ])


async def list_messages(
    case_id: str, chat_id: str, limit: int, offset: int,
) -> ConsiliumChatMessagesPage:
    """Реплики нити по порядку переписки (append-only, все строки)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        chat = await _require_chat(session, case_id, chat_id)
        condition: ColumnElement[bool] = (
            db.ConsiliumChatMessage.chat_id == str(chat.id)
        )
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumChatMessage,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumChatMessage).where(
            condition,
        ).order_by(
            db.ConsiliumChatMessage.created_at,
            # Пара «реплика + ответ» пишется одним мгновением: реплика исследователя
            # всегда идёт раньше своего ответа советника
            db.ConsiliumChatMessage.author_kind == "advisor",
            db.ConsiliumChatMessage.id,
        ).limit(limit).offset(offset))).all()
        return ConsiliumChatMessagesPage(total=total, items=[
            _message_out(row) for row in rows
        ])


async def load_conversation(
    case_id: str, chat_id: str,
) -> list[ConsiliumChatMessageOut]:
    """Полная переписка нити по порядку (для промпта советника)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        chat = await _require_chat(session, case_id, chat_id)
        rows = (await session.scalars(select(db.ConsiliumChatMessage).where(
            db.ConsiliumChatMessage.chat_id == str(chat.id),
        ).order_by(
            db.ConsiliumChatMessage.created_at,
            db.ConsiliumChatMessage.author_kind == "advisor",
            db.ConsiliumChatMessage.id,
        ))).all()
        return [_message_out(row) for row in rows]


# --- WRITE-АПИ: реплика исследователя и попытки ответа советника ---


async def require_message(case_id: str, message_id: str) -> ConsiliumChatMessageOut:
    """Точная реплика переписки; чужая/удалённая — 404 (адресация стрима и повтора)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumChatMessage, message_id)
        if row is None or row.case_id != case_id:
            raise store.ConsiliumError(404, "Сообщение не найдено в этом исследовании")
        return _message_out(row)

async def send_message(
    case_id: str,
    payload: ConsiliumChatMessageCreate,
    *,
    snapshot_id: str,
    instruction_version: str,
) -> tuple[ConsiliumChatSendOut, bool]:
    """Реплика исследователя и ожидающая строка ответа одной транзакцией.

    Нить заводится при первом сообщении (одна на пару дело × советник);
    повтор ``request_id`` возвращает прежний результат и не шлёт данные снова.
    """
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:chat"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumChatSendOut.model_validate(repeat.response), False
        await store._bump(session, case, payload.expected_version)
        chat = await session.scalar(select(db.ConsiliumChat).where(
            db.ConsiliumChat.case_id == case_id,
            db.ConsiliumChat.role == payload.role,
        ))
        if chat is None:
            chat = db.ConsiliumChat(
                id=str(uuid.uuid4()), case_id=case_id, role=payload.role,
                created_at=datetime.utcnow(),
            )
            session.add(chat)
            await session.flush()
        await _require_no_running(session, str(chat.id))
        now = datetime.utcnow()
        user_row = db.ConsiliumChatMessage(
            id=str(uuid.uuid4()), case_id=case_id, chat_id=str(chat.id),
            author_kind="researcher", role=payload.role, text=payload.text,
            status="ok", model=None, instruction_version=None, snapshot_id=None,
            warnings=[], error=None, job_id=None, latency_ms=None,
            created_at=now, finished_at=now,
        )
        reply_row = db.ConsiliumChatMessage(
            id=str(uuid.uuid4()), case_id=case_id, chat_id=str(chat.id),
            author_kind="advisor", role=payload.role, text=None,
            status="running", model=None, instruction_version=instruction_version,
            snapshot_id=snapshot_id, warnings=[], error=None, job_id=None,
            latency_ms=None, created_at=now, finished_at=None,
        )
        session.add_all([user_row, reply_row])
        await session.flush()
        response = ConsiliumChatSendOut(
            message=_message_out(user_row), reply=_message_out(reply_row),
        )
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response, True


async def retry_reply(
    case_id: str,
    message_id: str,
    payload: ConsiliumChatMessageRetry,
    *,
    snapshot_id: str,
    instruction_version: str,
) -> tuple[ConsiliumChatMessageOut, bool]:
    """Повтор неудавшегося ответа советника: новая попытка, история остаётся."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:chat-retry"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumChatMessageOut.model_validate(repeat.response), False
        await store._bump(session, case, payload.expected_version)
        original = await session.get(db.ConsiliumChatMessage, message_id)
        if original is None or original.case_id != case_id:
            raise store.ConsiliumError(404, "Сообщение не найдено в этом исследовании")
        if original.author_kind != "advisor":
            raise store.ConsiliumError(400, "Повторить можно только ответ советника")
        if original.status not in ("failed", "cancelled", "interrupted"):
            raise store.ConsiliumError(400, "Повторить можно только неудавшийся ответ")
        await _require_no_running(session, str(original.chat_id))
        attempt = db.ConsiliumChatMessage(
            id=str(uuid.uuid4()), case_id=case_id, chat_id=str(original.chat_id),
            author_kind="advisor", role=str(original.role), text=None,
            status="running", model=None, instruction_version=instruction_version,
            snapshot_id=snapshot_id, warnings=[], error=None, job_id=None,
            latency_ms=None, created_at=datetime.utcnow(), finished_at=None,
        )
        session.add(attempt)
        await session.flush()
        response = _message_out(attempt)
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response, True


async def save_reply(
    message_id: str,
    *,
    text: str,
    model: str | None,
    warnings: list[str],
    latency_ms: float | None,
) -> None:
    """Обязательная запись ответа до объявления успеха задачи (§8)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumChatMessage, message_id)
        if row is None:
            return
        _set(
            row,
            status="ok", text=text, model=model, warnings=warnings,
            latency_ms=latency_ms, error=None, finished_at=datetime.utcnow(),
        )
        await session.commit()


async def mark_aborted(message_id: str, status: str, error: str) -> None:
    """Отменённый/неудавшийся ответ фиксируется в строке, не в файле задачи."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumChatMessage, message_id)
        if row is None:
            return
        _set(row, status=status, error=error, finished_at=datetime.utcnow())
        await session.commit()


async def mark_interrupted() -> int:
    """Старт приложения: живых задач нет, «running» — прервано рестартом (§8)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        rows = (await session.scalars(select(db.ConsiliumChatMessage).where(
            db.ConsiliumChatMessage.status == "running",
        ))).all()
        for row in rows:
            _set(
                row,
                status="interrupted",
                error="Прервано перезапуском сервера — повторите ответ",
                finished_at=datetime.utcnow(),
            )
        await session.commit()
        return len(rows)


async def attach_job(message_id: str, job_id: str) -> None:
    """Связь ответа с задачей очереди (файл задачи не хранит тексты)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumChatMessage, message_id)
        if row is not None:
            _set(row, job_id=job_id)
            await session.commit()