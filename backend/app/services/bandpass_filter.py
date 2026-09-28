"""Частотная фильтрация: δ/θ/α/β/γ + кастомный диапазон + одиночная частота."""

import mne
import numpy as np

from app.core.config import settings
from app.services.filter_design import band_filter_kwargs, nyquist_ceiling_hz

# Фильтровать можно как эпохи, так и continuous raw (рекомендуется raw — см. routes).
type FilterTarget = mne.Epochs | mne.io.BaseRaw


def band_bounds(
    band_name: str = "all",
    custom_min: float | None = None,
    custom_max: float | None = None,
    single_freq: float | None = None,
    bandwidth_hz: float = 0.5,
) -> tuple[float, float] | None:
    """Границы полосы (fmin, fmax) из формы; ``None`` — фильтр не применяется.

    Вынесены из ``apply_band_filter``, чтобы вызывающий мог передать полосу в
    ``segment_epochs`` (краевой буфер переходного процесса, N12) без повторного
    разбора параметров. Порядок веток — как в ``apply_band_filter``:
    ``single_freq`` важнее имени диапазона («all» + одиночная частота — это
    узкая полоса вокруг частоты, а не «без фильтра»).

    Именованные диапазоны резолвятся из ``freq_bands`` (базовые октавные полосы,
    они же считаются в спектре) и из ``functional_bands`` (функциональные ритмы —
    только пресеты фильтра, фаза A): оба словаря — из ``core/config.py``.
    """
    if single_freq is not None:
        half = bandwidth_hz / 2
        return single_freq - half, single_freq + half
    if band_name == "all":
        return None
    if band_name == "custom":
        if custom_min is None or custom_max is None:
            raise ValueError("custom_min и custom_max обязательны для 'custom'")
        return custom_min, custom_max
    if band_name in settings.freq_bands:
        return settings.freq_bands[band_name]
    if band_name in settings.functional_bands:
        return settings.functional_bands[band_name]
    raise ValueError(f"Неизвестный диапазон: {band_name}")


def apply_band_filter(
    epochs: FilterTarget,
    band_name: str = "all",
    custom_min: float | None = None,
    custom_max: float | None = None,
    single_freq: float | None = None,
    bandwidth_hz: float = 0.5,
) -> FilterTarget:
    """
    Применяет фильтр к эпохам или continuous-сигналу (raw).

    - band_name: 'all', 'custom', имя из ``freq_bands``/``functional_bands``
      (напр. 'alpha', 'high_gamma', 'mu')
    - custom_min/custom_max: кастомный диапазон (напр. 7.0–9.5)
    - single_freq: одиночная частота (напр. 7.83 Гц) → narrow bandpass
      bandwidth_hz центрируется на ней (7.58 — 8.08)

    Метод выбирается по ширине полосы (``filter_design``): узкая (≤
    ``Settings.filter_iir_max_width_hz``) — IIR Butterworth zero-phase, широкая
    — FIR с явными переходными полосами (N11). Для коротких эпох (< длины
    FIR-фильтра) фильтрация даёт искажения — поэтому в пайплайне фильтр
    применяется к raw ДО нарезки.

    Верхняя граница зажимается до ``nyquist_ceiling_hz`` (Найквист − 2 Гц):
    полоса вроде «широкий 0.5–128» на записи 250 Гц фильтруется до 123 Гц, а не
    падает ``ValueError`` от MNE.
    """
    bounds = band_bounds(band_name, custom_min, custom_max, single_freq, bandwidth_hz)
    if bounds is None:
        return epochs
    fmin, fmax = bounds
    sfreq = float(epochs.info["sfreq"])
    fmax = min(fmax, nyquist_ceiling_hz(sfreq))
    return epochs.copy().filter(
        fmin, fmax, verbose=False,
        **band_filter_kwargs(fmin, fmax, sfreq),
    )


def compute_band_powers(
    epochs: mne.Epochs, bands: dict[str, tuple],
) -> tuple[dict[str, float], dict[str, np.ndarray]]:
    """Мощности по диапазонам (Welch): средние и по каждой эпохе — один PSD.

    Возвращает ``(means, per_epoch)``: ``means[name]`` — среднее по всем эпохам и
    каналам (как раньше ``compute_band_power``), ``per_epoch[name]`` — массив
    длины ``len(epochs)`` (нужен для строк эпох в БД, F21). PSD считается **один
    раз**: второй вызов стоил бы ещё ~0.5 с на 261 эпохе.
    """
    if not bands:
        return {}, {}

    # n_fft не может превышать длину эпохи (ограничение pSD-welch), иначе
    # короткие эпохи (250–1000 мс) дают ValueError. Адаптируем под сигнал.
    n_times = len(epochs.times)
    n_fft = min(256, n_times)

    # Один общий расчёт PSD по всему охвату диапазонов (MNE >= 1.10: compute_psd).
    # Верх — не выше Найквиста: сетка `freq_bands` доходит до 128 Гц, а MNE на
    # записи 250 Гц отдаёт ValueError «fmax must not exceed ½ the sampling frequency».
    fmin_total = min(bands.values(), key=lambda x: x[0])[0]
    fmax_total = min(
        max(bands.values(), key=lambda x: x[1])[1],
        nyquist_ceiling_hz(float(epochs.info["sfreq"])),
    )
    spectrum = epochs.compute_psd(
        method="welch", fmin=fmin_total, fmax=fmax_total,
        n_fft=n_fft, verbose=False,
    )
    psds = spectrum.get_data()  # shape (n_epochs, n_channels, n_freqs)
    freqs = spectrum.freqs

    means: dict[str, float] = {}
    per_epoch: dict[str, np.ndarray] = {}
    for name, (fmin, fmax) in bands.items():
        mask = (freqs >= fmin) & (freqs <= fmax)
        band = np.mean(psds[:, :, mask], axis=(1, 2))  # (n_epochs,)
        per_epoch[name] = band
        means[name] = float(np.mean(band))
    return means, per_epoch


def compute_band_power(epochs: mne.Epochs, bands: dict[str, tuple]) -> dict[str, float]:
    """Средняя мощность по каждому диапазону (Welch). Один PSD-расчёт + нарезка."""
    return compute_band_powers(epochs, bands)[0]
