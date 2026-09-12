"""Частотная фильтрация: δ/θ/α/β/γ + кастомный диапазон + одиночная частота."""
import mne
import numpy as np
from typing import Dict, Optional, Union
from app.core.config import settings

# Фильтровать можно как эпохи, так и continuous raw (рекомендуется raw — см. routes).
FilterTarget = Union[mne.Epochs, mne.io.BaseRaw]


def apply_band_filter(
    epochs: FilterTarget,
    band_name: str = "all",
    custom_min: Optional[float] = None,
    custom_max: Optional[float] = None,
    single_freq: Optional[float] = None,
    bandwidth_hz: float = 0.5,
) -> FilterTarget:
    """
    Применяет фильтр к эпохам или continuous-сигналу (raw).

    - band_name: 'all', 'delta', 'theta', 'alpha', 'beta', 'gamma'
    - custom_min/custom_max: кастомный диапазон (напр. 7.0–9.5)
    - single_freq: одиночная частота (напр. 7.83 Гц) → narrow bandpass
      bandwidth_hz центрируется на ней (7.58 — 8.08)

    Для коротких эпох (< длины FIR-фильтра) фильтрация даёт искажения —
    поэтому в пайплайне фильтр применяется к raw ДО нарезки.
    """
    standard_bands = settings.freq_bands  # DRY: единый словарь из config.py

    if single_freq is not None:
        fmin = single_freq - bandwidth_hz / 2
        fmax = single_freq + bandwidth_hz / 2
        return epochs.copy().filter(
            fmin, fmax, fir_design="firwin", verbose=False
        )

    if band_name == "all":
        return epochs

    if band_name == "custom":
        if custom_min is None or custom_max is None:
            raise ValueError("custom_min и custom_max обязательны для 'custom'")
        fmin, fmax = custom_min, custom_max
    elif band_name in standard_bands:
        fmin, fmax = standard_bands[band_name]
    else:
        raise ValueError(f"Неизвестный диапазон: {band_name}")

    return epochs.copy().filter(
        fmin, fmax, fir_design="firwin", verbose=False
    )


def compute_band_power(epochs: mne.Epochs, bands: Dict[str, tuple]) -> Dict[str, float]:
    """Средняя мощность по каждому диапазону (Welch). Один PSD-расчёт + нарезка."""
    if not bands:
        return {}

    # n_fft не может превышать длину эпохи (ограничение pSD-welch), иначе
    # короткие эпохи (250–1000 мс) дают ValueError. Адаптируем под сигнал.
    n_times = len(epochs.times)
    n_fft = min(256, n_times)

    # Один общий расчёт PSD по всему охвату диапазонов (MNE >= 1.10: compute_psd)
    fmin_total = min(bands.values(), key=lambda x: x[0])[0]
    fmax_total = max(bands.values(), key=lambda x: x[1])[1]
    spectrum = epochs.compute_psd(
        method="welch", fmin=fmin_total, fmax=fmax_total,
        n_fft=n_fft, verbose=False,
    )
    psds = spectrum.get_data()  # shape (n_epochs, n_channels, n_freqs)
    freqs = spectrum.freqs

    powers = {}
    for name, (fmin, fmax) in bands.items():
        mask = (freqs >= fmin) & (freqs <= fmax)
        powers[name] = float(np.mean(psds[:, :, mask]))
    return powers
