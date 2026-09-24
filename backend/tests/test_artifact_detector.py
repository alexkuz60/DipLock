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


def _mimic_raw(duration_sec: float = 20.0, seed: int = 0) -> mne.io.RawArray:
    """Шум + «моргания» синфазно на Fp1/Fp2 (N8) — синтетика ICA-ветки."""
    names = ["Fp1", "Fp2", "C3", "C4"]
    rng = np.random.default_rng(seed)
    n = int(_SFREQ * duration_sec)
    data = rng.standard_normal((len(names), n)) * 2e-6
    mimic = np.zeros(n)
    for t in range(1, 10):
        onset = int(t * 2.0 * _SFREQ)
        burst = 80e-6 * np.exp(-np.arange(int(0.3 * _SFREQ)) / (0.05 * _SFREQ))
        mimic[onset: onset + burst.size] += burst
    data[0] += mimic
    data[1] += mimic
    return mne.io.RawArray(data, mne.create_info(names, _SFREQ, "eeg"), verbose=False)


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


# ---------- Каталог видов (11): новые детекторы, правило BAD_, числа QC ----------


def test_bad_rule_annotations_only_reject_kinds():
    """Правило BAD_: аннотации дают только reject-виды, и все — с префиксом BAD_.

    Информационные виды (мышечный, сетевой, окулярный, ЭКГ, ICA-EOG) зонами
    помечают участки для UI/QC, но эпоху ронять не могут: в аннотации raw они
    не попадают вовсе.
    """
    from app.services.artifact_detector import (
        ANNOTATION_DESC,
        ARTIFACT_KINDS,
        EPOCH_REJECT_KINDS,
    )

    assert set(ANNOTATION_DESC) == set(EPOCH_REJECT_KINDS)
    assert all(desc.startswith("BAD_") for desc in ANNOTATION_DESC.values())
    informational = {"muscle_emg", "line_noise", "ocular", "ecg", "ica_eog"}
    assert EPOCH_REJECT_KINDS | informational == set(ARTIFACT_KINDS)
    assert not informational & EPOCH_REJECT_KINDS


def test_detects_break_pop_and_clipping():
    """NaN-разрыв, pop-всплеск и клиппинг у предела АЦП — три reject-вида."""
    data = _noise(10.0)
    data[0, int(2 * _SFREQ): int(3 * _SFREQ)] = np.nan  # разрыв C3: секунда NaN
    data[1, int(5 * _SFREQ)] += 300e-6  # pop C4: ступенька мгновенно отыгрывается
    data[2, int(6 * _SFREQ): int(7 * _SFREQ)] = 400e-6  # клиппинг Fz: плоско на rail

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    kinds = {zone["kind"] for zone in stats["zones"]}
    assert {"break", "electrode_pop", "clipping"} <= kinds
    for kind in ("break", "electrode_pop", "clipping"):
        assert stats["by_type"][kind] >= 1


def test_line_noise_zones_and_level():
    """50 Гц + гармоника на канале — зоны line_noise и уровень пик/фон (QC)."""
    t = np.arange(int(_SFREQ * 20.0)) / _SFREQ
    data = _noise(20.0)
    data[0] += 10e-6 * np.sin(2 * np.pi * 50 * t)  # фундаментал
    data[0] += 4e-6 * np.sin(2 * np.pi * 100 * t)  # гармоника

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    line_zones = [z for z in stats["zones"] if z["kind"] == "line_noise"]
    assert line_zones, "сетевой шум 50 Гц должен быть найден"
    assert line_zones[0]["channels"] == ["C3"]
    assert stats["by_type"]["line_noise"] == len(line_zones)
    assert stats["line_noise_level"] >= settings.line_noise_ratio


def test_ocular_blink_detected_on_frontal():
    """Моргание (медленная волна 300 мс на Fp1) — зона ocular без аннотаций."""
    n = int(_SFREQ * 10.0)
    names = ["Fp1", "Fp2", "C3", "C4"]
    data = np.random.default_rng(1).standard_normal((4, n)) * 1e-6
    center = int(4 * _SFREQ)
    half = int(0.15 * _SFREQ)
    data[0, center - half: center + half] += 120e-6 * np.hanning(2 * half)

    raw = mne.io.RawArray(data, mne.create_info(names, _SFREQ, "eeg"), verbose=False)
    annotations, stats = detect_artifacts(raw, settings, run_ica=False)

    ocular = [z for z in stats["zones"] if z["kind"] == "ocular"]
    assert ocular and ocular[0]["channels"] == ["Fp1"]
    assert not any("ocular" in d for d in annotations.description)


def test_ecg_rhythm_detected_on_temporal():
    """Периодические QRS-пики на T7 (каждые 0.8 с) — зоны ecg по ритму."""
    n = int(_SFREQ * 20.0)
    names = ["T7", "T8", "C3", "C4"]
    data = np.random.default_rng(2).standard_normal((4, n)) * 1e-6
    for beat in range(int(20.0 / 0.8)):
        idx = int(beat * 0.8 * _SFREQ) + 100
        data[0, idx: idx + 3] += 60e-6  # острый QRS-импульс

    raw = mne.io.RawArray(data, mne.create_info(names, _SFREQ, "eeg"), verbose=False)
    _, stats = detect_artifacts(raw, settings, run_ica=False)

    ecg_zones = [z for z in stats["zones"] if z["kind"] == "ecg"]
    assert ecg_zones and ecg_zones[0]["channels"] == ["T7"]


