"""Библиотека исследования (Т5, срез 0013): предложения, решения, исполнения.

Карточка предложения (§7 ``docs/rules/consilium.md``) — четыре вида шага, у
каждого основание и способ проверки. Жизненный цикл:

* предложение создаётся вручную или вносится из идеи мозгового штурма/ответа
  советника (источник фиксируется, чужие карточки не переписываются);
* решение человека («принято»/«отклонено») — append-only строка с адресом
  версии карточки: правка карточки делает старое решение прошлым (§7);
* ручное исполнение и его результат — отдельными append-only строками:
  рекомендацию можно воспроизвести и оценить (критерий Т5).

Запусков расчётов здесь нет: исполнение — вручную в существующих разделах,
автоматика — только в Т6 с одобрением точной версии предложения.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.sql.elements import ColumnElement

from app.models import db
from app.schemas.consilium import (
    ConsiliumDecisionCreate,
    ConsiliumDecisionOut,
    ConsiliumExecutionCreate,
    ConsiliumExecutionOut,
    ConsiliumProposalCreate,
    ConsiliumProposalOut,
    ConsiliumProposalsPage,
    ConsiliumProposalUpdate,
)
from app.services.consilium import store


def _set(row: Any, **fields: Any) -> None:
    """Мутация ORM-строки: setattr с переменными — mypy и ruff без замечаний."""
    for name, value in fields.items():
        setattr(row, name, value)


def _decision_out(row: db.ConsiliumDecision) -> ConsiliumDecisionOut:
    """Контракт решения человека (append-only)."""
    return ConsiliumDecisionOut.model_validate({
        "id": row.id, "proposal_id": row.proposal_id, "decision": row.decision,
        "proposal_version": row.proposal_version, "comment": row.comment,
        "created_at": row.created_at,
    })


def _execution_out(row: db.ConsiliumExecution) -> ConsiliumExecutionOut:
    """Контракт ручного исполнения (append-only)."""
    return ConsiliumExecutionOut.model_validate({
        "id": row.id, "proposal_id": row.proposal_id, "note": row.note,
        "result": row.result, "created_at": row.created_at,
    })


def _proposal_out(
    row: db.ConsiliumProposal,
    decisions: list[db.ConsiliumDecision],
    executions: list[db.ConsiliumExecution],
) -> ConsiliumProposalOut:
    """Контракт предложения; история решений/исполнений — новые сверху."""
    return ConsiliumProposalOut.model_validate({
        "id": row.id, "case_id": row.case_id, "source": row.source,
        "source_id": row.source_id, "version": row.version, "kind": row.kind,
        "title": row.title, "hypothesis": row.hypothesis, "rationale": row.rationale,
        "risks": row.risks, "check_method": row.check_method,
        "decisions": [
            _decision_out(item) for item in
            sorted(decisions, key=lambda d: (d.created_at, str(d.id)), reverse=True)
        ],
        "executions": [
            _execution_out(item) for item in
            sorted(executions, key=lambda e: (e.created_at, str(e.id)), reverse=True)
        ],
        "created_at": row.created_at, "updated_at": row.updated_at,
    })


async def _require_proposal(
    session: Any, case_id: str, proposal_id: str,
) -> db.ConsiliumProposal:
    """Чужое/удалённое предложение — 404, не пустая библиотека."""
    row = await session.get(db.ConsiliumProposal, proposal_id)
    if row is None or row.case_id != case_id:
        raise store.ConsiliumError(404, "Предложение не найдено в этом исследовании")
    return row


async def _history_of(
    session: Any, proposal_ids: list[str],
) -> tuple[dict[str, list[db.ConsiliumDecision]], dict[str, list[db.ConsiliumExecution]]]:
    """Решения и исполнения предложений (append-only)."""
    if not proposal_ids:
        return {}, {}
    decisions = (await session.scalars(select(db.ConsiliumDecision).where(
        db.ConsiliumDecision.proposal_id.in_(proposal_ids),
    ))).all()
    executions = (await session.scalars(select(db.ConsiliumExecution).where(
        db.ConsiliumExecution.proposal_id.in_(proposal_ids),
    ))).all()
    by_decision: dict[str, list[db.ConsiliumDecision]] = {}
    for row in decisions:
        by_decision.setdefault(str(row.proposal_id), []).append(row)
    by_execution: dict[str, list[db.ConsiliumExecution]] = {}
    for row in executions:
        by_execution.setdefault(str(row.proposal_id), []).append(row)
    return by_decision, by_execution


async def create(case_id: str, payload: ConsiliumProposalCreate) -> ConsiliumProposalOut:
    """Новое предложение (вручную или из идеи); повтор ключа не дублирует карточку."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:proposal"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumProposalOut.model_validate(repeat.response)
        await store._bump(session, case, payload.expected_version)
        now = datetime.utcnow()
        row = db.ConsiliumProposal(
            id=str(uuid.uuid4()), case_id=case_id, source=payload.source,
            source_id=payload.source_id, version=1, kind=payload.kind, title=payload.title,
            hypothesis=payload.hypothesis, rationale=payload.rationale, risks=payload.risks,
            check_method=payload.check_method, created_at=now, updated_at=now,
        )
        session.add(row)
        await session.flush()
        response = _proposal_out(row, [], [])
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


