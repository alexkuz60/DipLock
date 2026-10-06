"""Тесты ядра «Нейромузыки» (M1): частота ×128, длина, огибающая, финитность, время.

Пять приёмок ТЗ (§4 M1): (а) тон 10 Гц → 1280 Гц без других пиков, (б) длина
трека N*96, (в) АМ-огибающая сохраняется (r ≥ 0.99), (г) нулевой вход без
NaN/inf, (д) запись 100 с рендерится < 2 с на одном ядре CPU.
"""
import time

import numpy as np
from scipy.signal import correlate, hilbert

from app.services.audio_render.core import FS_AUDIO, PITCH_STEPS, RESAMPLE_UP, band_stem

FS_EEG = 500.0


def _sine_band(freq_hz: float, duration_s: float, amp: float = 1.0) -> np.ndarray:
    """Одноканальный синус (1, N) float64 @500 Гц."""
    n = int(FS_EEG * duration_s)
    t = np.arange(n) / FS_EEG
    return (amp * np.sin(2.0 * np.pi * freq_hz * t)).reshape(1, n)


def _monoral_stem(eeg: np.ndarray) -> np.ndarray:
    """Трек при единичных весах (L и R получают один и тот же моно-сигнал)."""
    w = np.ones(eeg.shape[0])
    return band_stem(eeg, w, w)


