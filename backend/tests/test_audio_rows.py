"""Юнит-тесты рядов «Монтажа» (``audio_render/rows.py``): веса, ошибки, пропуски.

Контракт: формулы владельца (07.10.2026) по 4 поперечным рядам 10-20,
нормировка на среднее сумм L/R, пустой ряд — пропуск с предупреждением,
канал вне схемы — ошибка, покрытие ``settings.standard_channels`` — страж.
"""
import numpy as np
import pytest

from app.core.config import settings
from app.services.audio_render.rows import (
    RENDER_VARIANTS,
    ROW_DEFS,
    ROW_IDS,
    row_mixes,
)

# Полный стандартный набор — как в conftest для EDF (все 20 каналов).
FULL = list(settings.standard_channels)


def test_variants_tuple() -> None:
    """Варианты рендера — контракт API (validate в routes)."""
    assert RENDER_VARIANTS == ("express", "montage")


def test_rows_cover_standard_channels_without_gaps() -> None:
    """Страж: 4 ряда покрывают ровно стандарт 10-20 без дублей и пропусков."""
    row_channels = [name for row in ROW_DEFS for name in row.weights]
    assert sorted(row_channels) == sorted(FULL)
    assert len(row_channels) == len(set(row_channels)) == len(FULL)
    assert ROW_IDS == ("frontal", "temporal", "parietal", "occipital")


def test_raw_weights_match_owner_formulas() -> None:
    """Сырые коэффициенты — дословно формулы владельца (все 4 ряда)."""
    by_id = {row.id: row.weights for row in ROW_DEFS}
    assert by_id["frontal"] == {
        "Fp1": (1.0, 0.0), "Fp2": (0.0, 1.0),
        "F7": (1.0, 0.0), "F8": (0.0, 1.0),
        "F3": (0.75, 0.25), "F4": (0.25, 0.75),
        "Fz": (0.5, 0.5),
    }
    assert by_id["temporal"] == {
        "T7": (1.0, 0.0), "T8": (0.0, 1.0),
        "C3": (0.75, 0.25), "C4": (0.25, 0.75),
        "Cz": (0.5, 0.5),
    }
    assert by_id["parietal"] == {
        "P7": (1.0, 0.0), "P8": (0.0, 1.0),
        "P3": (0.75, 0.25), "P4": (0.25, 0.75),
        "Pz": (0.5, 0.5),
    }
    assert by_id["occipital"] == {
        "O1": (1.0, 0.0), "O2": (0.0, 1.0),
        "Oz": (0.5, 0.5),
    }
    # Симметрия L/R внутри каждого ряда: суммы сырых весов совпадают.
    for row in ROW_DEFS:
        left = sum(pair[0] for pair in row.weights.values())
        right = sum(pair[1] for pair in row.weights.values())
        assert left == pytest.approx(right), row.id


def test_full_montage_gives_all_rows_and_normalized_sums() -> None:
    """Полный состав: 4 ряда, среднее сумм L/R каждого ряда = 1 (нормировка)."""
    mixes, warnings = row_mixes(FULL)
    assert warnings == []
    assert [mix.id for mix in mixes] == list(ROW_IDS)
    for mix in mixes:
        mean_sum = (mix.w_left.sum() + mix.w_right.sum()) / 2.0
        assert mean_sum == pytest.approx(1.0)
        assert (mix.w_left >= 0).all() and (mix.w_right >= 0).all()


def test_temporal_weights_match_owner_formula_exactly() -> None:
    """Височный ряд: L = T7 + 0.75·C3 + 0.25·C4 + 0.5·Cz (и зеркало R)."""
    mixes, _ = row_mixes(["T7", "T8", "C3", "C4", "Cz"])
    temporal = next(mix for mix in mixes if mix.id == "temporal")
    index = {name: i for i, name in enumerate(temporal.channels)}
    scale = 2.5  # (1 + 0.75 + 0.25 + 0.5) — сумма одной стороны при полном составе
    assert temporal.w_left[index["T7"]] == pytest.approx(1.0 / scale)
    assert temporal.w_left[index["C3"]] == pytest.approx(0.75 / scale)
    assert temporal.w_left[index["C4"]] == pytest.approx(0.25 / scale)
    assert temporal.w_left[index["Cz"]] == pytest.approx(0.5 / scale)
    assert temporal.w_right[index["T7"]] == pytest.approx(0.0)
    assert temporal.w_right[index["T8"]] == pytest.approx(1.0 / scale)
    assert temporal.w_right[index["C3"]] == pytest.approx(0.25 / scale)
    assert temporal.w_right[index["Cz"]] == pytest.approx(0.5 / scale)


