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
from app.services.filter_design import harmonic_frequencies
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


def test_prepare_packages_always_notches_first_harmonics(monkeypatch, edf_file) -> None:
    """Обязательный режект 100/150 Гц вызывается в каждом прогоне (05.10.2026).

    Даже когда дефолтная очистка деградировала (в load_edf остаётся только
    50 Гц) — notch с двумя первыми гармониками обязан пройти после приведения
    к 500 Гц. Частоты — из единого helper'а filter_design.
    """
    import mne

    calls: list[list[float]] = []
    original = mne.io.BaseRaw.notch_filter

    def spy(self, freqs, *args, **kwargs):  # type: ignore[no-untyped-def]
        calls.append([float(value) for value in np.atleast_1d(freqs)])
        return original(self, freqs, *args, **kwargs)

    monkeypatch.setattr(mne.io.BaseRaw, "notch_filter", spy)
    prepare_packages(_recording(edf_file), settings)

    harmonic_calls = [call for call in calls if 100.0 in call and 150.0 in call]
    assert harmonic_calls, f"вызов notch с [100, 150] не найден среди: {calls}"
    # Режект идёт на 500-Гц сигнале — частоты считает harmonic_frequencies.
    assert harmonic_calls[-1] == harmonic_frequencies(AUDIO_NOTCH_HZ, 2, 500.0)


def test_harmonic_tone_is_removed_from_packages(monkeypatch, tmp_path) -> None:
    """Тон 100 Гц (полоса high_gamma 64–128) подавлен обязательным режектом.

    A/B: прогон с выключенным ``apply_line_harmonics`` оставляет тон в пакете,
    обычный прогон подавляет его на десятки дБ — численное доказательство
    требования «обязательный режект двух первых гармоник».
    """
    from app.services.artifact_cleaner import CleanSpec
    from app.services.audio_render import input as audio_input
    from tests.conftest import write_minimal_edf

    ch_names = list(settings.standard_channels[:5])
    sfreq = 500.0
    t = np.arange(int(8 * sfreq)) / sfreq
    tone = np.sin(2 * np.pi * 100.0 * t) * 1e-5  # 10 мкВ — тон в high_gamma
    data = np.vstack([tone + index * 1e-6 for index in range(len(ch_names))])
    path = tmp_path / "tone100.edf"
    write_minimal_edf(path, ch_names, data, sfreq)

    def amplitude(result: BandPackages) -> float:
        package = result.packages["high_gamma"]
        spectrum = np.abs(np.fft.rfft(package - package.mean(axis=1, keepdims=True)))
        freqs = np.fft.rfftfreq(package.shape[1], 1.0 / result.sfreq)
        index = int(np.argmin(np.abs(freqs - 100.0)))
        return float(np.mean(spectrum[:, index]))

    def recording(recording_id: str) -> Recording:
        return Recording(
            recording_id=recording_id,
            filename="tone100.edf",
            path=str(path),
            upload_dir=str(path.parent),
            created_at=time.time(),
            meta={"sfreq": sfreq, "duration_sec": 8.0},
        )

    from app.services.prepared_signal import clear_prepared_cache

    # Без дефолтной очистки (ICA выкидывает общий тон в обоих прогонах и
    # «замылляет» A/B): разница между прогонами — только apply_line_harmonics.
    monkeypatch.setattr(audio_input, "AUDIO_DEFAULT_CLEAN", CleanSpec())

    clear_prepared_cache()
    with_notch = prepare_packages(recording("tone-with"), settings)

    monkeypatch.setattr(audio_input, "apply_line_harmonics", lambda raw, sf: [])
    clear_prepared_cache()
    without_notch = prepare_packages(recording("tone-without"), settings)

    loud = amplitude(without_notch)
    assert loud > 0.0, "контрольный прогон: тон обязан дойти до пакета без режекта"
    ratio_db = 20.0 * float(np.log10(amplitude(with_notch) / loud))
    assert ratio_db <= -20.0, f"тон 100 Гц подавлен лишь на {ratio_db:.1f} дБ"
