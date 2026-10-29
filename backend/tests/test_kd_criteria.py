"""КД (С0): по-полосный порог GOF, экспертная интерполяция, вердикты (29.10.2026).

Срез 1 слоя «признаки + правила»: порог GOF — свой у полосы (форма прогона →
методика → экспертная интерполяция δ→γ), доля момента X % — глобальная (пока
методика не дала значение, вердикт честно «не оценено»). Формы и манифест v3
проверяются вместе с ядром, чтобы цепочка «UI → форма → вердикт → паспорт»
не разъехалась молча.
"""
import pytest
from fastapi import HTTPException

from app.api.params import parse_kd_gof_min_by_band, parse_kd_moment_share
from app.core.config import settings
from app.services.dipole_batch import BandSpec, DipoleBatchParams
from app.services.kd_criteria import (
    default_gof_min,
    effective_gof_map,
    kd_basis_for,
    kd_meta,
    resolve_gof_min,
)

_POINTS = [
    {"amplitude_nam": 100.0, "gof": 0.9},
    {"amplitude_nam": 30.0, "gof": 0.95},
    {"amplitude_nam": 60.0, "gof": 0.5},
]


# ---------- дефолт-интерполяция ----------

def test_default_gof_min_hits_expert_anchors():
    """Якоря — центры δ и γ: середины экспертных диапазонов 85–95 % и 75–80 %."""
    assert default_gof_min(0.5, 2.0, settings) == pytest.approx(0.90)  # δ
    assert default_gof_min(32.0, 64.0, settings) == pytest.approx(0.775)  # γ


def test_default_gof_min_is_monotonic_and_clamped():
    """Чем выше полоса — мягче порог; вне якорей — зажим к границам диапазонов."""
    ladder = [(0.5, 2), (4, 8), (8, 16), (16, 32), (32, 64), (64, 128)]
    values = [default_gof_min(lo, hi, settings) for lo, hi in ladder]
    assert values == sorted(values, reverse=True)
    assert default_gof_min(64.0, 128.0, settings) >= 0.75  # KD_GOF_DEFAULT_MIN
    assert default_gof_min(0.05, 0.1, settings) <= 0.95  # KD_GOF_DEFAULT_MAX


def test_default_gof_min_without_anchors_is_honest_none(monkeypatch):
    """Нет якорей δ/γ — порог честно не задан, а не выдуман."""
    monkeypatch.setattr(settings, "freq_bands", {"alpha": (8.0, 16.0)})
    assert default_gof_min(8.0, 16.0, settings) is None


# ---------- резолюция порога ----------

def test_resolve_gof_min_precedence(monkeypatch):
    """Явный порог → карта формы → карта методики → скаляр → интерполяция."""
    monkeypatch.setattr(settings, "kd_gof_min", 0.7)
    monkeypatch.setattr(settings, "kd_gof_min_by_band", {"alpha": 0.8})
    assert resolve_gof_min(
        settings, band_key="alpha", band_hz=(8, 13), gof_min=0.5,
    ) == 0.5
    assert resolve_gof_min(
        settings, band_key="alpha", band_hz=(8, 13),
        gof_min_by_band={"alpha": 0.6},
    ) == 0.6
    assert resolve_gof_min(settings, band_key="alpha", band_hz=(8, 13)) == 0.8
    assert resolve_gof_min(settings, band_key="beta", band_hz=(16, 32)) == 0.7
    monkeypatch.setattr(settings, "kd_gof_min", None)
    monkeypatch.setattr(settings, "kd_gof_min_by_band", {})
    assert resolve_gof_min(
        settings, band_key="beta", band_hz=(16, 32),
    ) == pytest.approx(default_gof_min(16.0, 32.0, settings))


# ---------- вердикты ----------

def test_kd_basis_records_effective_band_threshold(monkeypatch):
    """Порог GOF полосы фактически применяется, но без X % вердикт — NULL."""
    monkeypatch.setattr(settings, "kd_moment_share", None)
    monkeypatch.setattr(settings, "kd_gof_min", None)
    monkeypatch.setattr(settings, "kd_gof_min_by_band", {})
    basis, verdicts, n_passed = kd_basis_for(
        _POINTS, settings, band_key="alpha", band_hz=(8.0, 13.0),
    )
    assert basis["gof_min"] == pytest.approx(default_gof_min(8.0, 13.0, settings))
    assert basis["moment_share_x"] is None
    assert verdicts == [None, None, None]
    assert n_passed is None


