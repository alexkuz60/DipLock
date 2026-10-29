"""Правила-гипотезы «N из M» (срез 4 слоя «признаки»).

Гипотеза — проверяемое суждение в формате концепции («научный критерий =
данные + правило», `concept.md` §2): правило = полоса + условия над признаками
пробы (``probe_context.PROBE_FEATURES``) + порог подтверждения. Проверка
отвечает на вопрос «признак выполнен в N записях из M» и приносит
контрпримеры — интерпретацию признаков даёт исследователь.

Семантика (честность важнее красивого ответа):

* **трёхзначная логика И** по условиям: невыполненное условие даёт
  ``passed=False`` даже при неизмеренных соседях (провал определён); без
  провалов, но с неизмеренными признаками — ``passed=None`` («не оценено»);
* N — записей с ``passed=True``; M — оценённых (``passed is not None``);
  ``share = N / M``; M = 0 — «недостаточно данных», доля ``None``;
* статус: ``min_share`` задан → ``confirmed``/``rejected`` по порогу доли;
  не задан → ``descriptive`` (описать N из M без вердикта);
* правило — **одной полосы** (принцип 3 ``docs/rules/dipoles.md``: между
  полосами ничего не сравниваем); выборка — явные ``recording_ids``
  (пустая выборка и неизвестная полоса — 400, как у группового агрегата).

«Не навреди» (сверх-принцип слоя, `docs/rules/hypotheses.md`): гипотеза —
суждение, а не диагноз и не «оценка одарённости»; ответ — N из M и
контрпримеры, без интерпретации признаков. Эмо-анализ, нейромузыка и
ИИ-консультанты слоем признаков не обслуживаются.
"""
import math
from typing import Any

from app.core.config import settings
from app.schemas.hypotheses import HypothesisCheckIn, HypothesisConditionIn
from app.services.probe_context import PROBE_FEATURES, probe_contexts
from app.services.report import report_band_catalog

# Операторы условий правила (порядковые + равенство с допуском 1e-9).
OPERATORS: tuple[str, ...] = (">=", "<=", ">", "<", "==", "!=")


class HypothesisError(ValueError):
    """Ошибка правила-гипотезы/выборки — понятный текст для ответа 400."""


def validate_selection(band_key: str, recording_ids: list[str]) -> None:
    """Полоса известна каталогу, выборка непуста — иначе ``HypothesisError``."""
    if not recording_ids:
        raise HypothesisError("Выборка пуста: укажите записи-участники (recording_ids)")
    catalog = report_band_catalog(settings)
    if band_key not in catalog:
        raise HypothesisError(
            f"Неизвестная полоса «{band_key}»: правило проверяется по одной полосе "
            f"каталога ({', '.join(catalog)})"
        )


def validate_rule(conditions: list[HypothesisConditionIn]) -> None:
    """Условия непусты; признаки и операторы известны — иначе ``HypothesisError``."""
    if not conditions:
        raise HypothesisError("Правило пусто: нужно хотя бы одно условие (признак оператор значение)")
    for condition in conditions:
        if condition.feature not in PROBE_FEATURES:
            raise HypothesisError(
                f"Неизвестный признак «{condition.feature}»: доступны — "
                f"{', '.join(PROBE_FEATURES)}"
            )
        if condition.op not in OPERATORS:
            raise HypothesisError(
                f"Неизвестный оператор «{condition.op}»: доступны — {', '.join(OPERATORS)}"
            )


def _compare(op: str, left: float, right: float) -> bool:
    """Сверка признака с порогом; ``==``/``!=`` — с допуском 1e-9."""
    if op == ">=":
        return left >= right
    if op == "<=":
        return left <= right
    if op == ">":
        return left > right
    if op == "<":
        return left < right
    close = math.isclose(left, right, rel_tol=1e-9)
    return close if op == "==" else not close


def condition_label(condition: HypothesisConditionIn) -> str:
    """Подпись условия для ответа («rotation_ccw_share >= 0.8»)."""
    return f"{condition.feature} {condition.op} {condition.value:g}"


def evaluate_rule(
    conditions: list[HypothesisConditionIn],
    features: dict[str, float | int | None],
) -> tuple[bool | None, list[str], list[str]]:
    """Трёхзначная И-логика правил по одной пробе.

    Возвращает ``(passed, failed, unmeasured)``: ``failed``/``unmeasured`` —
    подписи условий; ``passed`` = ``False`` при любом провале, ``None`` — без
    провалов, но с неизмеренными признаками, иначе ``True``.
    """
    failed: list[str] = []
    unmeasured: list[str] = []
    for condition in conditions:
        value = features.get(condition.feature)
        if value is None:
            unmeasured.append(condition_label(condition))
        elif not _compare(condition.op, float(value), condition.value):
            failed.append(condition_label(condition))
    if failed:
        return False, failed, unmeasured
    if unmeasured:
        return None, [], unmeasured
    return True, [], []


def _status(n: int, m: int, min_share: float | None) -> str:
    """Статус проверки: порог задан — вердикт, иначе — честное описание."""
    if m == 0:
        return "insufficient"
    if min_share is None:
        return "descriptive"
    return "confirmed" if n / m >= min_share else "rejected"


async def check_hypothesis(payload: HypothesisCheckIn) -> dict[str, Any]:
    """Проверка правила по выборке проб: N из M + контрпримеры.

    Источник признаков — ``probe_contexts`` (последний прогон автоотчёта
    каждой записи); ошибки правила/выборки — ``HypothesisError`` (роут
    превращает их в 400 с текстом).
    """
    validate_selection(payload.band_key, payload.recording_ids)
    validate_rule(payload.conditions)
    rows, warnings = await probe_contexts(payload.recording_ids, payload.band_key)

    records: list[dict[str, Any]] = []
    n = m = 0
    for row in rows:
        passed, failed, unmeasured = evaluate_rule(payload.conditions, row["features"])
        if passed is not None:
            m += 1
            if passed:
                n += 1
        else:
            warnings.append(
                f"Запись {row['recording_id']}: правило не оценено "
                f"(не измерено: {', '.join(unmeasured)})"
            )
        records.append({
            "recording_id": row["recording_id"],
            "filename": row["filename"],
            "passed": passed,
            "failed_conditions": failed,
            "unmeasured_features": unmeasured,
            "features": row["features"],
        })

    return {
        "label": payload.label,
        "band_key": payload.band_key,
        "band_hz": list(report_band_catalog(settings)[payload.band_key]),
        "conditions": [
            {
                "feature": condition.feature,
                "op": condition.op,
                "value": condition.value,
            }
            for condition in payload.conditions
        ],
        "min_share": payload.min_share,
        "n": n,
        "m": m,
        "share": (n / m) if m else None,
        "status": _status(n, m, payload.min_share),
        "records": records,
        "warnings": warnings,
    }