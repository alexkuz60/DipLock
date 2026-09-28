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


# --- Три слоя видимости (шаг 2 плана «слои видимости», 27.09.2026) ---


def test_signals_layer_defaults_to_raw(client, edf_file):
    """Без параметра layer — прежняя сырая пирамида: заголовок и шапка несут raw."""
    meta = _upload(client, edf_file)

    response = client.get(f"/api/v1/recordings/{meta['recording_id']}/signals?level=1")

    assert response.status_code == 200, response.text
    assert response.headers["x-signal-layer"] == "raw"
    header, _ = _parse(response.content)
    assert header["layer"] == "raw"
    assert header["channels"] == meta["channels"]


def test_signals_cleaned_layer_is_prepared_signal(client, edf_file):
    """Слой cleaned — подготовленный сигнал: полоса 1–40 Гц убирает смещение
    (постоянная компонента каждой синусоиды conftest), каналы — порядок монтажа."""
    meta = _upload(client, edf_file)
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1"

    raw_response = client.get(url)
    cleaned_response = client.get(f"{url}&layer=cleaned&band_min=1&band_max=40")

    assert cleaned_response.status_code == 200, cleaned_response.text
    assert cleaned_response.headers["x-signal-layer"] == "cleaned"
    header, payload = _parse(cleaned_response.content)
    assert header["layer"] == "cleaned"
    assert header["channels"] == meta["channels"]
    assert header["duration_sec"] == pytest.approx(4.0)
    assert header["sfreq"] == pytest.approx(250.0)

    raw_header, raw_payload = _parse(raw_response.content)
    assert raw_header["n_points"] == header["n_points"]
    # Сырой слой несёт смещения 0…4 мкВ (сигнатура conftest); high-pass 1 Гц
    # в подготовленном слое их убирает — слои действительно разные.
    assert abs(float(raw_payload.mean())) > 1.0
    assert abs(float(payload.mean())) < 0.5


def test_signals_diff_layer_is_cleaning_contribution(client, synth_edf):
    """diff = «без очистки − с очисткой»: пустая очистка даёт ноль, гармоники
    notch на сигнале 100 Гц — ненулевой вклад (та же семантика, что у mains)."""
    sfreq = 250.0
    n_times = int(4 * sfreq)
    t = np.arange(n_times) / sfreq
    data = np.vstack([
        20 * np.sin(2 * np.pi * 10 * t) + 5 * np.sin(2 * np.pi * 100 * t + channel)
        for channel in range(5)
    ])
    path = synth_edf("harmonics.edf", data, sfreq)
    meta = _upload(client, path, name="harmonics.edf")
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1&layer=diff"

    # Без очистки (и без полосы, режущей 100 Гц): разность ровно ноль
    empty = client.get(url)
    assert empty.status_code == 200, empty.text
    header, payload = _parse(empty.content)
    assert header["layer"] == "diff"
    assert np.allclose(payload, 0.0)

    # Гармоники notch (50 → 100 Гц): вырезанная составляющая видна числом
    with_notch = client.get(f"{url}&notch_hz=50&notch_harmonics=1")
    assert with_notch.status_code == 200, with_notch.text
    header, payload = _parse(with_notch.content)
    assert header["channels"] == meta["channels"]
    assert float(np.abs(payload).max()) > 1.0


def test_signals_layer_validation_is_400_with_text(client, edf_file):
    """Неверный слой/полоса/метод очистки — 400 с текстом для UI (правило 8)."""
    meta = _upload(client, edf_file)
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1"

    bad_layer = client.get(f"{url}&layer=bogus")
    assert bad_layer.status_code == 400
    assert "layer" in bad_layer.json()["detail"]

    one_sided_band = client.get(f"{url}&layer=cleaned&band_min=1")
    assert one_sided_band.status_code == 400
    assert "парой" in one_sided_band.json()["detail"]

    bad_method = client.get(f"{url}&layer=cleaned&clean_method=wavelet")
    assert bad_method.status_code == 400
    assert "clean_method" in bad_method.json()["detail"]


