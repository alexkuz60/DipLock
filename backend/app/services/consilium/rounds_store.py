"""Хранение раундов советников (Т3): долговременные строки вместо файла задачи.

Инварианты (docs/rules/consilium.md §6, §8):

* ответы пишутся **после** вызова модели и только append-only («история не
  UPSERT»): повтор одной роли создаёт новую строку, прежняя остаётся;
* состояние прерванной операции живёт в строке раунда: ``running`` при
  рестарте процесса переводится в ``interrupted``;
* границы раунда: один раунд ответов на снимок, один раунд замечаний на
  исходный, один итог на снимок; повтор — только для неудавшихся ответов;
* успех операции объявляется после записи результатов (``save_outcomes``).
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models import db
from app.schemas.consilium import (
    ConsiliumAnswerOut,
    ConsiliumAnswerRetry,
    ConsiliumRoundAction,
    ConsiliumRoundCreate,
    ConsiliumRoundOut,
    ConsiliumRoundsPage,
    RoundKind,
    RoundStatus,
)
from app.services.consilium import store

# Повтор отдельного ответа допустим из этих состояний (не из running).
RETRYABLE: tuple[RoundStatus, ...] = ("done", "partial", "failed", "cancelled", "interrupted")


@dataclass(frozen=True)
class RoundPlan:
    """Подготовленный сервисом раунда план: роли, модель, инструкции, лимиты."""

    kind: RoundKind
    roles: tuple[str, ...]
    snapshot_id: str
    source_round_id: str | None
    model: str | None
    instruction_versions: dict[str, str]
    limits: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AnswerOutcome:
    """Итог одного вызова советника: текст появляется только при успехе."""

    role: str
    status: Literal["ok", "failed"]
    text: str | None = None
    error: str | None = None
    model: str | None = None
    instruction_version: str = ""
    latency_ms: float | None = None


def _set(row: Any, **fields: Any) -> None:
    """Мутация ORM-строки: setattr с переменными — mypy и ruff без замечаний."""
    for name, value in fields.items():
        setattr(row, name, value)


def _answer_out(row: db.ConsiliumAnswer) -> ConsiliumAnswerOut:
    """Контракт ответа из строки БД."""
    return ConsiliumAnswerOut.model_validate({
        "id": row.id, "case_id": row.case_id, "round_id": row.round_id,
        "role": row.role, "status": row.status, "text": row.text, "error": row.error,
        "model": row.model, "instruction_version": row.instruction_version,
        "latency_ms": row.latency_ms, "created_at": row.created_at,
    })


async def _answers_of(
    session: AsyncSession, round_ids: list[str],
) -> dict[str, list[db.ConsiliumAnswer]]:
    """Ответы раундов в порядке записи (append-only история)."""
    if not round_ids:
        return {}
    rows = (await session.scalars(select(db.ConsiliumAnswer).where(
        db.ConsiliumAnswer.round_id.in_(round_ids),
    ).order_by(db.ConsiliumAnswer.created_at, db.ConsiliumAnswer.id))).all()
    grouped: dict[str, list[db.ConsiliumAnswer]] = {}
    for row in rows:
        grouped.setdefault(str(row.round_id), []).append(row)
    return grouped


def _round_out(row: db.ConsiliumRound, answers: list[db.ConsiliumAnswer]) -> ConsiliumRoundOut:
    """Контракт раунда; ответы упорядочены по ролям плана, попытки — по времени."""
    order = {str(role): index for index, role in enumerate(row.limits.get("roles", []))}
    ordered = sorted(answers, key=lambda item: (
        order.get(str(item.role), 99), item.created_at, str(item.id),
    ))
    return ConsiliumRoundOut.model_validate({
        "id": row.id, "case_id": row.case_id, "kind": row.kind,
        "snapshot_id": row.snapshot_id, "source_round_id": row.source_round_id,
        "status": row.status, "model": row.model,
        "instruction_versions": row.instruction_versions, "limits": row.limits,
        "warnings": row.warnings, "error": row.error, "job_id": row.job_id,
        "created_at": row.created_at, "finished_at": row.finished_at,
        "answers": [_answer_out(answer) for answer in ordered],
    })


async def _require_round(
    session: AsyncSession, case_id: str, round_id: str,
) -> db.ConsiliumRound:
    """Чужой/удалённый раунд — 404, не пустая история."""
    row = await session.get(db.ConsiliumRound, round_id)
    if row is None or row.case_id != case_id:
        raise store.ConsiliumError(404, "Раунд не найден в этом исследовании")
    return row


async def _require_snapshot(session: AsyncSession, case_id: str, snapshot_id: str) -> None:
    """Раунд строится только на опубликованном снимке этого дела."""
    row = await session.get(db.ConsiliumSnapshotRecord, snapshot_id)
    if row is None or row.case_id != case_id:
        raise store.ConsiliumError(404, "Снимок досье не найден в этом исследовании")


async def _check_bounds(session: AsyncSession, case_id: str, plan: RoundPlan) -> None:
    """Границы раундов (§6): один ответный/замечаний/итог, без бесконечного диалога."""

    async def count(condition: Any) -> int:
        return int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumRound,
        ).where(db.ConsiliumRound.case_id == case_id, condition)) or 0)

    if plan.kind == "initial":
        if await count(db.ConsiliumRound.snapshot_id == plan.snapshot_id) > 0:
            raise store.ConsiliumError(409, "Раунд ответов по этому снимку уже запущен")
        return
    source = await session.get(db.ConsiliumRound, plan.source_round_id or "")
    if source is None or source.case_id != case_id:
        raise store.ConsiliumError(404, "Исходный раунд не найден в этом исследовании")
    if source.status not in ("done", "partial"):
        raise store.ConsiliumError(409, "Исходный раунд ещё не завершён")
    if plan.kind == "remarks":
        if source.kind != "initial":
            raise store.ConsiliumError(409, "Замечания пишутся к раунду ответов")
        if await count(db.ConsiliumRound.source_round_id == source.id) > 0:
            raise store.ConsiliumError(409, "Раунд замечаний к этому источнику уже запущен")
    if plan.kind == "summary":
        # Один итог на снимок (§6): «и итог с сохранением разногласий».
        if source.kind not in ("initial", "remarks"):
            raise store.ConsiliumError(409, "Итог составляется после ответов или замечаний")
        summaries = (await session.scalars(select(db.ConsiliumRound).where(
            db.ConsiliumRound.case_id == case_id,
            db.ConsiliumRound.kind == "summary",
        ))).all()
        if any(item.snapshot_id == plan.snapshot_id for item in summaries):
            raise store.ConsiliumError(409, "Итог по этому снимку уже составлен")


async def create_round(
    case_id: str,
    payload: ConsiliumRoundCreate | ConsiliumRoundAction,
    plan: RoundPlan,
) -> tuple[ConsiliumRoundOut, bool]:
    """Создаёт строку раунда с квитанцией; (раунд, создан ли новой строкой).

    Второй результат нужен вызывающему: при повторе ключа задача модели
    не запускается заново — возвращается ранее принятый раунд.
    """
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:round:{plan.kind}"
        if plan.kind == "summary":
            scope = f"{case_id}:round:summary:{plan.source_round_id}"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumRoundOut.model_validate(repeat.response), False
        await _require_snapshot(session, case_id, plan.snapshot_id)
        await _check_bounds(session, case_id, plan)
        await store._bump(session, case, payload.expected_version)
        now = datetime.utcnow()
        row = db.ConsiliumRound(
            id=str(uuid.uuid4()), case_id=case_id, kind=plan.kind,
            snapshot_id=plan.snapshot_id, source_round_id=plan.source_round_id,
            status="running", model=plan.model,
            instruction_versions=dict(plan.instruction_versions), limits=dict(plan.limits),
            warnings=[], error=None, job_id=None, created_at=now, finished_at=None,
        )
        session.add(row)
        await session.flush()
        response = _round_out(row, [])
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response, True


async def retry_answer(
    case_id: str, round_id: str, payload: ConsiliumAnswerRetry,
) -> tuple[ConsiliumRoundOut, bool]:
    """Повтор неудавшегося ответа: новая запись, прежняя попытка остаётся."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:round_retry:{round_id}"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumRoundOut.model_validate(repeat.response), False
        row = await _require_round(session, case_id, round_id)
        if row.status == "running":
            raise store.ConsiliumError(409, "Раунд ещё выполняется — дождитесь итога")
        if row.status not in RETRYABLE:
            raise store.ConsiliumError(409, "Повтор ответа недоступен для этого раунда")
        expected_roles = [str(role) for role in row.limits.get("roles", [])] or (
            ["summary"] if row.kind == "summary" else []
        )
        if payload.role not in expected_roles:
            raise store.ConsiliumError(409, "Эта роль не участвует в раунде")
        answers = (await session.scalars(select(db.ConsiliumAnswer).where(
            db.ConsiliumAnswer.round_id == round_id,
            db.ConsiliumAnswer.role == payload.role,
        ).order_by(db.ConsiliumAnswer.created_at.desc(), db.ConsiliumAnswer.id.desc()))).all()
        if answers and answers[0].status == "ok":
            raise store.ConsiliumError(409, "У советника уже есть успешный ответ — повтор не нужен")
        await store._bump(session, case, payload.expected_version)
        _set(row, status="running", error=None, finished_at=None)
        await session.flush()
        response = _round_out(row, list(reversed(answers)))
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response, True


