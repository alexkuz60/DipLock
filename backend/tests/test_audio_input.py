"""Тесты входа рендера (M3): пакеты, ресемпл к 500 Гц, NaN/inf, контроль 50 Гц."""
import time

import numpy as np
import pytest

from app.core.config import settings
from app.services.audio_render.input import (
    AUDIO_NOTCH_HZ,
    BandPackages,
    line_noise_warnings,
    prepare_packages,
    validate_packages,
)
from app.services.recordings import Recording, recording_registry


def _recording(edf_file, recording_id: str = "audio-input") -> Recording:
    """Запись поверх тестового EDF (паттерн test_prepared_signal)."""
    return Recording(
        recording_id=recording_id,
        filename="probe.edf",
        path=str(edf_file),
        upload_dir=str(edf_file.parent),
        created_at=time.time(),
        meta={"sfreq": 250.0, "duration_sec": 4.0},
    )


@pytest.fixture(autouse=True)
def clean_state():
    """Кэш подготовленного сигнала пуст между тестами."""
    recording_registry.clear()
    from app.services.prepared_signal import clear_prepared_cache

    clear_prepared_cache()
    yield
    recording_registry.clear()
    clear_prepared_cache()


def test_prepare_packages_builds_seven_float64_bands(edf_file) -> None:
    """EDF 250 Гц/4 с → семь пакетов float64, sfreq=500, длина 2000 отсчётов."""
    stages: list[tuple[str, float]] = []
    result = prepare_packages(
        _recording(edf_file), settings, on_stage=lambda msg, pct: stages.append((msg, pct)),
    )
    assert isinstance(result, BandPackages)
    assert result.sfreq == 500.0  # контракт ядра (запись 250 Гц ресемплирована)
    assert set(result.packages) == set(settings.freq_bands)
    n_times = int(4.0 * 500)  # 4 с записи
    assert result.n_times == n_times
    assert result.duration_s == pytest.approx(4.0, abs=0.01)
    for data in result.packages.values():
        assert data.dtype == np.float64
        assert data.shape == (len(result.channels), n_times)
        assert np.isfinite(data).all()
    # Прогресс дошёл до полос (шаги с процентами монотонно растут).
    assert stages, "on_stage не вызывался"
    assert any(pct > 0.2 for _msg, pct in stages)
    assert result.clean_label  # «партитура» знает, что применялось


def test_validate_packages_rejects_nan() -> None:
    """NaN/inf в пакете — явная ошибка, а не тихий рендер (ТЗ §2)."""
    ok = {"alpha": np.zeros((3, 10))}
    validate_packages(ok)  # не бросает

    bad = {"alpha": np.full((3, 10), np.nan)}
    with pytest.raises(ValueError, match="NaN/inf"):
        validate_packages(bad)

    bad_inf = {"gamma": np.full((3, 10), np.inf)}
    with pytest.raises(ValueError, match="NaN/inf"):
        validate_packages(bad_inf)


def test_line_noise_warning_fires_on_50hz_tone() -> None:
    """Тон 50 Гц в γ-пакете (после фильтра 32–64) даёт предупреждение о свисте."""
    sfreq = 500.0
    n = int(sfreq * 8)
    t = np.arange(n) / sfreq
    # Шумовой пол γ-полосы + заметный тон 50 Гц.
    rng = np.random.default_rng(3)
    noise = rng.standard_normal((5, n)) * 1e-7
    tone = np.sin(2 * np.pi * AUDIO_NOTCH_HZ * t) * 1e-5
    gamma = noise + tone
    warnings = line_noise_warnings({"gamma": gamma}, settings, sfreq)
    assert warnings, "тон 50 Гц должен быть замечен"
    assert "свист" in warnings[0]

    # Чистый шум того же уровня — без срабатывания на тон.
    quiet = line_noise_warnings({"gamma": noise}, settings, sfreq)
    assert quiet == []


def test_line_noise_check_skips_empty_and_short_packages() -> None:
    """Короткие/пустые пакеты не роняют проверку (без краевых эффектов — нет ложных срабатываний)."""
    assert line_noise_warnings({"gamma": np.zeros((3, 8))}, settings, 500.0) == []
    assert line_noise_warnings({}, settings, 500.0) == []
