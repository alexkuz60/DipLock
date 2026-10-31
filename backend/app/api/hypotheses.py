"""Роутер правил-гипотез (срез 4 слоя «признаки»): «N из M» по выборке проб.

Форма и контракт здесь, работа — ниже (`services/probe_context.py` — признаки
пробы из последнего прогона автоотчёта, `services/hypothesis_check.py` —
правило, N/M и контрпримеры, `services/hypothesis_library.py` — библиотека
сохранённых правил). Ошибки правила/выборки — 400 с текстом
(`HypothesisError`); `PrivateRoute` — без эха ввода в 422 и без HTTP-кэша.
"""
from fastapi import APIRouter, HTTPException

from app.api.private import PrivateRoute
from app.core.config import settings
from app.schemas.hypotheses import (
    HypothesisCheckIn,
    HypothesisCheckOut,
    HypothesisOut,
    HypothesisSaveIn,
    ProbeContextIn,
    ProbeContextOut,
    ProbeRecordOut,
    RuleDraftIn,
)
from app.services import hypothesis_library
from app.services.hypothesis_check import (
    HypothesisError,
    check_hypothesis,
    draft_rule_from_profile,
    validate_selection,
)
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


@router.post(
    "/draft-rule", response_model=HypothesisSaveIn,
    summary="Шаблон «профиль → правило»: черновик условий без вердикта (Т5)",
)
async def post_rule_draft(payload: RuleDraftIn) -> HypothesisSaveIn:
    """Кандидаты условий из измеренного профиля пробы.

    Пороги — округлённые наблюдения (не эталон методики); ``min_share`` остаётся
    ``None`` — статус проверки будет ``descriptive``, авто-подтверждения нет.
    """
    try:
        return draft_rule_from_profile(
            payload.features,
            band_key=payload.band_key,
            recording_ids=payload.recording_ids,
            label=payload.label,
        )
    except HypothesisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "", response_model=HypothesisOut, status_code=201,
    summary="Сохранить правило-гипотезу в библиотеку (Т4)",
)
async def post_hypothesis(payload: HypothesisSaveIn) -> HypothesisOut:
    """Библиотека правил: правило + выборка, без запуска проверки.

    Append (история, не UPSERT): повторное сохранение — новая строка.
    """
    try:
        row = await hypothesis_library.save_hypothesis(payload)
    except HypothesisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return HypothesisOut(**row)


@router.get(
    "", response_model=list[HypothesisOut],
    summary="Библиотека гипотез: список сохранённых правил",
)
async def get_hypotheses() -> list[HypothesisOut]:
    """Новые сверху; только правило и выборка — без интерпретации."""
    rows = await hypothesis_library.list_hypotheses()
    return [HypothesisOut(**row) for row in rows]


@router.get(
    "/{hypothesis_id}", response_model=HypothesisOut,
    summary="Сохранённое правило-гипотеза",
)
async def get_hypothesis(hypothesis_id: int) -> HypothesisOut:
    row = await hypothesis_library.get_hypothesis(hypothesis_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Гипотеза {hypothesis_id} не найдена")
    return HypothesisOut(**row)


@router.delete(
    "/{hypothesis_id}", status_code=204,
    summary="Удалить правило-гипотезу из библиотеки",
)
async def delete_hypothesis(hypothesis_id: int) -> None:
    if not await hypothesis_library.drop_hypothesis(hypothesis_id):
        raise HTTPException(status_code=404, detail=f"Гипотеза {hypothesis_id} не найдена")


@router.post(
    "/{hypothesis_id}/recheck", response_model=HypothesisCheckOut,
    summary="Повторная проверка сохранённого правила (N из M)",
)
async def post_hypothesis_recheck(hypothesis_id: int) -> HypothesisCheckOut:
    """Пересчёт правила по текущим прогонам автоотчёта (история, не UPSERT).

    Правило и выборка — из строки библиотеки; ответ — тот же контракт,
    что у ``POST /hypotheses/check``.
    """
    try:
        result = await hypothesis_library.recheck_hypothesis(hypothesis_id)
    except HypothesisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail=f"Гипотеза {hypothesis_id} не найдена")
    return HypothesisCheckOut(**result)