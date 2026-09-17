"""Тесты кэша подготовленного сигнала (A4, этап 2).

Контракт, который здесь фиксируется:

* повтор с теми же параметрами **не читает EDF** (в этом и смысл кэша);
* другая полоса/notch/референс — промах: подменять сигнал одного расчёта
  сигналом другого нельзя;
* наружу уходит **копия**: ``segment_epochs`` ставит аннотации на полученный
  сигнал, и они не должны «протекать» в соседний расчёт;
* вытеснение записи из реестра очищает память (кэш — производная записи).
"""
import time

import mne
import numpy as np
import pytest

from app.core.config import settings
from app.services import prepared_signal
from app.services.edf_loader import load_edf
from app.services.epoch_segmenter import segment_epochs
from app.services.prepared_signal import (
    clear_prepared_cache,
    prepared_cache_stats,
    prepared_raw,
)
from app.services.preprocess import PreprocessParams, run_preprocess
from app.services.recordings import Recording, recording_registry


def _recording(edf_file, recording_id: str = "prep-test") -> Recording:
    """Запись поверх тестового EDF: кэшу нужен только id + путь к файлу."""
    return Recording(
        recording_id=recording_id,
        filename="probe.edf",
        path=str(edf_file),
        upload_dir=str(edf_file.parent),
        created_at=time.time(),
        meta={"sfreq": 250.0, "duration_sec": 4.0},
    )


@pytest.fixture(autouse=True)
def clean_state():
    """Кэш между тестами пуст: счётчики и записи не должны перетекать."""
    recording_registry.clear()
    clear_prepared_cache()
    yield
    recording_registry.clear()
    clear_prepared_cache()


@pytest.fixture
def counting_loads(monkeypatch):
    """Считает настоящие чтения EDF внутри кэша (сколько раз файл реально открыт)."""
    calls: list = []
    real_load = prepared_signal.load_edf

    def counting(*args, **kwargs):
        calls.append(args)
        return real_load(*args, **kwargs)

    monkeypatch.setattr(prepared_signal, "load_edf", counting)
    return calls



def test_repeat_with_same_params_does_not_read_edf_again(edf_file, counting_loads):
    recording = _recording(edf_file)
    hits_before = prepared_cache_stats()["hits"]

    first = prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    second = prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)

    assert len(counting_loads) == 1, "второй вызов обязан попасть в кэш"
    assert prepared_cache_stats()["hits"] == hits_before + 1
    np.testing.assert_allclose(first.get_data(), second.get_data())


def test_other_band_is_a_miss_and_keeps_its_own_filter(edf_file, counting_loads):
    """Другая полоса — другой сигнал: кэш обязан промахнуться и посчитать заново."""
    recording = _recording(edf_file)

    banded = prepared_raw(recording, settings, l_freq=8.0, h_freq=13.0)
    baseline = prepared_raw(recording, settings, l_freq=None, h_freq=None)

    assert len(counting_loads) == 2
    expected = load_edf(
        str(edf_file), settings.standard_channels,
        l_freq=8.0, h_freq=13.0, units=settings.edf_units,
    )
    np.testing.assert_allclose(banded.get_data(), expected.get_data(), atol=1e-12)
    assert not np.allclose(banded.get_data(), baseline.get_data())


def test_notch_and_reference_are_part_of_the_key(edf_file, counting_loads):
    recording = _recording(edf_file)

    prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0, notch_hz=50.0)
    prepared_raw(
        recording, settings, l_freq=1.0, h_freq=40.0, notch_hz=50.0,
        reference_channels=["Fp1", "Fp2"],
    )

    assert len(counting_loads) == 3


def test_mutating_returned_signal_does_not_touch_the_cache(edf_file):
    """Кэш хранит собственную копию: арифметика вызывающего не портит сигнал."""
    recording = _recording(edf_file)

    first = prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    first.apply_function(lambda data: data * 0.0, verbose=False)
    assert float(np.max(np.abs(first.get_data()))) == 0.0

    second = prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    assert float(np.max(np.abs(second.get_data()))) > 0.0


def test_annotations_do_not_leak_between_consumers(edf_file):
    """`segment_epochs` мутирует сигнал аннотациями — соседний расчёт их не видит."""
    recording = _recording(edf_file)

    raw = prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    segment_epochs(raw, mne.Annotations([0.0], [0.1], ["artifact"]), epoch_length_ms=1000.0)
    assert len(raw.annotations) == 1

    again = prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    assert len(again.annotations) == 0


def test_cache_size_limits_entries_and_evicts_oldest(edf_file, monkeypatch, counting_loads):
    """LRU: за лимитом наборов память не растёт, самый старый набор вытесняется."""
    monkeypatch.setattr(settings, "prepared_signal_cache_size", 1)
    recording = _recording(edf_file)
    stats_before = prepared_cache_stats()
    assert prepared_cache_stats(settings)["limit"] == 1  # подмена лимита состоялась

    prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    prepared_raw(recording, settings, l_freq=8.0, h_freq=13.0)
    stats = prepared_cache_stats(settings)

    assert stats["entries"] == 1
    assert stats["evictions"] == stats_before["evictions"] + 1
    # Вытесненный набор читается заново — кэш не отдаёт «что угодно» вместо данных
    prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    assert len(counting_loads) == 3


def test_disabled_cache_reads_edf_every_time(edf_file, monkeypatch, counting_loads):
    """``PREPARED_SIGNAL_CACHE_SIZE=0`` — предсказуемый режим «как до этапа 2»."""
    recording = _recording(edf_file)
    prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)  # прогреваем кэш
    assert prepared_cache_stats()["entries"] == 1

    monkeypatch.setattr(settings, "prepared_signal_cache_size", 0)
    prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)
    prepared_raw(recording, settings, l_freq=1.0, h_freq=40.0)

    assert len(counting_loads) == 3
    # Выключенный кэш не держит память: лимит 0 вытесняет уже накопленное
    assert prepared_cache_stats(settings)["entries"] == 0


def test_clear_prepared_cache_drops_one_recording_only(edf_file):
    first = _recording(edf_file, recording_id="first")
    second = _recording(edf_file, recording_id="second")
    prepared_raw(first, settings, l_freq=1.0, h_freq=40.0)
    prepared_raw(second, settings, l_freq=1.0, h_freq=40.0)
    assert prepared_cache_stats()["entries"] == 2

    clear_prepared_cache("first")

    assert prepared_cache_stats()["entries"] == 1
    clear_prepared_cache()
    assert prepared_cache_stats()["entries"] == 0


def test_evicting_recording_clears_prepared_cache(edf_file, client):
    """Вытеснение записи из реестра чистит и RAM-кэш сигнала (A4)."""
    with open(edf_file, "rb") as fh:
        response = client.post(
            "/api/v1/recordings", files={"file": ("probe.edf", fh, "application/octet-stream")},
        )
    assert response.status_code == 201, response.text
    recording = recording_registry.get(response.json()["recording_id"])
    assert recording is not None

    run_preprocess(
        recording, settings,
        PreprocessParams(stage="filter", filter_band=(1.0, 40.0)),
        lambda *args, **kwargs: None,
    )
    assert prepared_cache_stats()["entries"] == 1

    recording_registry.clear()

    assert prepared_cache_stats()["entries"] == 0
