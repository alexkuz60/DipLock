"""События записи и событийная нарезка (N2, шаг 2.7).

Источники событий: аннотации EDF+ (TAL) и маркеры стим-каналов — оба сводятся
к аннотациям ``raw.annotations`` (`services/edf_events.py`). Здесь проверяется:
паспорт несёт события, нарезка аннотации файла **объединяет**, а не перетирает
(N2), и режим нарезки «по событиям» даёт окна вокруг моментов события (ERP).
"""
import shutil

import mne
import numpy as np
import pytest

from app.core.config import settings
from app.services.edf_events import attach_stim_annotations, record_events
from app.services.epoch_segmenter import segment_epochs, segment_epochs_events
from app.services.recordings import (
    ensure_record_events,
    read_recording_meta,
    read_sidecar,
    recording_registry,
)
from tests.conftest import write_minimal_edf


def _raw_with_stim(sfreq=100.0, duration=5.0):
    """RawArray: ЭЭГ-канал + стим-канал Status с триггерами 5 и 7."""
    n = int(sfreq * duration)
    stim = np.zeros(n)
    stim[int(1.0 * sfreq)] = 5
    stim[int(3.0 * sfreq)] = 7
    info = mne.create_info(["C3", "Status"], sfreq, ["eeg", "stim"])
    return mne.io.RawArray(np.vstack([np.zeros(n), stim]), info, verbose=False)


def test_attach_stim_annotations_extracts_markers_and_drops_channel():
    """Стим-канал → аннотации STIM/<код>; канал с записи удаляется (N2)."""
    raw = _raw_with_stim()
    dropped = attach_stim_annotations(raw)

    assert dropped == ["Status"]
    assert list(raw.ch_names) == ["C3"]
    descriptions = list(raw.annotations.description)
    assert sorted(descriptions) == ["STIM/5", "STIM/7"]
    onsets = {
        desc: round(float(onset), 2)
        for onset, desc in zip(raw.annotations.onset, descriptions, strict=True)
    }
    assert onsets == {"STIM/5": 1.0, "STIM/7": 3.0}


def test_attach_stim_annotations_merges_file_annotations():
    """Аннотации файла не перетираются маркерами стим-канала (N2: объединять)."""
    raw = _raw_with_stim()
    raw.set_annotations(mne.Annotations([2.0], [0.5], ["Sound/On"]), verbose=False)
    attach_stim_annotations(raw)

    assert set(raw.annotations.description) == {"Sound/On", "STIM/5", "STIM/7"}


def test_attach_stim_annotations_without_stim_is_noop():
    """Запись без стим-каналов не меняется."""
    info = mne.create_info(["C3"], 100.0, "eeg")
    raw = mne.io.RawArray(np.zeros((1, 500)), info, verbose=False)
    assert attach_stim_annotations(raw) == []
    assert len(raw.annotations) == 0


def test_record_events_sorted_without_bad_and_with_source():
    """События отсортированы, BAD_ исключены (отбраковка — не события), source честный."""
    info = mne.create_info(["C3"], 100.0, "eeg")
    raw = mne.io.RawArray(np.zeros((1, 500)), info, verbose=False)
    raw.set_annotations(
        mne.Annotations(
            [3.0, 1.0, 2.0], [0.0, 0.2, 0.0],
            ["STIM/5", "BAD_peak_to_peak", "Sound/On"],
        ),
        verbose=False,
    )
    events, counts = record_events(raw)

    assert [e["description"] for e in events] == ["Sound/On", "STIM/5"]
    assert [e["onset"] for e in events] == [2.0, 3.0]
    assert events[0]["source"] == "annotation"
    assert events[1]["source"] == "stim"
    assert events[0]["duration"] == 0.0
    # BAD_ не считается событием и в счётчиках
    assert counts == {"Sound/On": 1, "STIM/5": 1}


def test_record_events_cap_keeps_counts():
    """Список событий режется по cap, счётчики считаются по всем."""
    info = mne.create_info(["C3"], 100.0, "eeg")
    raw = mne.io.RawArray(np.zeros((1, 5000)), info, verbose=False)
    raw.set_annotations(
        mne.Annotations([float(i) for i in range(5)], [0.0] * 5, ["STIM/1"] * 5),
        verbose=False,
    )
    events, counts = record_events(raw, cap=2)

    assert len(events) == 2
    assert counts == {"STIM/1": 5}


def test_read_recording_meta_reads_tal_annotations(tmp_path):
    """Паспорт EDF+ несёт аннотации TAL: события и счётчики по описаниям."""
    path = tmp_path / "tal.edf"
    sfreq = 100.0
    t = np.arange(int(4 * sfreq)) / sfreq
    data = np.vstack([np.sin(2 * np.pi * 10 * t) * 20] * 5)
    write_minimal_edf(
        path, list(settings.standard_channels[:5]), data, sfreq,
        annotations=[(1.0, 0.0, "STIM/5"), (2.0, 0.5, "Sound/On"), (3.0, 0.0, "STIM/5")],
    )
    meta = read_recording_meta(str(path), settings, "tal.edf")

    assert meta["event_counts"] == {"STIM/5": 2, "Sound/On": 1}
    assert [e["description"] for e in meta["events"]] == ["STIM/5", "Sound/On", "STIM/5"]
    assert meta["events"][1]["duration"] == 0.5
    # source — по префиксу STIM/ (дизайн `edf_events.py`): описание события
    # «STIM/5» маркируется как маркер, остальное — аннотация файла
    assert meta["events"][0]["source"] == "stim"
    assert meta["events"][1]["source"] == "annotation"


