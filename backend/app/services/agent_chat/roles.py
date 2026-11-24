"""Роли ИИ-агентов общего чата: стартовый набор, правка, поиск адресатов в тексте.

Роль — строка БД (инструкция + необязательная модель из модельного роутера), а не
код: исследователь правит её в интерфейсе. Стартовые роли создаются при первом
обращении, если таблица пуста; удалить можно только пользовательскую роль.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select

from app.models import db
from app.schemas.agent_chat import (
    AgentRoleCreate,
    AgentRoleOut,
    AgentRolesPage,
    AgentRoleUpdate,
)


def utcnow() -> datetime:
    """UTC без tzinfo для совместимости с существующими колонками DateTime."""
    return datetime.now(UTC).replace(tzinfo=None)


BASE_INSTRUCTION = (
    "Ты — участник исследовательского консилиума в приложении DipLock. Доброволец "
    "не является пациентом: не ставь диагнозов, не давай лечебных рекомендаций и "
    "не оценивай личность. В чате — исследователь и коллеги-эксперты; ты видишь "
    "переписку до текущего вопроса, реплики коллег подписаны их ролями. Отвечай "
    "по-русски, коротко и по существу. Не выдумывай числа, измерения и ссылки на "
    "публикации; отделяй факты от гипотез; если данных нет — скажи прямо. ЭЭГ и "
    "досье автоматически не передаются; не делай вид, что видел данные, которых "
    "нет в переписке."
)

DEFAULT_ROLES: tuple[tuple[str, str, str], ...] = (
    (
        "psychologist", "Психолог",
        "Роль: психолог. Помогаешь понять переживания добровольца: задаёшь "
        "ненаводящие вопросы, предлагаешь способы самоописания состояния, "
        "отмечаешь риск внушения и подтверждающей предвзятости.",
    ),
    (
        "psychotherapist", "Психотерапевт",
        "Роль: психотерапевт. Смотришь на эмоциональные и творческие процессы, "
        "динамику состояния и безопасную работу с добровольцем. Не ставишь "
        "диагнозов и не даёшь лечебных рекомендаций.",
    ),
    (
        "neurophysiologist", "Нейрофизиолог",
        "Роль: нейрофизиолог. Объясняешь возможные механизмы наблюдаемых "
        "изменений ЭЭГ, всегда называя альтернативные объяснения (артефакты, "
        "мышечная активность, состояние бодрствования, ожидания).",
    ),
    (
        "eeg_methodist", "ЭЭГ-методист",
        "Роль: ЭЭГ-методист. Знаешь расшифровку энцефалограмм: ритмы, "
        "артефакты, монтажи, качество записи и пределы выводов. Следишь, "
        "чтобы вывод не выходил за пределы данных.",
    ),
    (
        "mne_expert", "MNE-эксперт",
        "Роль: эксперт по библиотеке MNE-Python. Подсказываешь корректные "
        "методы фильтрации, эпохирования, ICA, прямой и обратной задач, "
        "локализации диполей; предупреждаешь об ограничениях и дрейфе API.",
    ),
    (
        "archivist", "Архивариус",
        "Роль: архивариус-библиотекарь. Модерируешь обсуждение, подводишь "
        "итоги и фиксируешь разногласия, предлагаешь темы и ключевые слова "
        "для поиска публикаций, ведёшь общую базу знаний. В нити может быть "
        "блок «Найденные в интернете материалы» — это результаты явного "
        "веб-поиска с машинным переводом: ссылайся на них с оговоркой о "
        "переводе и проверяй, что источник действительно относится к вопросу. "
        "Без такого блока не называй конкретных статей, если не уверен в них.",
    ),
    (
        "assistant", "Ассистент",
        "Роль: ассистент по документации проекта DipLock. Объясняешь "
        "пользователю разделы Wiki, команды запуска, термины и правила "
        "простым языком, опираясь на переданный текст статьи. Не выдумывай "
        "команд и путей, которых нет в статье; если ответа в статье нет — "
        "скажи об этом и предложи, где искать. Ссылайся на раздел статьи, "
        "а не пересказывай её целиком.",
    ),
)


ARCHIVIST_ID = "archivist"
ASSISTANT_ID = "assistant"

REASONING_HINTS: dict[str, str] = {
    "low": (
        "Уровень размышления: низкий — отвечай сразу и коротко, без перебора "
        "вариантов; одна-две фразы по существу."
    ),
    "medium": (
        "Уровень размышления: обычный — сначала краткий ход мысли, затем ответ; "
        "называй ключевые допущения."
    ),
    "high": (
        "Уровень размышления: высокий — перечисли альтернативные объяснения и "
        "проверь вывод на противоречия, затем дай ответ; явно отдели факты от "
        "гипотез и укажи, чего не хватает для уверенного вывода."
    ),
}


class AgentChatError(Exception):
    """Ошибка работы с ролью: текст для UI и HTTP-код."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _split_skills(value: str | None) -> list[str]:
    """Навыки из колонки (через запятую) — списком без пустых элементов."""
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def _out(row: db.AgentRole) -> AgentRoleOut:
    """Типизированная роль."""
    return AgentRoleOut.model_validate({
        "id": row.id, "label": row.label, "instruction": row.instruction,
        "provider_id": row.provider_id, "model": row.model,
        "reasoning": row.reasoning or None,
        "skills": _split_skills(str(row.skills) if row.skills else None),
        "enabled": bool(row.enabled), "builtin": bool(row.builtin),
        "sort": row.sort,
    })