def test_muscle_burst_detected():
    """Всплеск высоких частот (ЭМГ 300 мс, ×20 к шуму) — зона muscle_emg."""
    data = _noise(15.0)
    burst = slice(int(5 * _SFREQ), int(5.3 * _SFREQ))
    data[0, burst] += (
        np.random.default_rng(3).standard_normal(burst.stop - burst.start) * 20e-6
    )

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    assert stats["by_type"]["muscle_emg"] >= 1, "ЭМГ-всплеск должен быть найден"


def test_find_bad_channels_flags_noisy_and_dead():
    """Шумный (×20) и мёртвый (константа) каналы попадают в bad-список."""
    from app.services.artifact_detector import find_bad_channels

    data = _noise(10.0)
    data[0] *= 20.0  # C3: шумный
    data[1] = 0.0  # C4: мёртвый

    bads = find_bad_channels(_raw(data), settings.bad_channel_z)

    assert {"C3", "C4"} <= set(bads)
    assert not {"Fz", "Pz"} & set(bads)


def test_qc_summary_numbers():
    """good_data_percent, доли по типам, уровень 50 Гц и bad-каналы (числа QC)."""
    from app.services.artifact_detector import qc_summary

    zones = [
        {"kind": "peak_to_peak", "onset_sec": 0.0, "duration_sec": 2.0, "channels": ["C3"]},
        {"kind": "line_noise", "onset_sec": 0.0, "duration_sec": 10.0, "channels": ["C3"]},
        {"kind": "ica_eog", "onset_sec": 0.0, "duration_sec": 10.0, "channels": ["C3", "C4"]},
    ]
    qc = qc_summary(zones, ["C3", "C4"], 10.0, line_noise_level=6.2, bad_channels=["C3"])

    # C3: 2 с грязных из 10 (line_noise/ica_eog не считаются), C4: 0 → в среднем 10 %
    assert qc["good_data_percent"] == 90.0
    assert qc["artifact_share_by_kind"] == {"peak_to_peak": 0.1}
    assert qc["line_noise_level"] == 6.2
    assert qc["bad_channels"] == ["C3"]


# ---------- QC-светофор записи (шаг 2.2/N10): SNR, мёртвые, вердикт ----------


def test_find_dead_channels_sees_flat_only_before_reference():
    """Мёртвый канал виден ДО референса; средний референс его маскирует (2.2)."""
    from app.services.artifact_detector import find_dead_channels

    data = _noise(10.0)
    data[1] = 5e-6  # C4: отвалившийся электрод — константа с ненулевым уровнем

    raw = _raw(data)
    assert find_dead_channels(raw) == ["C4"]

    raw.set_eeg_reference("average", projection=False)
    # после референса константа стала «−средним остальных» — flat-line её не видит
    assert find_dead_channels(raw) == []


def test_channel_snr_db_separates_rhythm_from_hf_noise():
    """Тон 10 Гц даёт высокий SNR, белый шум — около нуля (шаг 2.2)."""
    from app.services.artifact_detector import channel_snr_db

    data = _noise(10.0)
    t = np.arange(data.shape[1]) / _SFREQ
    data[0] = 2e-5 * np.sin(2 * np.pi * 10.0 * t) + 1e-7 * data[0]  # C3: ритм

    snr = channel_snr_db(_raw(data))

    assert snr["C3"] > snr["C4"] + 20.0


def test_record_qc_status_worst_category_wins():
    """Светофор записи: худшая категория побеждает, причины собираются (2.2)."""
    from app.services.artifact_detector import record_qc_status

    status, reasons = record_qc_status(95.0, 1.5, 15.0, [], settings)
    assert (status, reasons) == ("ok", [])

    status, reasons = record_qc_status(60.0, 1.5, 8.0, ["C3"], settings)
    assert status == "warn"
    assert any("чистых данных" in r for r in reasons)
    assert any("SNR" in r for r in reasons)
    assert any("плохих каналов: 1" in r for r in reasons)

    status, reasons = record_qc_status(40.0, 9.0, 3.0, ["C3", "C4", "Fz"], settings)
    assert status == "bad"
    assert len(reasons) == 4


def test_qc_summary_carries_snr_and_dead():
    """SNR (медиана/минимум) и мёртвые каналы доходят до сводки (шаг 2.2)."""
    from app.services.artifact_detector import qc_summary

    qc = qc_summary(
        [], ["C3", "C4"], 10.0,
        snr_db_by_channel={"C3": 12.0, "C4": 4.5},
        dead_channels=["C4"],
    )

    assert qc["snr_db"] == 8.2
    assert qc["snr_db_min"] == 4.5
    assert qc["dead_channels"] == ["C4"]


