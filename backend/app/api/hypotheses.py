"""Роутер правил-гипотез (срез 4 слоя «признаки»): «N из M» по выборке проб.

Форма и контракт здесь, работа — ниже (`services/probe_context.py` — признаки
пробы из последнего прогона автоотчёта, `services/hypothesis_check.py` —
правило, N/M и контрпримеры). Ошибки правила/выборки — 400 с текстом
(`HypothesisError`); `PrivateRoute` — без эха ввода в 422 и без HTTP-кэша.
"""
from fastapi import APIRouter, HTTPException

from app.api.private import PrivateRoute
from app.core.config import settings
from app.schemas.hypotheses import (
    HypothesisCheckIn,
    HypothesisCheckOut,
    ProbeContextIn,
    ProbeContextOut,
    ProbeRecordOut,
)
from app.services.hypothesis_check import HypothesisError, check_hypothesis, validate_selection
from app.services.probe_context import probe_contexts
from app.services.report import report_band_catalog

router = APIRouter(prefix="/hypotheses", tags=["Гипотезы"], route_class=PrivateRoute)


@router.post(
    "/probe-context", response_model=ProbeContextOut,
    summary="Контекст проб: признаки выборки в одной полосе",
)
async def post_probe_context(payload: ProbeContextIn) -> ProbeContextOut:
    """Признаки пробы каждой записи выборки (КД, вращение, поток) — до проверки
    правила. Записи без прогона автоотчёта — честные ``measured=False`` и
    предупреждения, а не нули.
    """
    try:
        validate_selection(payload.band_key, payload.recording_ids)
    except HypothesisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    rows, warnings = await probe_contexts(payload.recording_ids, payload.band_key)
    return ProbeContextOut(
        band_key=payload.band_key,
        band_hz=[float(v) for v in report_band_catalog(settings)[payload.band_key]],
        records=[ProbeRecordOut(**row) for row in rows],
        warnings=warnings,
    )


@router.post(
    "/check", response_model=HypothesisCheckOut,
    summary="Проверка правила-гипотезы: признак выполнен в N записях из M",
)
async def post_hypothesis_check(payload: HypothesisCheckIn) -> HypothesisCheckOut:
    """Проверка правила по выборке проб: N из M, статус и контрпримеры.
    Интерпретацию признаков даёт исследователь — ответ только измеряет.
    """
    try:
        result = await check_hypothesis(payload)
    except HypothesisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return HypothesisCheckOut(**result)