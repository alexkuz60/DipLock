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


def write_minimal_edf(path, ch_names, data_uv, sfreq, record_sec=1.0, annotations=None):
    """Минимальный корректный EDF (или EDF+ при ``annotations``) без edfio.

    Данные в мкВ, little-endian int16, записи по ``record_sec`` секунд.
    Формат: фиксированная ширина полей заголовка (256 байт + 256 на канал).

    ``annotations`` — список ``(onset_sec, duration_sec, description)``: файл
    пишется как EDF+ с каналом ``EDF Annotations`` (TAL). Стим-каналы
    (``status``/``trigger`` — правило MNE) пишутся с точным целочисленным
    масштабом (физ 0..32767 = цифровые 0..32767), иначе квантование int16
    портит коды триггеров при ``find_events``.
    """
    has_tal = annotations is not None
    ns = len(ch_names) + (1 if has_tal else 0)
    n_times = data_uv.shape[1]
    samps_per_record = round(sfreq * record_sec)
    n_records = int(np.ceil(n_times / samps_per_record))
    pad = n_records * samps_per_record - n_times
    if pad:
        data_uv = np.pad(data_uv, ((0, 0), (0, pad)))
    data_min = float(data_uv.min()) - 1
    data_max = float(data_uv.max()) + 1

    def field(text, width):
        return str(text).ljust(width)[:width]

    def is_stim(name):
        return name.strip().lower() in ("status", "trigger")

    header_bytes = 256 + ns * 256
    annot_samps = 60  # двухбайтовых сэмплов TAL на запись (120 байт)
    parts = [
        field("0", 8), field("Synthetic DipLock", 80), field("Test recording", 80),
        field("01.01.85", 8), field("00.00.00", 8), field(header_bytes, 8),
        field("EDF+C" if has_tal else "", 44),
        field(n_records, 8), field(record_sec, 8), field(ns, 4),
    ]
    labels = list(ch_names) + (["EDF Annotations"] if has_tal else [])
    for name in labels:
        parts.append(field(name, 16))
    for i in range(ns):
        last = has_tal and i == ns - 1
        parts.append(field("" if last else "AgAgCl", 80))
    for i in range(ns):
        last = has_tal and i == ns - 1
        parts.append(field("" if last else "uV", 8))
    for i, name in enumerate(labels):
        last = has_tal and i == ns - 1
        if last:
            parts.append(field(-1, 8))
        elif is_stim(name):
            parts.append(field(0, 8))
        else:
            parts.append(field(data_min, 8))
    for i, name in enumerate(labels):
        last = has_tal and i == ns - 1
        if last:
            parts.append(field(1, 8))
        elif is_stim(name):
            parts.append(field(32767, 8))
        else:
            parts.append(field(data_max, 8))
    for _ in range(ns):
        parts.append(field(0, 8))  # dig_min: 0 у стим-канала (точные коды), 0 у остальных
    for _ in range(ns):
        parts.append(field(32767, 8))  # dig_max
    for _ in range(ns):
        parts.append(field("", 80))  # prefiltering
    for i in range(ns):
        last = has_tal and i == ns - 1
        parts.append(field(annot_samps if last else samps_per_record, 8))
    for _ in range(ns):
        parts.append(field("", 32))
    header = "".join(parts).encode("latin-1")
    assert len(header) == header_bytes, (len(header), header_bytes)

    digital = np.zeros(data_uv.shape, dtype="<i2")
    for ch, name in enumerate(ch_names):
        if is_stim(name):
            # Физ 0..32767 = цифровые 0..32767: масштаб 1:1, коды триггеров точны
            digital[ch] = np.rint(data_uv[ch]).astype("<i2")
        else:
            scale = (data_max - data_min) / 32767
            digital[ch] = np.rint((data_uv[ch] - data_min) / scale).astype("<i2")

    # TAL (EDF+): разделитель длительности — \x15, описаний — \x14 (регэксп MNE)
    tal_bytes = annot_samps * 2
    tal = bytearray(b"+0\x14\x14\x00")
    for onset, dur, desc in annotations or []:
        if dur > 0:
            tal += f"+{onset}\x15{dur}\x14{desc}\x14\x00".encode("latin-1")
        else:
            tal += f"+{onset}\x14\x14{desc}\x14\x00".encode("latin-1")

    with open(path, "wb") as fh:
        fh.write(header)
        for rec in range(n_records):
            start = rec * samps_per_record
            for ch in range(len(ch_names)):
                fh.write(digital[ch, start : start + samps_per_record].tobytes())
            if has_tal:
                chunk = bytes(tal[rec * tal_bytes : (rec + 1) * tal_bytes])
                fh.write(chunk.ljust(tal_bytes, b"\x00"))


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
