"""Библиотека правил-гипотез «N из M» (Т4, 31.10.2026).

Сохраняет **правило + выборку**, а не разовый ответ: проверка пересчитывается
по свежим прогонам автоотчёта (история, не UPSERT), правило накапливается
(``concept.md`` §1 «накапливаемая методика»). История правил — append:
повторное сохранение того же текста — новая строка.

Ошибки правила/выборки — ``HypothesisError`` (роут → 400). «Не навреди»:
в строке только измеримые условия и id проб, без интерпретации.
"""
from datetime import datetime
from typing import Any, cast

from sqlalchemy import delete, select
from sqlalchemy.engine import CursorResult

from app.models.db import AsyncSessionLocal, Hypothesis, init_db
from app.schemas.hypotheses import (
    HypothesisCheckIn,
    HypothesisConditionIn,
    HypothesisSaveIn,
)
from app.services.hypothesis_check import (
    check_hypothesis,
    validate_rule,
    validate_selection,
)


def _conditions_json(conditions: list[HypothesisConditionIn]) -> list[dict[str, Any]]:
    """Условия правила → JSON-список (порядок сохраняется)."""
    return [
        {"feature": c.feature, "op": c.op, "value": c.value} for c in conditions
    ]


def _payload(row: Hypothesis) -> dict[str, Any]:
    """Строка ``hypotheses`` под ``HypothesisOut``; NULL не достраивается."""
    return {
        "id": row.id,
        "label": row.label,
        "band_key": row.band_key,
        "conditions": list(row.conditions or []),
        "min_share": row.min_share,
        "recording_ids": list(row.recording_ids or []),
        "created_at": row.created_at,
    }


async def save_hypothesis(payload: HypothesisSaveIn) -> dict[str, Any]:
    """Валидирует правило и сохраняет строку библиотеки (append)."""
    validate_selection(payload.band_key, payload.recording_ids)
    validate_rule(payload.conditions)
    await init_db()
    async with AsyncSessionLocal() as session:
        row = Hypothesis(
            label=payload.label,
            band_key=payload.band_key,
            conditions=_conditions_json(payload.conditions),
            min_share=payload.min_share,
            recording_ids=list(payload.recording_ids),
            created_at=datetime.utcnow(),
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return _payload(row)


async def list_hypotheses() -> list[dict[str, Any]]:
    """Библиотека правил: новые сверху (история append)."""
    await init_db()
    async with AsyncSessionLocal() as session:
        rows = (await session.scalars(
            select(Hypothesis).order_by(Hypothesis.created_at.desc(), Hypothesis.id.desc())
        )).all()
        return [_payload(row) for row in rows]


async def get_hypothesis(hypothesis_id: int) -> dict[str, Any] | None:
    """Строка библиотеки; ``None`` — нет."""
    await init_db()
    async with AsyncSessionLocal() as session:
        row = await session.get(Hypothesis, hypothesis_id)
        return None if row is None else _payload(row)


async def drop_hypothesis(hypothesis_id: int) -> bool:
    """Удаляет правило (``True`` — строка была)."""
    await init_db()
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            delete(Hypothesis).where(Hypothesis.id == hypothesis_id)
        )
        await session.commit()
        return bool(cast(CursorResult, result).rowcount)


async def recheck_hypothesis(hypothesis_id: int) -> dict[str, Any] | None:
    """Повторная проверка сохранённого правила по текущим прогонам.

    Правило и выборка берутся из строки; ``None`` — правила нет. Ответ —
    тот же контракт, что у ``POST /hypotheses/check`` (N/M без интерпретации).
    """
    await init_db()
    async with AsyncSessionLocal() as session:
        row = await session.get(Hypothesis, hypothesis_id)
        if row is None:
            return None
        conditions = [
            HypothesisConditionIn(**cast(dict[str, Any], condition))
            for condition in cast(list[dict[str, Any]], row.conditions or [])
        ]
        payload = HypothesisCheckIn(
            label=cast(str | None, row.label),
            band_key=cast(str, row.band_key or ""),
            conditions=conditions,
            min_share=cast(float | None, row.min_share),
            recording_ids=cast(list[str], list(row.recording_ids or [])),
        )
    return await check_hypothesis(payload)
