"""Частотная фильтрация: δ/θ/α/β/γ + кастомный диапазон + одиночная частота."""
import mne
import numpy as np
from typing import Dict, Optional


def apply_band_filter(
    epochs: mne.Epochs,
    band_name: str = "all",
    custom_min: Optional[float] = None,
    custom_max: Optional[float] = None,
    single_freq: Optional[float] = None,
    bandwidth_hz: float = 0.5,
) -> mne.Epochs:
    """
    Применяет фильтр к эпохам.

    - band_name: 'all', 'delta', 'theta', 'alpha', 'beta', 'gamma'
    - custom_min/custom_max: кастомный диапазон (напр. 7.0–9.5)
    - single_freq: одиночная частота (напр. 7.83 Гц) → narrow bandpass
      bandwidth_hz центрируется на ней (7.58 — 8.08)
    """
    standard_bands = {
        "delta": (1, 4),
        "theta": (4, 8),
        "alpha": (8, 13),
        "beta": (13, 30),
        "gamma": (30, 40),
    }

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
    """Средняя мощность по каждому диапазону (Welch)."""
    powers = {}
    for name, (fmin, fmax) in bands.items():
        psds, freqs = mne.time_frequency.psd_welch(
            epochs, fmin=fmin, fmax=fmax, n_fft=256, verbose=False
        )
        powers[name] = float(np.mean(psds))
    return powers
