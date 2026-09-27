"""Единый кардио-детектор (`services/cardio.py`): QRS, зоны ecg, ряд ЧСС.

Синтетика: височные каналы с острыми QRS-импульсами на фоне шума — те же
входы, что у детектора зон `ecg`. Проверяются ритм по IBI, объединение пиков,
границы (нет височных / sfreq ≤ 50 / нерегулярные пики) и окно/шаг ряда ЧСС.
"""
import numpy as np

from app.core.config import settings
from app.services.artifact_detector import detect_artifacts
from app.services.cardio import (
    detect_qrs,
    ecg_proxy,
    ecg_zones,
    heart_rate_series,
)

_SFREQ = 500.0


def _rhythm_data(
    duration_sec: float = 20.0,
    period_sec: float = 0.75,
    channels: tuple[str, ...] = ("T7", "T8"),
    seed: int = 0,
) -> tuple[np.ndarray, list[str]]:
    """Шум + острые QRS-импульсы синфазно на височных (период `period_sec`)."""
    names = [*channels, "C3", "C4"]
    n = int(_SFREQ * duration_sec)
    rng = np.random.default_rng(seed)
    data = rng.standard_normal((len(names), n)) * 1e-6
    beat_idx = [int(k * period_sec * _SFREQ) + 100 for k in range(int(duration_sec / period_sec))]
    for i in range(len(channels)):
        for idx in beat_idx:
            data[i, idx: idx + 3] += 60e-6
    return data, names


def _expected_bpm(period_sec: float) -> float:
    return round(60.0 / period_sec, 1)


# ---------- детекция QRS и зоны ----------


def test_detect_qrs_finds_rhythm_on_temporal():
    """Синфазные импульсы на T7/T8 — ритм подтверждён, пики объединены."""
    data, names = _rhythm_data(period_sec=0.75)

    detection = detect_qrs(data, names, _SFREQ)

    assert detection.is_rhythm
    assert set(detection.rhythm_channels) == {"T7", "T8"}
    # Объединение каналов не удваивает сердце (рефракторный интервал)
    n_beats = int(20.0 / 0.75)
    assert abs(int(detection.merged_peaks_sec.size) - n_beats) <= 1


def test_ecg_zones_geometry_matches_peaks():
    """Зоны: одна на пик, ±0.15 с (контракт слоёв вьюера), канал — височный."""
    data, names = _rhythm_data(period_sec=0.8)
    duration = data.shape[1] / _SFREQ

    detection = detect_qrs(data, names, _SFREQ)
    zones = ecg_zones(detection, _SFREQ, duration)

    assert zones, "Зоны ecg должны найтись"
    assert all(z["kind"] == "ecg" for z in zones)
    assert all(z["channels"] == ["T7"] or z["channels"] == ["T8"] for z in zones)
    # Период 0.8 с, зона 0.3 с — зоны не перекрываются и покрывают ритм
    assert all(0.29 <= z["duration_sec"] <= 0.31 for z in zones)


def test_detect_qrs_empty_without_temporal_channels():
    """Нет височных отведений — пустая детекция и пустой ряд ЧСС."""
    data, names = _rhythm_data(channels=())
    data = data[:2]
    names = ["C3", "C4"]

    detection = detect_qrs(data, names, _SFREQ)

    assert not detection.is_rhythm
    assert detection.peaks_sec == {}
    assert heart_rate_series(detection, 20.0) is None


def test_detect_qrs_empty_at_low_sfreq():
    """sfreq ≤ 50 Гц: полоса 20 Гц под Найквистом не помещается — честно пусто."""
    data, names = _rhythm_data()

    detection = detect_qrs(data, names, 50.0)

    assert not detection.is_rhythm


def test_irregular_peaks_are_not_rhythm():
    """Случайные всплески без квазипериодичности — не сердце, ЧСС не извлекается."""
    n = int(_SFREQ * 30.0)
    names = ["T7", "C3"]
    rng = np.random.default_rng(5)
    data = rng.standard_normal((2, n)) * 1e-6
    for idx in rng.integers(0, n - 100, size=40):  # пики в случайных местах
        data[0, int(idx): int(idx) + 3] += 60e-6

    detection = detect_qrs(data, names, _SFREQ)

    assert not detection.is_rhythm
    assert heart_rate_series(detection, 30.0) is None


# ---------- ряд ЧСС ----------


def test_heart_rate_series_median_matches_period():
    """Ритм 0.75 с (80 уд/мин): медиана ряда и ЧСС-окна ≈ 80 ± 2."""
    data, names = _rhythm_data(duration_sec=40.0, period_sec=0.75)
    detection = detect_qrs(data, names, _SFREQ)

    series = heart_rate_series(detection, duration_sec=40.0)

    assert series is not None
    assert series.median_bpm is not None
    assert abs(series.median_bpm - 80.0) <= 2.0
    values = [b for b in series.bpm if b is not None]
    assert values and all(abs(b - 80.0) <= 3.0 for b in values)
    # Шаг ряда 1 с → 40 точек на 40 с записи
    assert series.times_sec == [float(t) for t in range(40)]
    assert series.coverage_percent > 90.0
    assert set(series.channels) == {"T7", "T8"}


def test_heart_rate_series_short_window_yields_honest_gaps():
    """Окно 1 с при ритме 0.75 с не вмещает 3 RR — точки None, не выдуманные."""
    data, names = _rhythm_data(duration_sec=20.0, period_sec=0.75)
    detection = detect_qrs(data, names, _SFREQ)

    series = heart_rate_series(detection, duration_sec=20.0, window_sec=1.0)

    assert series is not None
    assert all(b is None for b in series.bpm)
    assert series.coverage_percent == 0.0
    assert series.median_bpm is not None  # медиана за запись считается от всех RR


def test_ecg_proxy_guards_and_shape():
    """Прокси есть с височными и без них; форма — как у сигнала записи."""
    data, names = _rhythm_data(duration_sec=10.0)

    proxy = ecg_proxy(data, names, _SFREQ)
    assert proxy is not None and proxy.shape == (data.shape[1],)

    assert ecg_proxy(data[:, :0], [], _SFREQ) is None
    assert ecg_proxy(data, ["C3", "C4"], _SFREQ) is None
    assert ecg_proxy(data, names, 50.0) is None


# ---------- интеграция: детектор артефактов ----------


def test_detect_artifacts_reports_heart_rate_slot():
    """Стадия artifacts: зоны ecg и ряд ЧСС — из одного QRS-расчёта."""
    import mne

    data, names = _rhythm_data(duration_sec=30.0, period_sec=0.8)
    raw = mne.io.RawArray(data, mne.create_info(names, _SFREQ, "eeg"), verbose=False)

    _, stats = detect_artifacts(raw, settings, run_ica=False)

    assert stats["by_type"]["ecg"] > 0
    series = stats["heart_rate"]
    assert series is not None
    assert series.n_beats > 0
    assert series.median_bpm is not None
    assert abs(series.median_bpm - 75.0) <= 2.0