def test_kd_verdicts_use_band_threshold_from_run_map(monkeypatch):
    """Вердикт: момент ≥ X % максимума полосы И GOF ≥ порога своей полосы."""
    monkeypatch.setattr(settings, "kd_moment_share", None)
    monkeypatch.setattr(settings, "kd_gof_min", None)
    monkeypatch.setattr(settings, "kd_gof_min_by_band", {})
    basis, verdicts, n_passed = kd_basis_for(
        _POINTS, settings,
        band_key="alpha", band_hz=(8.0, 13.0),
        gof_min_by_band={"alpha": 0.7}, moment_share=0.5,
    )
    assert basis["gof_min"] == 0.7
    assert basis["moment_share_x"] == 0.5
    # (100, 0.9) — оба условия → 1; (30, …) момент < 50 → 0; (60, 0.5) GOF < 0.7 → 0
    assert verdicts == [1, 0, 0]
    assert n_passed == 1


def test_expert_default_moment_share_activates_verdicts():
    """Живой дефолт методики: X = 5 % (эксперт, 29.10.2026) — вердикты считаются.

    Без явного снятия порогов КД активен: момент ≥ 5 % от максимума полосы И
    GOF ≥ порога полосы; ``moment_share_x`` в базисе — именно применённое 0.05.
    """
    assert settings.kd_moment_share == pytest.approx(0.05)
    basis, verdicts, n_passed = kd_basis_for(
        _POINTS, settings, band_key="alpha", band_hz=(8.0, 13.0),
    )
    assert basis["moment_share_x"] == pytest.approx(0.05)
    # Порог момента 5%·100 = 5 нАм: проходят (100, 0.9) и (30, 0.95);
    # (60, 0.5) — GOF ниже порога полосы (≈0.82) → 0
    assert verdicts == [1, 1, 0]
    assert n_passed == 2


def test_kd_meta_extracts_thresholds_from_params():
    """Поля КД параметров → meta задачи (паспорт манифеста v3)."""
    bands = [BandSpec(band_key="alpha", lo_hz=8.0, hi_hz=13.0, label="alpha")]
    params = DipoleBatchParams(
        bands=bands, kd_gof_min_by_band={"alpha": 0.8}, kd_moment_share=0.5,
    )
    assert kd_meta(params) == {
        "kd_moment_share": 0.5,
        "kd_gof_min_by_band": {"alpha": 0.8},
    }
    assert kd_meta(DipoleBatchParams(bands=bands)) == {}
    assert kd_meta(object()) == {}  # параметры без полей КД (спектр, стадии)


# ---------- карта каталога ----------

def test_effective_gof_map_covers_catalog_and_overrides(monkeypatch):
    monkeypatch.setattr(settings, "kd_gof_min", None)
    monkeypatch.setattr(settings, "kd_gof_min_by_band", {})
    full = effective_gof_map(settings)
    assert set(full) >= {"delta", "gamma", "alpha", "mu"}  # октавные + функциональные
    overridden = effective_gof_map(settings, {"alpha": 0.5, "custom:2.5-4": 0.6})
    assert overridden["alpha"] == 0.5  # форма перекрывает дефолт
    assert overridden["custom:2.5-4"] == 0.6  # «своя» полоса вне каталога
    assert overridden["delta"] == full["delta"]


# ---------- формы ----------

def test_parse_kd_gof_min_by_band_accepts_json_map():
    assert parse_kd_gof_min_by_band('{"delta": 0.9, "gamma": 0.775}') == {
        "delta": 0.9, "gamma": 0.775,
    }
    assert parse_kd_gof_min_by_band(None) is None
    assert parse_kd_gof_min_by_band("") is None


@pytest.mark.parametrize("raw,text", [
    ("{bad json", "JSON"),
    ("[1, 2]", "JSON-объект"),
    ('{"alpha": "x"}', "не число"),
    ('{"alpha": 1.5}', "вне"),
    ('{"alpha": 0}', "вне"),
])
def test_parse_kd_gof_min_by_band_rejects_garbage(raw, text):
    with pytest.raises(HTTPException) as exc:
        parse_kd_gof_min_by_band(raw)
    assert text in exc.value.detail


def test_parse_kd_moment_share_range():
    assert parse_kd_moment_share(None) is None
    assert parse_kd_moment_share(0.5) == 0.5
    with pytest.raises(HTTPException):
        parse_kd_moment_share(1.5)
    with pytest.raises(HTTPException):
        parse_kd_moment_share(0.0)