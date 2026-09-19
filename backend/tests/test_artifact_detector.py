"""Детектор артефактов: оконный flat-line (N7/F20) и BAD_-аннотации (N6)."""
import mne
import numpy as np

from app.core.config import settings
from app.services.artifact_detector import detect_artifacts

_CHANNELS = ["C3", "C4", "Fz", "Pz"]
_SFREQ = 500.0


def _raw(data: np.ndarray) -> mne.io.RawArray:
    info = mne.create_info(list(_CHANNELS), _SFREQ, "eeg")
    return mne.io.RawArray(data, info, verbose=False)


def _noise(duration_sec: float, scale: float = 1e-6, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.standard_normal((len(_CHANNELS), int(_SFREQ * duration_sec))) * scale


# ---------- N7/F20: flat-line — «почти константа», а не «близко к нулю» ----------


def test_flat_line_ignores_white_noise():
    """Чистый белый шум — не плоская линия: 0 зон (до исправления было 4 на 30 с)."""
    _, stats = detect_artifacts(_raw(_noise(30.0)), settings, run_ica=False)

    assert stats["by_type"]["flat_line"] == 0
    assert stats["by_type"]["zscore_outlier"] == 0
    assert stats["by_type"]["peak_to_peak"] == 0


def test_flat_line_detects_true_flat_segment():
    """Отвалившийся электрод (нуль 1 с посреди шума) — ровно одна зона flat-line."""
    data = _noise(10.0)
    data[0, int(4 * _SFREQ): int(5 * _SFREQ)] = 0.0  # C3: секунда нулей

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    flat_zones = [z for z in stats["zones"] if z["kind"] == "flat_line"]
    assert len(flat_zones) == 1
    assert flat_zones[0]["channels"] == ["C3"]
    assert 3.5 < flat_zones[0]["onset_sec"] < 4.5
    assert flat_zones[0]["duration_sec"] >= 0.9


def test_flat_line_threshold_still_comes_from_settings():
    """Огромный порог окна → весь сигнал «плоский» (контракт порога сохранён)."""
    cfg = settings.model_copy(update={"flat_line_threshold_uv": 1000.0})
    _, stats = detect_artifacts(_raw(_noise(4.0)), cfg, run_ica=False)

    assert stats["by_type"]["flat_line"] > 0


# ---------- Шаг 0.4: QC-сводка по каналам из зон ----------


def test_channel_qc_summary_merges_intervals_and_skips_ica():
    """Пересекающиеся зоны — одно время; ica_eog (весь монтаж) не считается."""
    from app.services.artifact_detector import channel_qc_summary

    zones = [
        {"kind": "peak_to_peak", "onset_sec": 1.0, "duration_sec": 2.0, "channels": ["C3"]},
        {"kind": "zscore_outlier", "onset_sec": 2.0, "duration_sec": 2.0, "channels": ["C3"]},
        {"kind": "flat_line", "onset_sec": 6.0, "duration_sec": 1.0, "channels": ["C3"]},
        {"kind": "ica_eog", "onset_sec": 0.0, "duration_sec": 10.0, "channels": ["C3", "C4"]},
    ]
    summary = channel_qc_summary(zones, ["C3", "C4"], 10.0)

    c3 = next(row for row in summary if row["channel"] == "C3")
    # [1,4] слиты (2 с p2p + 2 с z-score пересекаются) + [6,7] = 4 с из 10 с
    assert c3["artifact_sec"] == 4.0
    assert c3["artifact_share"] == 0.4
    assert c3["by_kind"] == {"peak_to_peak": 2.0, "zscore_outlier": 2.0, "flat_line": 1.0}

    c4 = next(row for row in summary if row["channel"] == "C4")
    assert c4["artifact_sec"] == 0.0, "зона ica_eog не должна засчитываться каналу"
    assert c4["by_kind"] == {}


def test_channel_qc_covers_all_channels_of_recording():
    """Сводка содержит каждый канал записи — иконка нужна и у чистого канала."""
    from app.services.artifact_detector import channel_qc_summary

    summary = channel_qc_summary([], ["Fz", "Pz"], 4.0)
    assert [row["channel"] for row in summary] == ["Fz", "Pz"]
    assert all(row["artifact_share"] == 0.0 for row in summary)


# ---------- N6: аннотации с BAD_ реально отбраковывают эпохи ----------


def test_annotation_descriptions_carry_bad_prefix():
    """Все описания аннотаций детектора начинаются с BAD_ (контракт отбраковки)."""
    data = _noise(6.0)
    data[:, int(2 * _SFREQ): int(2.2 * _SFREQ)] = 500e-6  # всплеск на всех каналах

    annotations, stats = detect_artifacts(
        _raw(data), settings, pp_threshold_uv=100.0, run_ica=False,
    )

    assert stats["total"] > 0
    assert len(annotations) > 0
    assert all(d.startswith("BAD_") for d in annotations.description)


def test_artifact_zones_actually_drop_epochs():
    """Инвариант N6: эпоха, пересекающая зону артефакта, исключается из нарезки.

    До префикса BAD_ из 20 эпох с двумя зонами оставалось 19 (зоны ни на что не
    влияли); с префиксом отбраковываются все пересекающиеся (замер: 15/20).
    """
    data = _noise(20.0)
    # Два всплеска: секунды 2 и 5 — эпохи 2..3 и 5..6 (окна 1 с) пересекают зоны
    for sec in (2.0, 5.0):
        data[:, int(sec * _SFREQ): int((sec + 0.2) * _SFREQ)] = 500e-6

    raw = _raw(data)
    annotations, stats = detect_artifacts(raw, settings, pp_threshold_uv=100.0, run_ica=False)
    assert stats["by_type"]["peak_to_peak"] >= 2

    raw.set_annotations(annotations)
    events = mne.make_fixed_length_events(raw, duration=1.0, first_samp=0)
    epochs = mne.Epochs(
        raw, events, tmin=0, tmax=1.0, baseline=None, preload=True, verbose=False,
    )

    # Ожидание — не константа, а ровно «20 минус эпохи, пересекающие зоны»:
    # тест ловит и «зоны не влияют» (N6), и «зоны влияют не на те эпохи».
    zones = [(z["onset_sec"], z["onset_sec"] + z["duration_sec"]) for z in stats["zones"]]
    expected_kept = sum(
        1 for start in range(20)
        if not any(onset <= start + 1.0 and start <= end for onset, end in zones)
    )
    assert len(epochs) == expected_kept < 20