def test_sine_10hz_has_single_peak_at_1280hz() -> None:
    """(а) Тон 10 Гц после ×128 даёт пик 1280 Гц ±1 бин и больше ничего."""
    stem = _monoral_stem(_sine_band(10.0, 4.0))
    # Края ресемплера и hilbert (окно kaiser 1921 отсчёт) отбрасываем: на
    # них сидят переходные процессы, а не чистый тон.
    n_out = stem.shape[0]
    core = stem[n_out // 10 : -n_out // 10, 0]
    spectrum = np.abs(np.fft.rfft(core))
    freqs = np.fft.rfftfreq(core.size, 1.0 / FS_AUDIO)
    df = float(freqs[1] - freqs[0])

    peak = int(np.argmax(spectrum))
    assert abs(float(freqs[peak]) - 1280.0) <= 1.5 * df, f"пик {freqs[peak]:.1f} Гц вместо 1280"

    # Вне ±1 бина от пика — только утечка прямоугольного окна (< 5 %), никаких тонов.
    outside = np.abs(freqs - float(freqs[peak])) > 1.5 * df
    assert float(spectrum[outside].max()) < 0.05 * float(spectrum[peak])


def test_output_length_is_n_times_96() -> None:
    """(б) Длительность выхода = N/500 с: ровно N*96 отсчётов, стерео-пара."""
    for duration_s in (0.5, 4.0):
        eeg = _sine_band(10.0, duration_s)
        stem = _monoral_stem(eeg)
        n = eeg.shape[1]
        assert stem.shape == (n * RESAMPLE_UP, 2)
        assert stem.shape[0] / FS_AUDIO == duration_s


def test_am_envelope_survives_the_core() -> None:
    """(в) Синус 10 Гц с АМ 1 Гц: огибающая выхода коррелирует с исходной ≥ 0.99."""
    duration_s = 6.0
    n = int(FS_EEG * duration_s)
    t = np.arange(n) / FS_EEG
    envelope_in = 1.0 + 0.5 * np.sin(2.0 * np.pi * 1.0 * t)
    mono = envelope_in * np.sin(2.0 * np.pi * 10.0 * t)

    stem = _monoral_stem(mono.reshape(1, n))
    env_out = np.abs(hilbert(stem[:, 0]))

    # Огибающая на оси рендера (×96) → сравниваем по тем же отсчётам времени.
    env_out_ds = env_out[RESAMPLE_UP // 2 :: RESAMPLE_UP][:n]
    m = env_out_ds.size
    # Края (переход ресемплера, окно kaiser 1921 отсчёт) отбрасываем по 10 %.
    lo, hi = int(0.1 * m), int(0.9 * m)
    x = env_out_ds[lo:hi]

    # Полифазовый фильтр несёт групповую задержку (~10 исходных отсчётов) —
    # выравниваем огибающие кросс-корреляцией (FFT), а не считаем сдвиг дефектом.
    # Доводка дробным сдвигом: шаг в 1 отсчёт 500 Гц = 2 мс = ~7° фазы АМ 1 Гц,
    # поэтому одного argmax по целым отсчётам для порога 0.99 мало.
    corr = correlate(x, envelope_in, mode="valid", method="fft")
    start = int(np.argmax(corr))
    idx = np.arange(x.size)
    best_r, best_s = -np.inf, float(start)
    for shift in np.arange(start - 2.0, start + 2.01, 0.25):
        ref = np.interp(idx + shift, np.arange(n), envelope_in)
        # Отбрасываем края выровненного участка (неполные перекрытия).
        core = int(0.1 * x.size)
        a, b = x[core:-core], ref[core:-core]
        r = float(np.corrcoef(a, b)[0, 1])
        if r > best_r:
            best_r, best_s = r, float(shift)
    assert best_r >= 0.99, f"корреляция огибающих {best_r:.4f} (сдвиг {best_s:.2f}) < 0.99"


def test_zero_channel_produces_finite_output() -> None:
    """(г) Полностью нулевой вход → выход без NaN/inf (eps защиты деления)."""
    eeg = np.zeros((3, int(FS_EEG * 1.0)))
    stem = band_stem(eeg, np.ones(3), np.ones(3))
    assert stem.shape == (int(FS_EEG * RESAMPLE_UP), 2)
    assert np.isfinite(stem).all()
    assert not stem.any()  # нулевой вход → нулевой трек


def test_invalid_shapes_are_rejected() -> None:
    """Формы входа — контракт: (K, N) и веса длины K, иначе ValueError."""
    eeg = np.zeros((3, 100))
    with np.testing.assert_raises(ValueError):
        band_stem(eeg, np.ones(2), np.ones(3))
    with np.testing.assert_raises(ValueError):
        band_stem(np.zeros(100), np.ones(1), np.ones(1))


def test_100s_session_renders_under_2s() -> None:
    """(д) Сессия 100 с (500 Гц) рендерится < 2 с на одном ядре CPU (ТЗ §4 M1)."""
    rng = np.random.default_rng(42)
    n = int(FS_EEG * 100.0)
    eeg = rng.standard_normal((1, n)) * 1e-6  # ~1 мкВ шума, честный вход
    w = np.ones(1)
    started = time.perf_counter()
    stem = band_stem(eeg, w, w)
    elapsed = time.perf_counter() - started
    assert stem.shape == (n * RESAMPLE_UP, 2)
    assert elapsed < 2.0, f"рендер 100 с занял {elapsed:.2f} с (порог 2.0 с)"


def test_pitch_steps_constant_matches_octave_grid() -> None:
    """Сетка частот: 7 октав ×128 и 500×96=48000 — константы ядра согласованы."""
    assert 2**PITCH_STEPS == 128
    assert FS_EEG * RESAMPLE_UP == FS_AUDIO


def test_pitch_steps_scales_the_tone() -> None:
    """Выбор октав (5/6/7): тон 10 Гц → 320/640/1280 Гц, других пиков нет.

    Тот же контракт «(а)», но для параметра ``pitch_steps`` (эксперимент
    выбора транспонирования 06.10.2026): меньше квадратов фазы — ниже пик,
    огибающая и длина трека не меняются.
    """
    for steps, factor in ((5, 32), (6, 64), (7, 128)):
        w = np.ones(1)
        stem = band_stem(_sine_band(10.0, 4.0), w, w, pitch_steps=steps)
        assert stem.shape == (int(FS_EEG * 4.0) * RESAMPLE_UP, 2)
        n_out = stem.shape[0]
        core = stem[n_out // 10 : -n_out // 10, 0]
        spectrum = np.abs(np.fft.rfft(core))
        freqs = np.fft.rfftfreq(core.size, 1.0 / FS_AUDIO)
        df = float(freqs[1] - freqs[0])
        peak = int(np.argmax(spectrum))
        expected = 10.0 * factor
        assert abs(float(freqs[peak]) - expected) <= 1.5 * df, (
            f"pitch_steps={steps}: пик {freqs[peak]:.1f} Гц вместо {expected}"
        )
        outside = np.abs(freqs - float(freqs[peak])) > 1.5 * df
        assert float(spectrum[outside].max()) < 0.05 * float(spectrum[peak])


def test_invalid_pitch_steps_are_rejected() -> None:
    """``pitch_steps < 1`` — ValueError (валидация целостности ядра)."""
    w = np.ones(1)
    with np.testing.assert_raises(ValueError):
        band_stem(_sine_band(10.0, 1.0), w, w, pitch_steps=0)