def test_parietal_weights_match_owner_formula() -> None:
    """Теменной ряд: тот же алгоритм (L = P7 + 0.75·P3 + 0.25·P4 + 0.5·Pz)."""
    mixes, _ = row_mixes(["P7", "P8", "P3", "P4", "Pz"])
    parietal = next(mix for mix in mixes if mix.id == "parietal")
    index = {name: i for i, name in enumerate(parietal.channels)}
    scale = 2.5
    assert parietal.w_left[index["P7"]] == pytest.approx(1.0 / scale)
    assert parietal.w_left[index["P3"]] == pytest.approx(0.75 / scale)
    assert parietal.w_right[index["P4"]] == pytest.approx(0.75 / scale)


def test_occipital_weights_match_owner_formula() -> None:
    """Затылочный ряд: L = O1 + 0.5·Oz (без перекрёстного «просачивания»)."""
    mixes, _ = row_mixes(["O1", "O2", "Oz"])
    occipital = next(mix for mix in mixes if mix.id == "occipital")
    index = {name: i for i, name in enumerate(occipital.channels)}
    scale = 1.5  # 1 + 0.5
    assert occipital.w_left[index["O1"]] == pytest.approx(1.0 / scale)
    assert occipital.w_left[index["Oz"]] == pytest.approx(0.5 / scale)
    assert occipital.w_right[index["O1"]] == pytest.approx(0.0)
    assert occipital.w_right[index["Oz"]] == pytest.approx(0.5 / scale)


def test_empty_rows_are_skipped_with_warning() -> None:
    """Ряд без каналов записи пропускается с предупреждением (не ошибка)."""
    mixes, warnings = row_mixes(["Fp1", "Fp2", "T7"])
    assert [mix.id for mix in mixes] == ["frontal", "temporal"]
    joined = "\n".join(warnings)
    assert "Теменной" in joined and "пропущен" in joined
    assert "Затылочный" in joined


def test_channel_outside_1020_is_an_error() -> None:
    """Канал вне схемы 10-20 — ValueError, как в bus_weights (не молчим)."""
    with pytest.raises(ValueError, match="вне схемы"):
        row_mixes(["F3", "F4", "EKG1"])


def test_no_rows_in_recording_is_an_error() -> None:
    """Ни одного ряда — ValueError с подсказкой (вариант неприменим)."""
    with pytest.raises(ValueError, match="не применим"):
        row_mixes([])


def test_off_row_standard_channel_warns_and_is_unused() -> None:
    """10-20 канал вне рядов (расширение 10-10) — предупреждение, не ошибка."""
    mixes, warnings = row_mixes(["F3", "F4", "AF3"])
    assert len(mixes) >= 1
    assert any("вне четырёх рядов" in item and "AF3" in item for item in warnings)


def test_partial_row_keeps_l_r_balance() -> None:
    """Частичный состав ряда (только левые) — веса не вырождаются, L/R живы."""
    mixes, _ = row_mixes(["F7", "F3", "Fz"])
    frontal = next(mix for mix in mixes if mix.id == "frontal")
    assert frontal.w_left.any()
    # R получает только перекрёстные доли F3/Fz — тоже ненулевая шина.
    assert frontal.w_right.any()
    mean_sum = (frontal.w_left.sum() + frontal.w_right.sum()) / 2.0
    assert mean_sum == pytest.approx(1.0)


def test_members_reports_weights_per_channel() -> None:
    """members() — пары [L, R] по каналам ряда (sidecar-«партитура»)."""
    mixes, _ = row_mixes(["O1", "O2", "Oz"])
    occipital = next(mix for mix in mixes if mix.id == "occipital")
    members = occipital.members()
    assert set(members) == {"O1", "O2", "Oz"}
    assert members["O1"][0] > members["O1"][1]  # левый — в L
    assert members["Oz"][0] == pytest.approx(members["Oz"][1])  # срединный — поровну


def test_weights_apply_as_linear_combination() -> None:
    """Формула ряда выполняется как w @ eeg (суммы владельца — точно)."""
    mixes, _ = row_mixes(["T7", "T8", "C3", "C4", "Cz"])
    temporal = next(mix for mix in mixes if mix.id == "temporal")
    rng = np.random.default_rng(7)
    eeg = rng.standard_normal((len(temporal.channels), 500))
    left = temporal.w_left @ eeg
    scale = 2.5
    expected = (
        eeg[0] + 0.75 * eeg[2] + 0.25 * eeg[3] + 0.5 * eeg[4]
    ) / scale
    assert left == pytest.approx(expected)