def _set(row: Any, **fields: Any) -> None:
    """Мутация ORM-строки: setattr с переменными — mypy и ruff без замечаний."""
    for name, value in fields.items():
        setattr(row, name, value)


async def ensure_defaults() -> None:
    """Стартовый набор ролей, если таблица пуста (пользовательские не трогаем)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        total = int(await session.scalar(
            select(func.count()).select_from(db.AgentRole),
        ) or 0)
        if total:
            return
        now = utcnow()
        for order, (role_id, label, instruction) in enumerate(DEFAULT_ROLES):
            session.add(db.AgentRole(
                id=role_id, label=label, instruction=instruction,
                provider_id=None, model=None, enabled=True, builtin=True,
                sort=order, updated_at=now,
            ))
        await session.commit()


async def list_roles() -> AgentRolesPage:
    """Все роли по порядку; при первом обращении создаёт стартовый набор."""
    await ensure_defaults()
    async with db.AsyncSessionLocal() as session:
        rows = (await session.scalars(
            select(db.AgentRole).order_by(db.AgentRole.sort, db.AgentRole.id),
        )).all()
        return AgentRolesPage(items=[_out(row) for row in rows])


async def get_role(role_id: str) -> AgentRoleOut:
    """Роль по id; отсутствующая — 404."""
    await ensure_defaults()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentRole, role_id)
        if row is None:
            raise AgentChatError(404, "Роль не найдена")
        return _out(row)


async def create_role(payload: AgentRoleCreate) -> AgentRoleOut:
    """Пользовательская роль; метка уникальна (по ней адресуют ``@``)."""
    await ensure_defaults()
    label = payload.label.strip()
    async with db.AsyncSessionLocal() as session:
        rows = (await session.scalars(select(db.AgentRole))).all()
        if any(str(row.label).casefold() == label.casefold() for row in rows):
            raise AgentChatError(409, "Роль с таким названием уже есть")
        row = db.AgentRole(
            id=f"custom-{uuid.uuid4().hex[:8]}", label=label,
            instruction=payload.instruction.strip(),
            provider_id=payload.provider_id or None, model=payload.model or None,
            reasoning=payload.reasoning,
            skills=", ".join(payload.skills) or None,
            enabled=True, builtin=False,
            sort=max([int(r.sort) for r in rows] + [0]) + 1,
            updated_at=utcnow(),
        )
        session.add(row)
        await session.commit()
        return _out(row)


async def update_role(role_id: str, payload: AgentRoleUpdate) -> AgentRoleOut:
    """Правка роли; пустая строка у провайдера/модели сбрасывает выбор."""
    await ensure_defaults()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentRole, role_id)
        if row is None:
            raise AgentChatError(404, "Роль не найдена")
        data = payload.model_dump(exclude_unset=True)
        if "label" in data and data["label"] is not None:
            label = str(data["label"]).strip()
            others = (await session.scalars(
                select(db.AgentRole).where(db.AgentRole.id != role_id),
            )).all()
            if any(str(other.label).casefold() == label.casefold() for other in others):
                raise AgentChatError(409, "Роль с таким названием уже есть")
            _set(row, label=label)
        if data.get("instruction") is not None:
            _set(row, instruction=str(data["instruction"]).strip())
        for name in ("provider_id", "model"):
            if name in data:
                _set(row, **{name: (data[name] or None)})
        if "reasoning" in data:
            _set(row, reasoning=data["reasoning"] or None)
        if "skills" in data:
            _set(row, skills=", ".join(data["skills"] or []) or None)
        if data.get("enabled") is not None:
            _set(row, enabled=bool(data["enabled"]))
        _set(row, updated_at=utcnow())
        await session.commit()
        return _out(row)


async def delete_role(role_id: str) -> None:
    """Удаляет пользовательскую роль; стартовые можно только выключить."""
    await ensure_defaults()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.AgentRole, role_id)
        if row is None:
            raise AgentChatError(404, "Роль не найдена")
        if row.builtin:
            raise AgentChatError(400, "Стартовую роль нельзя удалить — выключите её")
        await session.delete(row)
        await session.commit()


def find_mentions(text: str, roles: list[AgentRoleOut]) -> list[str]:
    """Роли, названные в тексте через ``@Метка`` или ``@id`` (порядок появления)."""
    found: list[tuple[int, str]] = []
    for role in roles:
        for name in (role.label, role.id):
            match = re.search(
                rf"@{re.escape(name)}(?![\w-])", text, flags=re.IGNORECASE,
            )
            if match:
                found.append((match.start(), role.id))
                break
    found.sort()
    return [role_id for _, role_id in found]