def _final_status(row: db.ConsiliumRound, answers: list[db.ConsiliumAnswer]) -> RoundStatus:
    """Статус раунда — по последней попытке каждой ожидаемой роли."""
    expected = [str(role) for role in row.limits.get("roles", [])] or (
        ["summary"] if row.kind == "summary" else []
    )
    latest: dict[str, str] = {}
    for answer in answers:
        latest[str(answer.role)] = str(answer.status)
    ok = sum(1 for role in expected if latest.get(role) == "ok")
    if expected and ok == len(expected):
        return "done"
    if ok > 0:
        return "partial"
    return "failed"


async def save_outcomes(
    round_id: str, outcomes: list[AnswerOutcome], warnings: list[str],
) -> ConsiliumRoundOut:
    """Обязательная запись результатов: append-only строки и статус раунда."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumRound, round_id)
        if row is None:
            raise store.ConsiliumError(404, "Раунд не найден")
        now = datetime.utcnow()
        for outcome in outcomes:
            session.add(db.ConsiliumAnswer(
                id=str(uuid.uuid4()), case_id=str(row.case_id), round_id=round_id,
                role=outcome.role, status=outcome.status, text=outcome.text,
                error=outcome.error, model=outcome.model,
                instruction_version=outcome.instruction_version,
                latency_ms=outcome.latency_ms, created_at=now,
            ))
        await session.flush()
        answers = (await session.scalars(select(db.ConsiliumAnswer).where(
            db.ConsiliumAnswer.round_id == round_id,
        ).order_by(db.ConsiliumAnswer.created_at, db.ConsiliumAnswer.id))).all()
        _set(
            row,
            status=_final_status(row, list(answers)),
            finished_at=now,
            error=None,
            warnings=list(dict.fromkeys([*row.warnings, *warnings])),
        )
        await session.commit()
        return _round_out(row, list(answers))


async def mark_aborted(
    round_id: str, status: Literal["cancelled", "failed", "interrupted"], error: str,
) -> None:
    """Прерванный/отменённый раунд фиксируется в строке, не в файле задачи."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumRound, round_id)
        if row is None:
            return
        _set(row, status=status, error=error, finished_at=datetime.utcnow())
        await session.commit()


