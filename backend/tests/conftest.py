"""Общие фикстуры для тестов DipLock.

Запуск: cd backend && venv/bin/python -m pytest
"""
import os
import sys

# Гарантируем, что каталог backend/ в sys.path (import app.* работает при любом CWD)
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import mne
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app


@pytest.fixture(scope="session")
def client() -> TestClient:
    """TestClient FastAPI-приложения (использует httpx)."""
    with TestClient(app) as c:
        yield c


def _make_raw(
    sfreq: float = 250.0,
    duration: float = 4.0,
    tone_freq: float = 10.0,
    amplitude_uv: float = 5.0,
) -> mne.io.RawArray:
    """Синтетический ЭЭГ RawArray (20 каналов 10-20) с синусоидой tone_freq Гц."""
    rng = np.random.RandomState(42)
    ch_names = list(settings.standard_channels)
    n_samples = int(sfreq * duration)
    data = rng.randn(len(ch_names), n_samples) * 1e-6  # шум ~1 мкВ
    t = np.arange(n_samples) / sfreq
    data += (amplitude_uv * 1e-6) * np.sin(2 * np.pi * tone_freq * t)

    info = mne.create_info(ch_names, sfreq, "eeg")
    raw = mne.io.RawArray(data, info, verbose=False)
    # MNE >= 1.13: 'standard_1020' -> 'colin27_1020' (fallback для старых версий)
    for montage in ("colin27_1020", "standard_1020"):
        try:
            raw.set_montage(montage, on_missing="ignore", verbose=False)
            break
        except (ValueError, KeyError) as err:
            last_err = err
    else:  # pragma: no cover
        raise AssertionError(f"Не удалось поставить монтаж: {last_err}")
    return raw


@pytest.fixture
def raw_eeg() -> mne.io.RawArray:
    """Синтетическая запись 4 секунды, тон 10 Гц (alpha)."""
    return _make_raw()


@pytest.fixture
def empty_annotations() -> mne.Annotations:
    return mne.Annotations([], [], [])


@pytest.fixture
def epochs_alpha() -> mne.Epochs:
    """Синтетические эпохи по 1 секунде с доминирующим alpha-ритмом (10 Гц)."""
    raw = _make_raw(tone_freq=10.0)
    raw.set_annotations(mne.Annotations([], [], []))
    events = mne.make_fixed_length_events(raw, duration=1.0)
    return mne.Epochs(
        raw, events, tmin=0, tmax=1.0, baseline=None,
        preload=True, verbose=False,
    )
