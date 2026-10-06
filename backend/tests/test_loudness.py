"""Тесты психоакустики (ISO 226:2003): формула, эталонные точки, смещения полос."""
import numpy as np
import pytest

from app.core.config import settings
from app.services.audio_render.core import PITCH_STEPS
from app.services.audio_render.loudness import (
    autobase_db,
    band_loudness_offsets,
    equal_loudness_spl_db,
    pit_bands,
)


def test_1khz_equals_phon_by_definition() -> None:
    """Определение фона: на 1 кГц SPL кривой равен её уровню в фонах."""
    for phon in (60.0, 75.0, 90.0):
        assert float(equal_loudness_spl_db([1000.0], phon)[0]) == pytest.approx(phon, abs=0.05)


def test_known_point_matches_standard() -> None:
    """Эталонная точка ISO 226: 100 Гц при 60 фон = 78.6546 дБ SPL."""
    assert float(equal_loudness_spl_db([100.0], 60.0)[0]) == pytest.approx(78.65, abs=0.01)


def test_band_offsets_have_expected_signs() -> None:
    """Смещения: глухие басы «+» (поднять), «яма» 2–4 кГц beta «−» (опустить)."""
    offsets = band_loudness_offsets(settings.freq_bands, 75.0, PITCH_STEPS)
    assert set(offsets) == set(settings.freq_bands)
    # delta (64–256 Гц) — зона низкой чувствительности: поднимаем заметно.
    assert offsets["delta"] > 5.0
    # beta (2.0–4.1 кГц) — «яма» чувствительности: опускаем (середина звучит громче).
    assert offsets["beta"] < 0.0
    # theta около опорного 1 кГц — поправка минимальна.
    assert abs(offsets["theta"]) < 2.0


def test_offsets_shrink_at_loud_reference_level() -> None:
    """Кривые ISO 226 выполаживаются с уровнем: на 90 фон поправки меньше, чем на 60."""
    quiet = band_loudness_offsets(settings.freq_bands, 60.0, PITCH_STEPS)
    loud = band_loudness_offsets(settings.freq_bands, 90.0, PITCH_STEPS)
    assert quiet["delta"] > loud["delta"]
    assert abs(loud["beta"]) < abs(quiet["beta"])


def test_band_offsets_are_deterministic() -> None:
    """Детерминизм рендера: повторный расчёт смещений даёт байт-в-байт те же числа."""
    first = band_loudness_offsets(settings.freq_bands, 75.0, PITCH_STEPS)
    second = band_loudness_offsets(settings.freq_bands, 75.0, PITCH_STEPS)
    assert first == second


def test_invalid_phon_and_frequency_are_rejected() -> None:
    """Границы стандарта: phon вне 0…90 и частоты вне 20 Гц … 20 кГц — ValueError."""
    with pytest.raises(ValueError, match="0…90"):
        equal_loudness_spl_db([1000.0], 95.0)
    with pytest.raises(ValueError, match="20 Гц"):
        equal_loudness_spl_db([10.0], 75.0)


def test_offsets_reference_is_1khz_not_band_mean() -> None:
    """Смещения считаются относительно 1 кГц (определение фона), а не среднего."""
    reference = float(equal_loudness_spl_db([1000.0], 75.0)[0])
    assert reference == pytest.approx(75.0, abs=0.05)
    # Проверка одного бина: offset полосы не может быть больше разброса кривой.
    grid = np.geomspace(64.0, 256.0, 32)
    delta_mean = float(np.mean(equal_loudness_spl_db(grid, 75.0)))
    offsets = band_loudness_offsets(settings.freq_bands, 75.0, PITCH_STEPS)
    assert offsets["delta"] == pytest.approx(delta_mean - reference, abs=1e-9)


def test_pit_bands_are_middle_octaves() -> None:
    """«Яма» середины при ×128 — ровно θ (512–1024), α (1024–2048), β (2048–4096)."""
    assert set(pit_bands(settings.freq_bands, PITCH_STEPS)) == {"theta", "alpha", "beta"}


def test_pit_bands_follow_octave_choice() -> None:
    """Выбор октав сдвигает набор «ямы» по абсолютным аудио-частотам 0.5–4 кГц.

    ×64 (6 октав): α/β/γ; ×32 (5 октав): β/γ/γ-high — гамма и высокая гамма
    становятся «серединой» слуха (эксперимент выбора транспонирования).
    """
    assert set(pit_bands(settings.freq_bands, 6)) == {"alpha", "beta", "gamma"}
    assert set(pit_bands(settings.freq_bands, 5)) == {"beta", "gamma", "high_gamma"}


def test_autobase_limits_base_to_pit_ceiling() -> None:
    """Автобаза: base = min(база, bound − offset) по полосам «ямы» (стратегия A).

    bound = 20·log10(0.891) − crest: при crest 14 дБ и offset α +2.1 лимит
    ≈ −17.1 — ровно та база, при которой середина не упирается в потолок и
    выравнивается по перцептиву.
    """
    limited = autobase_db(-12.0, {"alpha": 14.0}, {"alpha": 2.1}, ["alpha"])
    assert limited == pytest.approx(-17.1, abs=0.01)

    # База уже ниже лимита — не поднимается (только min).
    assert autobase_db(-18.0, {"alpha": 14.0}, {"alpha": 2.1}, ["alpha"]) == -18.0

    # «Яма» из нескольких полос: берётся худший лимит.
    worst = autobase_db(
        -12.0,
        {"theta": 15.0, "alpha": 14.0, "beta": 15.0},
        {"theta": 0.1, "alpha": 2.1, "beta": -2.2},
        ["theta", "alpha", "beta"],
    )
    assert worst == pytest.approx(-17.1, abs=0.01)

    # Тихий/неконечный стем не рушит базу; пустая «яма» — без изменений.
    assert autobase_db(-12.0, {"alpha": np.inf}, {"alpha": 2.1}, ["alpha"]) == -12.0
    assert autobase_db(-12.0, {}, {}, []) == -12.0