async def update(
    case_id: str, proposal_id: str, payload: ConsiliumProposalUpdate,
) -> ConsiliumProposalOut:
    """Правка карточки: новая версия, решения прежних версий остаются в истории."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:proposal_update:{proposal_id}"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumProposalOut.model_validate(repeat.response)
        row = await _require_proposal(session, case_id, proposal_id)
        await store._bump(session, case, payload.expected_version)
        _set(
            row,
            kind=payload.kind, title=payload.title, hypothesis=payload.hypothesis,
            rationale=payload.rationale, risks=payload.risks, check_method=payload.check_method,
            version=int(row.version) + 1, updated_at=datetime.utcnow(),
        )
        await session.flush()
        decisions, executions = await _history_of(session, [str(row.id)])
        response = _proposal_out(
            row, decisions.get(str(row.id), []), executions.get(str(row.id), []),
        )
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


async def add_decision(
    case_id: str, proposal_id: str, payload: ConsiliumDecisionCreate,
) -> ConsiliumDecisionOut:
    """Решение человека (принято/отклонено): новая строка, история не правится."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:proposal_decision:{proposal_id}"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumDecisionOut.model_validate(repeat.response)
        row = await _require_proposal(session, case_id, proposal_id)
        await store._bump(session, case, payload.expected_version)
        decision = db.ConsiliumDecision(
            id=str(uuid.uuid4()), case_id=case_id, proposal_id=proposal_id,
            decision=payload.decision, proposal_version=int(row.version),
            comment=payload.comment, created_at=datetime.utcnow(),
        )
        session.add(decision)
        await session.flush()
        response = _decision_out(decision)
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


async def add_execution(
    case_id: str, proposal_id: str, payload: ConsiliumExecutionCreate,
) -> ConsiliumExecutionOut:
    """Ручное исполнение и результат: каждое — новой строкой (воспроизводимость Т5)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:proposal_execution:{proposal_id}"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumExecutionOut.model_validate(repeat.response)
        await _require_proposal(session, case_id, proposal_id)
        await store._bump(session, case, payload.expected_version)
        execution = db.ConsiliumExecution(
            id=str(uuid.uuid4()), case_id=case_id, proposal_id=proposal_id,
            note=payload.note, result=payload.result, created_at=datetime.utcnow(),
        )
        session.add(execution)
        await session.flush()
        response = _execution_out(execution)
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


async def get_proposal(case_id: str, proposal_id: str) -> ConsiliumProposalOut:
    """Точная карточка с историей решений и исполнений."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await _require_proposal(session, case_id, proposal_id)
        decisions, executions = await _history_of(session, [proposal_id])
        return _proposal_out(
            row, decisions.get(proposal_id, []), executions.get(proposal_id, []),
        )


async def list_proposals(case_id: str, limit: int, offset: int) -> ConsiliumProposalsPage:
    """Библиотека исследования: карточки по порядку создания, честный total."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        condition: ColumnElement[bool] = db.ConsiliumProposal.case_id == case_id
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumProposal,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumProposal).where(condition).order_by(
            db.ConsiliumProposal.created_at, db.ConsiliumProposal.id,
        ).limit(limit).offset(offset))).all()
        decisions, executions = await _history_of(session, [str(row.id) for row in rows])
        return ConsiliumProposalsPage(total=total, items=[
            _proposal_out(
                row, decisions.get(str(row.id), []), executions.get(str(row.id), []),
            )
            for row in rows
        ])