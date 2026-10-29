"""Правила-гипотезы «N из M» (срез 4): трёхзначная логика, статусы, шлюзы.

Проверяются: трёхзначная И-логика условий (провал определён, неизмеренное —
«не оценено»), счётчики N/M и доли, статусы ``confirmed``/``rejected``/
``descriptive``/``insufficient``, контрпримеры и шлюзы правила/выборки
(``HypothesisError`` → 400 в роутере). Источник признаков подменяется фейком —
математика правила тестируется без БД (свой тест — у `probe_context`).
"""
import asyncio

import pytest

from app.schemas.hypotheses import HypothesisCheckIn, HypothesisConditionIn
from app.services import hypothesis_check
from app.services.hypothesis_check import (
    HypothesisError,
    check_hypothesis,
    evaluate_rule,
    validate_rule,
    validate_selection,
)


def _condition(feature: str = "rotation_ccw_share", op: str = ">=", value: float = 0.8):
    return HypothesisConditionIn(feature=feature, op=op, value=value)


def _payload(conditions=None, min_share=None, recording_ids=None) -> HypothesisCheckIn:
    return HypothesisCheckIn(
        label="условная гипотеза",
        band_key="alpha",
        conditions=conditions or [_condition()],
        min_share=min_share,
        recording_ids=recording_ids if recording_ids is not None else ["rec-1"],
    )


def _row(recording_id: str, ccw: float | None) -> dict:
    return {
        "recording_id": recording_id,
        "filename": f"{recording_id}.edf",
        "report_run_id": 1,
        "report_created_at": None,
        "features": {
            "n_points": 9,
            "kd_passed_share": 0.5,
            "rotation_ccw_share": ccw,
            "rotation_cw_share": None,
            "flow_orderliness": 0.9,
            "median_gof": 0.8,
            "median_riv": 0.2,
        },
        "measured": ccw is not None,
    }


def _check(monkeypatch, rows, min_share=None, warnings=None) -> dict:
    """``check_hypothesis`` с фейковым источником признаков (без БД)."""

    async def _fake(recording_ids, band_key):
        return list(rows), list(warnings or [])

    monkeypatch.setattr(hypothesis_check, "probe_contexts", _fake)
    return asyncio.run(check_hypothesis(_payload(
        min_share=min_share,
        recording_ids=[row["recording_id"] for row in rows] or ["rec-x"],
    )))


# ---------- трёхзначная логика ----------

def test_evaluate_rule_pass_fail_and_unmeasured():
    conditions = [_condition("rotation_ccw_share", ">=", 0.8)]
    passed, failed, unmeasured = evaluate_rule(conditions, {"rotation_ccw_share": 0.9})
    assert (passed, failed, unmeasured) == (True, [], [])
    passed, failed, unmeasured = evaluate_rule(conditions, {"rotation_ccw_share": 0.7})
    assert passed is False and failed == ["rotation_ccw_share >= 0.8"]
    passed, failed, unmeasured = evaluate_rule(conditions, {"rotation_ccw_share": None})
    assert passed is None and unmeasured == ["rotation_ccw_share >= 0.8"]


def test_evaluate_rule_failure_wins_over_unmeasured():
    """Провал определён даже при неизмеренном соседе: False, а не «не оценено»."""
    conditions = [
        _condition("rotation_ccw_share", ">=", 0.8),
        _condition("flow_orderliness", ">=", 0.5),
    ]
    passed, failed, unmeasured = evaluate_rule(
        conditions, {"rotation_ccw_share": 0.7, "flow_orderliness": None},
    )
    assert passed is False
    assert failed == ["rotation_ccw_share >= 0.8"]
    assert unmeasured == ["flow_orderliness >= 0.5"]


@pytest.mark.parametrize("op,value,left,expected", [
    (">=", 0.8, 0.8, True), (">=", 0.8, 0.79, False),
    ("<=", 0.8, 0.8, True), ("<=", 0.8, 0.81, False),
    (">", 0.8, 0.81, True), (">", 0.8, 0.8, False),
    ("<", 0.8, 0.79, True), ("<", 0.8, 0.8, False),
    ("==", 0.8, 0.8, True), ("==", 0.8, 0.8000000001, True), ("==", 0.8, 0.9, False),
    ("!=", 0.8, 0.9, True), ("!=", 0.8, 0.8, False),
])
def test_condition_operators(op, value, left, expected):
    passed, _failed, _unmeasured = evaluate_rule(
        [_condition("rotation_ccw_share", op, value)],
        {"rotation_ccw_share": left},
    )
    assert passed is expected


# ---------- счётчики N из M и статусы ----------

def test_check_counts_n_of_m_with_counterexamples(monkeypatch):
    result = _check(monkeypatch, [_row("a", 0.9), _row("b", 0.7), _row("c", 0.95)])
    assert result["n"] == 2 and result["m"] == 3
    assert result["share"] == pytest.approx(2 / 3)
    assert result["status"] == "descriptive"  # min_share не задан — без вердикта
    counterexample = next(r for r in result["records"] if r["recording_id"] == "b")
    assert counterexample["passed"] is False
    assert counterexample["failed_conditions"] == ["rotation_ccw_share >= 0.8"]


def test_check_status_confirmed_and_rejected_by_min_share(monkeypatch):
    rows = [_row("a", 0.9), _row("b", 0.9), _row("c", 0.7)]
    confirmed = _check(monkeypatch, rows, min_share=0.6)
    assert confirmed["status"] == "confirmed"  # 2/3 ≥ 0.6
    rejected = _check(monkeypatch, rows, min_share=0.9)
    assert rejected["status"] == "rejected"  # 2/3 < 0.9


def test_check_unmeasured_rows_stay_out_of_m(monkeypatch):
    """«Не оценено» не попадает в знаменатель и честно предупреждается."""
    result = _check(
        monkeypatch,
        [_row("a", 0.9), _row("b", None), _row("c", 0.7)],
        warnings=["Запись b: прогонов автоотчёта нет — признаки не измерены"],
    )
    assert result["n"] == 1 and result["m"] == 2
    assert result["share"] == pytest.approx(0.5)
    unmeasured = next(r for r in result["records"] if r["recording_id"] == "b")
    assert unmeasured["passed"] is None
    assert any("не оценено" in w for w in result["warnings"])


def test_check_insufficient_when_nothing_measured(monkeypatch):
    result = _check(monkeypatch, [_row("a", None), _row("b", None)])
    assert result["n"] == 0 and result["m"] == 0
    assert result["share"] is None
    assert result["status"] == "insufficient"


# ---------- шлюзы правила и выборки ----------

def test_validate_rule_rejects_unknown_feature_and_operator():
    with pytest.raises(HypothesisError, match="Неизвестный признак"):
        validate_rule([_condition(feature="telepathy")])
    with pytest.raises(HypothesisError, match="Неизвестный оператор"):
        validate_rule([_condition(op="≈")])
    with pytest.raises(HypothesisError, match="Правило пусто"):
        validate_rule([])


def test_validate_selection_rejects_empty_and_unknown_band():
    with pytest.raises(HypothesisError, match="Выборка пуста"):
        validate_selection("alpha", [])
    with pytest.raises(HypothesisError, match="Неизвестная полоса"):
        validate_selection("omega", ["rec-1"])