def test_read_recording_meta_reads_stim_markers(tmp_path):
    """Стим-канал Status → события STIM/*; канал исчезает из списков канала."""
    path = tmp_path / "stim.edf"
    sfreq = 100.0
    n = int(4 * sfreq)
    t = np.arange(n) / sfreq
    eeg = np.vstack([np.sin(2 * np.pi * 10 * t) * 20] * 5)
    stim = np.zeros(n)
    stim[int(1.0 * sfreq)] = 5
    stim[int(2.5 * sfreq)] = 7
    data = np.vstack([eeg, stim])
    write_minimal_edf(
        path, [*settings.standard_channels[:5], "Status"], data, sfreq,
    )
    meta = read_recording_meta(str(path), settings, "stim.edf")

    assert meta["event_counts"] == {"STIM/5": 1, "STIM/7": 1}
    assert meta["events"][0]["source"] == "stim"
    assert "Status" not in meta["channels"]
    assert "Status" not in meta["unmatched_channels"]
    assert any("Маркеры стим-каналов" in w for w in meta["warnings"])


def test_ensure_record_events_backfills_old_sidecar(tmp_path, edf_file):
    """Старый сайдкар без ключа events дочитывается лениво и переписывается."""
    upload_dir = tmp_path / "rec-old"
    upload_dir.mkdir()
    target = upload_dir / edf_file.name
    shutil.copyfile(edf_file, target)
    recording = recording_registry.register(
        str(target), str(upload_dir), edf_file.name, settings,
    )
    # Сайдкар до шага 2.7: событий в паспорте нет
    recording.meta.pop("events", None)
    recording.meta.pop("event_counts", None)

    ensure_record_events(recording, settings)

    assert "events" in recording.meta
    assert recording.meta["events"] == []
    assert read_sidecar(str(upload_dir))["meta"]["events"] == []


def test_segment_epochs_keeps_file_annotations(raw_eeg):
    """Нарезка объединяет аннотации файла с артефактными, а не перетирает их (N2)."""
    raw_eeg.set_annotations(
        mne.Annotations([1.2], [0.2], ["BAD_file_zone"]),
        verbose=False,
    )
    raw_eeg.annotations.append(2.5, 0.0, "STIM/5")
    artifact = mne.Annotations([0.5], [0.05], ["BAD_peak_to_peak"])

    segment_epochs(raw_eeg, artifact, epoch_length_ms=1000.0)

    descriptions = list(raw_eeg.annotations.description)
    assert "BAD_file_zone" in descriptions
    assert "STIM/5" in descriptions
    assert "BAD_peak_to_peak" in descriptions
    # Файловая BAD_-зона роняет эпоху 1 (1–2 с) наравне с нашими детекторами
    epochs = segment_epochs(raw_eeg, mne.Annotations([], [], []), epoch_length_ms=1000.0)
    assert any("BAD_file_zone" in log for log in epochs.drop_log)


def test_segment_epochs_events_windows_around_events(raw_eeg):
    """Окна [tmin, tmax] вокруг моментов события; полный список событий возвращается."""
    raw_eeg.set_annotations(
        mne.Annotations([1.0, 2.5], [0.0, 0.0], ["STIM/5", "STIM/5"]),
        verbose=False,
    )
    epochs, events = segment_epochs_events(
        raw_eeg, mne.Annotations([], [], []),
        event_id="STIM/5", tmin=-0.2, tmax=0.8,
    )

    assert len(events) == 2
    assert len(epochs) == 2
    assert epochs.tmin == pytest.approx(-0.2)
    assert epochs.tmax == pytest.approx(0.8)


def test_segment_epochs_events_rejects_bad_epochs(raw_eeg):
    """Эпоха, пересекающая BAD_ (в т.ч. файловую), исключается и при событийном режиме."""
    raw_eeg.set_annotations(
        mne.Annotations([1.0, 2.5], [0.0, 0.0], ["STIM/5", "STIM/5"]),
        verbose=False,
    )
    raw_eeg.annotations.append(1.1, 0.1, "BAD_file_zone")

    epochs, events = segment_epochs_events(
        raw_eeg, mne.Annotations([], [], []),
        event_id="STIM/5", tmin=-0.2, tmax=0.8,
    )

    assert len(events) == 2
    assert len(epochs) == 1
    assert len(epochs.drop_log) == 2


def test_segment_epochs_events_unknown_event_lists_available(raw_eeg):
    """«События не найдены» перечисляет доступные описания — не «странная ошибка»."""
    raw_eeg.set_annotations(
        mne.Annotations([1.0], [0.0], ["Sound/On"]), verbose=False,
    )
    with pytest.raises(ValueError) as excinfo:
        segment_epochs_events(
            raw_eeg, mne.Annotations([], [], []),
            event_id="STIM/9", tmin=-0.2, tmax=0.8,
        )
    assert "STIM/9" in str(excinfo.value)
    assert "Sound/On" in str(excinfo.value)


def test_segment_epochs_events_invalid_window_raises(raw_eeg):
    """tmax ≤ tmin и пустое описание — понятные ошибки, а не падение MNE."""
    raw_eeg.set_annotations(
        mne.Annotations([1.0], [0.0], ["STIM/5"]), verbose=False,
    )
    with pytest.raises(ValueError, match="Окно эпохи некорректно"):
        segment_epochs_events(
            raw_eeg, mne.Annotations([], [], []),
            event_id="STIM/5", tmin=0.5, tmax=0.5,
        )
    with pytest.raises(ValueError, match="требует описание события"):
        segment_epochs_events(
            raw_eeg, mne.Annotations([], [], []),
            event_id="  ", tmin=-0.2, tmax=0.8,
        )