def test_channel_qc_summary_includes_snr_and_dead():
    """Строка QC канала несёт SNR и признак мёртвого для иконок (шаг 2.2)."""
    from app.services.artifact_detector import channel_qc_summary

    summary = channel_qc_summary(
        [], ["C3", "C4"], 4.0,
        snr_db={"C3": 12.0}, dead_channels=["C4"],
    )

    assert summary[0]["snr_db"] == 12.0
    assert summary[0]["dead"] is False
    assert summary[1]["snr_db"] is None
    assert summary[1]["dead"] is True


# ---------- ICA-ветка (N8): достижима через фронтальный прокси ----------


def test_ica_detection_reachable_via_frontal_proxy():
    """N8: run_ica работает без EOG-каналов — мимику ловит прокси Fp1/Fp2.

    Зона ``ica_eog`` не создаётся (компоненты не привязаны ко времени, фидбэк
    24.09.2026) — наружу только счётчик ``by_type.ica_eog`` и ``ica_applied``.
    """
    _, stats = detect_artifacts(_mimic_raw(), settings, run_ica=True)

    assert stats["ica_applied"] is True
    assert stats["by_type"]["ica_eog"] >= 1
    assert not any(zone["kind"] == "ica_eog" for zone in stats["zones"])


def test_ica_detection_skipped_without_eog_or_frontal():
    """Ни EOG-каналов, ни фронтальных — ветка пропускается честно, без падения."""
    _, stats = detect_artifacts(_raw(_noise(10.0)), settings, run_ica=True)

    assert stats["ica_applied"] is False
    assert stats["by_type"]["ica_eog"] == 0


# ---------- N9 (шаг 2.3): robust z в скользящем окне, зоны p2p интервалами ----------


def test_zscore_sliding_window_kills_long_zones_on_level_shift():
    """Смещение уровня записи — не длинная зона выброса (N9, фидбэк 24.09.2026).

    «Длинные z-score-зоны после смены референса»: глобальная медиана/MAD
    помечала весь смещённый хвост одной зоной zscore_outlier и роняла эпохи.
    Скользящая «норма» следует за уровнем — длинных зон нет (короткие на стыке
    смещения допустимы).
    """
    data = _noise(60.0)
    data[:, int(40 * _SFREQ):] += 15e-6  # смещённый хвост записи

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    z_zones = [z for z in stats["zones"] if z["kind"] == "zscore_outlier"]
    assert all(z["duration_sec"] < 5.0 for z in z_zones)


def test_zscore_window_beyond_recording_falls_back_to_global():
    """Окно больше записи → глобальная оценка (фолбэк) видит хвост длинной зоной.

    Контраст к тесту выше: та же запись с окном 600 с даёт зону ≥ 15 с —
    значит длинные зоны снимало именно скользящее окно, а не случайность.
    """
    data = _noise(60.0)
    data[:, int(40 * _SFREQ):] += 15e-6
    cfg = settings.model_copy(update={"zscore_window_sec": 600.0})

    _, stats = detect_artifacts(_raw(data), cfg, run_ica=False)

    z_zones = [z for z in stats["zones"] if z["kind"] == "zscore_outlier"]
    assert any(z["duration_sec"] >= 15.0 for z in z_zones)


def test_zscore_still_catches_burst_inside_shifted_segment():
    """Сенситивность сохранена: всплеск 200 мкВ в смещённом хвосте — зона."""
    data = _noise(60.0)
    data[:, int(40 * _SFREQ):] += 15e-6
    data[:, int(45 * _SFREQ): int(45.1 * _SFREQ)] += 200e-6

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    z_zones = [z for z in stats["zones"] if z["kind"] == "zscore_outlier"]
    assert any(44.0 <= z["onset_sec"] <= 46.0 for z in z_zones)


def test_peak_to_peak_single_event_is_single_zone():
    """Перекрывающиеся окна события сливаются: всплеск = одна зона (N9).

    Окно 2 с с шагом 1 с попадало в событие 2–3 раза и раздувало
    ``by_type``/``total``: зона теперь — интервал покрытия, а не окно.
    """
    data = _noise(10.0)
    data[:, int(4 * _SFREQ): int(4.2 * _SFREQ)] += 250e-6  # всплеск на всех каналах

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    pp_zones = [z for z in stats["zones"] if z["kind"] == "peak_to_peak"]
    assert len(pp_zones) == 1
    assert stats["by_type"]["peak_to_peak"] == 1
    assert set(pp_zones[0]["channels"]) == set(_CHANNELS)
    assert pp_zones[0]["onset_sec"] < 4.0 < pp_zones[0]["onset_sec"] + pp_zones[0]["duration_sec"]


def test_peak_to_peak_two_events_are_two_zones():
    """Два далёких события — две зоны: слияние не склеивает разные всплески."""
    data = _noise(12.0)
    data[:, int(3 * _SFREQ): int(3.2 * _SFREQ)] += 250e-6
    data[:, int(9 * _SFREQ): int(9.2 * _SFREQ)] += 250e-6

    _, stats = detect_artifacts(_raw(data), settings, run_ica=False)

    assert stats["by_type"]["peak_to_peak"] == 2
