"""Тесты персиста подготовленного массива по полосе (Фаза B).

Контракт, который здесь фиксируется (п.16 ``docs/rules/data-and-caches.md``):

* первый вызов готовит сигнал и кладёт файл на диск, повторный (после
  сброса RAM-кэша — «рестарт процесса») читает диск **без чтения EDF**;
* ключ — «запись + ``band_key`` + notch + референс»: другая полоса/сеть/
  ссылка дают другой файл;
* битый/чужой файл — промах с пересчётом, а не ошибка и не «что-нибудь»;
* вытеснение записи чистит персист (``_drop_signal_cache``) — он производная
  записи, а не самостоятельные данные.
"""
import os
import time

import numpy as np
import pytest

from app.core.config import settings
from app.services import prepared_persist, prepared_signal
from app.services.prepared_persist import (
    PreparedPersistError,
    band_signature,
    clear_persist_cache,
    load_persisted,
    persist_path,
    prepared_array,
)
from app.services.prepared_signal import clear_prepared_cache
from app.services.recordings import Recording, recording_registry


def _recording(edf_file, recording_id: str = "persist-test") -> Recording:
    """Запись поверх тестового EDF: персисту нужен id + путь к файлу."""
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
    """Персист и RAM-кэш между тестами пусты: файлы не должны перетекать."""
    clear_persist_cache(settings)
    clear_prepared_cache()
    yield
    clear_persist_cache(settings)
    clear_prepared_cache()


@pytest.fixture
def counting_loads(monkeypatch):
    """Считает настоящие чтения EDF внутри RAM-кэша подготовленного сигнала."""
    calls: list = []
    real_load = prepared_signal.load_edf

    def counting(*args, **kwargs):
        calls.append(args)
        return real_load(*args, **kwargs)

    monkeypatch.setattr(prepared_signal, "load_edf", counting)
    return calls


def test_first_build_persists_and_survives_ram_cache(edf_file, counting_loads):
    """Первый вызов пишет файл; повтор после сброса RAM-кэша не читает EDF."""
    recording = _recording(edf_file)

    first = prepared_array(recording, settings, "alpha")
    path = persist_path(
        settings, recording.recording_id, "alpha",
        band_signature(settings, "alpha", None, None, "average"),
    )
    assert os.path.isfile(path), "первый вызов обязан положить файл на диск"
    assert len(counting_loads) == 1
    assert first.data.dtype == np.float32
    assert first.channels

    # «Рестарт процесса»: RAM-кэш пуст, файл на диске жив
    clear_prepared_cache()
    second = prepared_array(recording, settings, "alpha")

    assert len(counting_loads) == 1, "повтор обязан читать диск, а не EDF"
    np.testing.assert_allclose(second.data, first.data, atol=1e-9)
    assert second.channels == first.channels
    assert second.sfreq == first.sfreq


def test_key_separates_band_notch_and_reference(edf_file):
    """Другая полоса/сеть/референс — другой файл: чужой массив не отдаётся."""
    recording = _recording(edf_file)
    base = prepared_array(recording, settings, "alpha")
    other_band = prepared_array(recording, settings, "beta")
    with_notch = prepared_array(recording, settings, "alpha", notch_hz=50.0)

    root = os.path.join(settings.cache_dir, "prepared", recording.recording_id)
    files = sorted(os.listdir(root))
    assert len(files) == 3

    # Полоса реально своя (фильтр применён), а не подпись в имени файла
    assert not np.allclose(other_band.data, base.data, atol=1e-6)
    # Notch отдельный файл держит всегда, но данные меняет только если в полосе
    # есть компоненты сети: у alpha (8–16) после полосового 50 Гц уже нет, и
    # массивы численно совпадают — ключ, а не содержимое, разводит их.
    assert with_notch.channels == base.channels
    # Референс меняет ключ той же полосы и само значение сигнала
    custom_ref = prepared_array(
        recording, settings, "alpha",
        reference_channels=list(settings.standard_channels[:2]),
    )
    assert len(os.listdir(root)) == 4
    assert not np.allclose(custom_ref.data, base.data, atol=1e-6)


def test_unknown_band_key_is_an_error(edf_file):
    """Произвольный band_key не адресует персист: ключ — только из /meta."""
    recording = _recording(edf_file)

    with pytest.raises(PreparedPersistError) as excinfo:
        prepared_array(recording, settings, "alpha_1_40")

    assert "band_key" in str(excinfo.value)


def test_corrupt_file_is_a_miss_not_a_crash(edf_file, counting_loads):
    """Битый файл — промах с пересчётом: кэш не может сломать расчёт (п.4)."""
    recording = _recording(edf_file)
    signature = band_signature(settings, "alpha", None, None, "average")
    path = persist_path(settings, recording.recording_id, "alpha", signature)

    first = prepared_array(recording, settings, "alpha")
    assert os.path.isfile(path)
    # Обрезанный payload: заголовок валиден, данных не хватает
    with open(path, "rb") as fh:
        blob = fh.read()
    with open(path, "wb") as fh:
        fh.write(blob[: len(blob) // 2])
    clear_prepared_cache()

    second = prepared_array(recording, settings, "alpha")

    # Один промах на пересчёт: первый вызов уже прочитал EDF один раз
    assert len(counting_loads) == 2, "битый файл обязан пересчитаться, а не упасть"
    np.testing.assert_allclose(second.data, first.data, atol=1e-9)


def test_failed_write_does_not_break_build(monkeypatch, edf_file, counting_loads):
    """Сбой записи кэша (False от cache_write) — расчёт продолжается (п.4)."""
    recording = _recording(edf_file)
    monkeypatch.setattr(prepared_persist, "cache_write", lambda *args, **kwargs: False)

    array = prepared_array(recording, settings, "alpha")

    assert array.data.size > 0
    assert len(counting_loads) == 1


def test_clear_and_eviction_drop_persist(edf_file, client):
    """Очистка одной записи и вытеснение реестра убирают файлы персиста."""
    first = _recording(edf_file, recording_id="first")
    second = _recording(edf_file, recording_id="second")
    prepared_array(first, settings, "alpha")
    prepared_array(second, settings, "alpha")
    root = os.path.join(settings.cache_dir, "prepared")
    assert sorted(os.listdir(root)) == ["first", "second"]

    clear_persist_cache(settings, "first")
    assert os.listdir(root) == ["second"]

    # Вытеснение записи через реестр чистит и персист (п.3)
    with open(edf_file, "rb") as fh:
        response = client.post(
            "/api/v1/recordings", files={"file": ("probe.edf", fh, "application/octet-stream")},
        )
    assert response.status_code == 201, response.text
    recording = recording_registry.get(response.json()["recording_id"])
    assert recording is not None
    prepared_array(recording, settings, "alpha")
    recording_registry.clear()

    assert not os.path.isdir(os.path.join(root, recording.recording_id))


def test_load_persisted_rejects_foreign_header(edf_file):
    """Файл с чужим ключом (совпавший путь) — промах, а не чужие данные."""
    recording = _recording(edf_file)
    prepared_array(recording, settings, "alpha")
    signature = band_signature(settings, "alpha", None, None, "average")
    path = persist_path(settings, recording.recording_id, "alpha", signature)

    # Читаем «от имени» другой полосы: заголовок не совпадёт
    assert load_persisted(settings, recording.recording_id, "beta", signature) is None
    # И с несовпадающей сигнатурой той же полосы
    assert load_persisted(settings, recording.recording_id, "alpha", "000000000000") is None
    assert os.path.isfile(path)