def test_signals_layers_have_distinct_etag_and_cache_files(client, edf_file):
    """ETag включает слой и параметры: 304 — только на тот же уровень; кэш слоёв
    лежит отдельными файлами, имя сырого слоя не изменилось (прежние кэши валидны)."""
    meta = _upload(client, edf_file)
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1"

    raw = client.get(url)
    cleaned = client.get(f"{url}&layer=cleaned&band_min=1&band_max=40")
    cleaned_repeat = client.get(
        f"{url}&layer=cleaned&band_min=1&band_max=40",
        headers={"If-None-Match": cleaned.headers["etag"]},
    )
    other_band = client.get(f"{url}&layer=cleaned&band_min=0.5&band_max=70")
    client.get(f"{url}&layer=diff&notch_hz=50&notch_harmonics=1")

    assert raw.headers["etag"] != cleaned.headers["etag"]
    assert cleaned.headers["etag"] != other_band.headers["etag"]
    assert cleaned_repeat.status_code == 304

    cache_dir = os.path.join(settings.cache_dir, "signals", meta["recording_id"])
    files = os.listdir(cache_dir)
    assert "level1.bin" in files
    assert any(name.startswith("level1-cleaned-") for name in files)
    assert any(name.startswith("level1-diff-") for name in files)


def test_band_layer_serves_persist_and_keeps_own_etag(client, synth_edf):
    """Слой band (Фаза B): собирается по band_key, свой ETag/файл, 304 на повтор."""
    sfreq = 250.0
    n_times = int(4 * sfreq)
    t = np.arange(n_times) / sfreq
    # Синус 10 Гц (в alpha 8–16) + смещение: high-pass полосы уберёт офсет
    data = np.vstack([10 * np.sin(2 * np.pi * 10 * t) + 30 + i for i in range(5)])
    path = synth_edf("band.edf", data, sfreq)
    meta = _upload(client, path, name="band.edf")
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1"

    banded = client.get(f"{url}&layer=band&band_key=alpha")
    assert banded.status_code == 200, banded.text
    header, payload = _parse(banded.content)
    assert header["layer"] == "band"
    assert header["channels"] == meta["channels"]
    assert header["n_points"] == payload.shape[1]
    # Alpha-фильтр убрал смещение 30 мкВ — слой действительно подготовленный
    assert abs(float(payload.mean())) < 5.0

    # Повтор тем же ETag → 304; другой band_key → другой уровень
    repeat = client.get(
        f"{url}&layer=band&band_key=alpha",
        headers={"If-None-Match": banded.headers["etag"]},
    )
    assert repeat.status_code == 304
    beta = client.get(f"{url}&layer=band&band_key=beta")
    assert beta.status_code == 200, beta.text
    assert beta.headers["etag"] != banded.headers["etag"]

    cache_dir = os.path.join(settings.cache_dir, "signals", meta["recording_id"])
    files = os.listdir(cache_dir)
    assert any(name.startswith("level1-band-") for name in files)
    # Персист массива записан отдельным кэшем (ключ — band_key)
    persist_dir = os.path.join(settings.cache_dir, "prepared", meta["recording_id"])
    assert os.path.isdir(persist_dir)
    assert any(name.startswith("alpha-") for name in os.listdir(persist_dir))


def test_band_layer_rejects_wrong_params(client, edf_file):
    """Слой band: без/с чужим band_key, с границами или очисткой — 400 с текстом."""
    meta = _upload(client, edf_file)
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1&layer=band"

    no_key = client.get(url)
    assert no_key.status_code == 400
    assert "band_key" in no_key.json()["detail"]

    unknown = client.get(f"{url}&band_key=alpha_wide")
    assert unknown.status_code == 400
    assert "band_key" in unknown.json()["detail"]

    with_bounds = client.get(f"{url}&band_key=alpha&band_min=8&band_max=16")
    assert with_bounds.status_code == 400
    assert "band_min" in with_bounds.json()["detail"]

    with_clean = client.get(f"{url}&band_key=alpha&clean_method=ica")
    assert with_clean.status_code == 400
    assert "очистки" in with_clean.json()["detail"]


def test_band_key_is_rejected_for_other_layers(client, edf_file):
    """band_key вне слоя band — 400: молчаливое игнорирование запрещено."""
    meta = _upload(client, edf_file)
    url = f"/api/v1/recordings/{meta['recording_id']}/signals?level=1"

    response = client.get(f"{url}&layer=cleaned&band_min=1&band_max=40&band_key=alpha")
    assert response.status_code == 400
    assert "band_key" in response.json()["detail"]
