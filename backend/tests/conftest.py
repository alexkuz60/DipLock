"""Общие фикстуры для тестов DipLock.

Запуск: cd backend && venv/bin/python -m pytest
"""
import atexit
import os
import shutil
import sys
import tempfile

# Каталоги данных уводим во временную папку ДО импорта настроек: иначе тесты
# пишут в рабочий data/edf, а дедуп и TTL-уборка записей могли бы тронуть
# реальные файлы пользователя (реестр их видит как каталоги загрузок).
_TMP_DATA = tempfile.mkdtemp(prefix="diplock-tests-")
os.environ["UPLOAD_DIR"] = os.path.join(_TMP_DATA, "edf")
os.environ["CACHE_DIR"] = os.path.join(_TMP_DATA, "cache")
os.environ["RESULTS_DIR"] = os.path.join(_TMP_DATA, "results")
for _sub in ("edf", "cache", "results"):
    os.makedirs(os.path.join(_TMP_DATA, _sub), exist_ok=True)
atexit.register(shutil.rmtree, _TMP_DATA, True)

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


def write_minimal_edf(path, ch_names, data_uv, sfreq, record_sec=1.0):
    """Минимальный корректный EDF для тестов загрузки (без edfio).

    Данные в мкВ, little-endian int16, записи по ``record_sec`` секунд.
    Формат: фиксированная ширина полей заголовка (256 байт + 256 на канал).
    """
    ns = len(ch_names)
    n_times = data_uv.shape[1]
    samps_per_record = int(round(sfreq * record_sec))
    n_records = int(np.ceil(n_times / samps_per_record))
    pad = n_records * samps_per_record - n_times
    if pad:
        data_uv = np.pad(data_uv, ((0, 0), (0, pad)))

    phys_min, phys_max = float(data_uv.min()) - 1, float(data_uv.max()) + 1
    dig_min, dig_max = -32768, 32767

    def field(text, width):
        return str(text).ljust(width)[:width]

    header_bytes = 256 + ns * 256
    parts = [
        field("0", 8), field("Synthetic DipLock", 80), field("Test recording", 80),
        field("01.01.85", 8), field("00.00.00", 8), field(header_bytes, 8),
        field("", 44), field(n_records, 8), field(record_sec, 8), field(ns, 4),
    ]
    for i in range(ns):
        parts.append(field(ch_names[i], 16))
    for _ in range(ns):
        parts.append(field("AgAgCl", 80))  # трансдьюсер
    for _ in range(ns):
        parts.append(field("uV", 8))
    for _ in range(ns):
        parts.append(field(phys_min, 8))
    for _ in range(ns):
        parts.append(field(phys_max, 8))
    for _ in range(ns):
        parts.append(field(dig_min, 8))
    for _ in range(ns):
        parts.append(field(dig_max, 8))
    for _ in range(ns):
        parts.append(field("", 80))  # prefiltering
    for _ in range(ns):
        parts.append(field(samps_per_record, 8))
    for _ in range(ns):
        parts.append(field("", 32))
    header = "".join(parts).encode("latin-1")
    assert len(header) == header_bytes, (len(header), header_bytes)

    scale = (phys_max - phys_min) / (dig_max - dig_min)
    digital = np.rint((data_uv - phys_min) / scale + dig_min).astype("<i2")

    with open(path, "wb") as fh:
        fh.write(header)
        for rec in range(n_records):
            start = rec * samps_per_record
            for ch in range(ns):
                fh.write(digital[ch, start : start + samps_per_record].tobytes())


@pytest.fixture
def edf_file(tmp_path):
    """Минимальный EDF: 5 каналов 10-20, 250 Гц, 4 с, синусы ~20 мкВ."""
    path = tmp_path / "probe.edf"
    ch_names = list(settings.standard_channels[:5])
    sfreq = 250.0
    t = np.arange(int(4 * sfreq)) / sfreq
    data = np.vstack(
        [np.sin(2 * np.pi * (6 + i) * t) * 20 + i for i in range(len(ch_names))]
    )
    write_minimal_edf(path, ch_names, data, sfreq)
    return path
