"""Тесты сигналов записи (срез 2.5): float32-огибающая, уровни, ETag.

Контейнер проверяется по формату из ``RecordingSignalsHeader``: magic, длина
заголовка, JSON-заголовок и канало-мажорный payload. Отдельно проверяется
главное свойство пирамиды — пик артефакта не теряется при прореживании
(декация min/max, а не «каждый N-й отсчёт»).
"""
import json
import os
import shutil
import struct

import numpy as np
import pytest

from app.core.config import settings
from app.services.recording_signals import clear_signal_cache
from app.services.recordings import recording_registry
from tests.conftest import write_minimal_edf


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра, каталогов загрузок и кэша пирамиды между тестами."""
    recording_registry.clear()
    clear_signal_cache(settings)
    before = _upload_dirs()
    yield
    recording_registry.clear()
    clear_signal_cache(settings)
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _upload(client, path, name="probe.edf"):
    with open(path, "rb") as fh:
        response = client.post(
            "/api/v1/recordings", files={"file": (name, fh, "application/octet-stream")}
        )
    assert response.status_code == 201, response.text
    return response.json()


def _parse(body: bytes) -> tuple[dict, np.ndarray]:
    """Разбирает контейнер сигналов: (заголовок, payload float32 [строки, точки])."""
    assert body[:4] == b"DPS1", body[:8]
    header_len = struct.unpack_from("<I", body, 4)[0]
    header = json.loads(body[8 : 8 + header_len].decode("utf-8"))
    payload = np.frombuffer(body[8 + header_len :], dtype="<f4")
    rows = header["arrays_per_channel"] * len(header["channels"])
    return header, payload.reshape(rows, header["n_points"])


@pytest.fixture
def synth_edf(tmp_path):
    """Фабрика EDF: ``synth_edf(name, data_uv, sfreq)`` → путь к файлу."""

    def make(name: str, data_uv: np.ndarray, sfreq: float):
        path = tmp_path / name
        write_minimal_edf(path, list(settings.standard_channels[:5]), data_uv, sfreq)
        return path

    return make


def test_signals_short_recording_is_returned_without_decimation(client, edf_file):
    meta = _upload(client, edf_file)

    response = client.get(f"/api/v1/recordings/{meta['recording_id']}/signals?level=1")

    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-signal-level"] == "1"
    assert response.headers["etag"]

    header, payload = _parse(response.content)
    assert header["recording_id"] == meta["recording_id"]
    assert header["level"] == 1
    assert header["channels"] == meta["channels"]
    assert header["decimated"] is False
    assert header["arrays_per_channel"] == 1
    assert header["n_points"] == payload.shape[1]
    assert header["sfreq"] == pytest.approx(250.0)
    assert header["duration_sec"] == pytest.approx(4.0)

    # Масштаб: 5 каналов, синусы 20 мкВ со смещением i (см. conftest.edf_file)
    assert payload.max() == pytest.approx(24.0, abs=1.0)
    assert payload.min() == pytest.approx(-20.0, abs=1.0)


def test_signals_etag_gives_304_on_repeat(client, edf_file):
    meta = _upload(client, edf_file)
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1"

    first = client.get(url)
    repeat = client.get(url, headers={"If-None-Match": first.headers["etag"]})

    assert repeat.status_code == 304
    assert repeat.content == b""


def test_signals_invalid_level_and_unknown_recording(client, edf_file):
    meta = _upload(client, edf_file)

    bad_level = client.get(f"/api/v1/recordings/{meta['recording_id']}/signals?level=3")
    assert bad_level.status_code == 400
    assert "не поддерживается" in bad_level.json()["detail"]

    missing = client.get("/api/v1/recordings/nope/signals?level=1")
    assert missing.status_code == 404


def test_decimation_preserves_artifact_peak(client, synth_edf, monkeypatch):
    """Пик 300 мкВ должен остаться максимумом огибающей при сильном прореживании."""
    # Бюджет 50 точек на канал: 1000 отсчётов режутся корзинами по 20
    monkeypatch.setattr(settings, "signal_base_points", 50)

    sfreq = 250.0
    n_times = int(4 * sfreq)
    data = np.zeros((5, n_times))
    t = np.arange(n_times) / sfreq
    for channel in range(5):
        data[channel] = np.sin(2 * np.pi * (6 + channel) * t) * 20
    data[0, n_times // 2] = 300.0
    path = synth_edf("spike.edf", data, sfreq)

    meta = _upload(client, path, name="spike.edf")
    response = client.get(
        f"/api/v1/recordings/{meta['recording_id']}/signals?level=1"
    )

    assert response.status_code == 200, response.text
    header, payload = _parse(response.content)
    assert header["decimated"] is True
    assert header["arrays_per_channel"] == 2
    assert header["n_points"] == 50
    # Строки канала 0: [min, max] — пик сохранён, а не «срезан» прореживанием
    assert payload[1].max() == pytest.approx(300.0, abs=1.0)
    assert payload[0].min() >= -30.0


def test_signals_level_is_cached_on_disk(client, edf_file):
    meta = _upload(client, edf_file)
    client.get(f"/api/v1/recordings/{meta['recording_id']}/signals?level=2")

    cache_path = os.path.join(
        settings.cache_dir, "signals", meta["recording_id"], "level2.bin"
    )
    assert os.path.isfile(cache_path)
    assert os.path.getsize(cache_path) > 0


def test_dropped_recording_removes_signal_cache(client, edf_file):
    """Кэш пирамиды не должен переживать вытеснение записи (TTL/лимит истории)."""
    meta = _upload(client, edf_file)
    client.get(f"/api/v1/recordings/{meta['recording_id']}/signals?level=1")
    cache_dir = os.path.join(settings.cache_dir, "signals", meta["recording_id"])
    assert os.path.isdir(cache_dir)

    recording_registry.clear()

    assert not os.path.exists(cache_dir)