async def mark_interrupted() -> int:
    """Старт приложения: живых задач нет, «running» — прервано рестартом (§8)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        rows = (await session.scalars(select(db.ConsiliumRound).where(
            db.ConsiliumRound.status == "running",
        ))).all()
        for row in rows:
            _set(
                row,
                status="interrupted",
                error="Прервано перезапуском сервера — повторите ответы советников",
                finished_at=datetime.utcnow(),
            )
        await session.commit()
        return len(rows)


async def attach_job(round_id: str, job_id: str) -> None:
    """Связь раунда с задачей очереди (файл задачи не хранит тексты)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumRound, round_id)
        if row is not None:
            _set(row, job_id=job_id)
            await session.commit()


async def get_round(case_id: str, round_id: str) -> ConsiliumRoundOut:
    """Раунд с полной append-only историей ответов."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await _require_round(session, case_id, round_id)
        answers = (await session.scalars(select(db.ConsiliumAnswer).where(
            db.ConsiliumAnswer.round_id == round_id,
        ).order_by(db.ConsiliumAnswer.created_at, db.ConsiliumAnswer.id))).all()
        return _round_out(row, list(answers))


async def list_rounds(case_id: str, limit: int, offset: int) -> ConsiliumRoundsPage:
    """Раунды дела в хронологическом порядке с честным total."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        condition: ColumnElement[bool] = db.ConsiliumRound.case_id == case_id
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumRound,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumRound).where(condition).order_by(
            db.ConsiliumRound.created_at, db.ConsiliumRound.id,
        ).limit(limit).offset(offset))).all()
        grouped = await _answers_of(session, [str(row.id) for row in rows])
        return ConsiliumRoundsPage(total=total, items=[
            _round_out(row, grouped.get(str(row.id), [])) for row in rows
        ])
        raise store.ConsiliumError(404, "Снимок досье не найден в этом исследовании")