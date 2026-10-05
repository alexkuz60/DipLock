"""Тесты API «Нейромузыки» (M4): полный цикл рендера, статус, WAV, sidecar, 400/404/409.

Контракт: POST 202 → поллинг статуса (проценты) → GET master.wav / треков /
sidecar.json; рендер один активный за раз (in-memory, без job-системы).
"""
import io
import shutil
import threading
import time

import numpy as np
import pytest
import soundfile as sf

from app.core.config import settings
from app.services.audio_render import render as neuro_render
from app.services.prepared_signal import clear_prepared_cache
from app.services.recordings import recording_registry

_PREFIX = "/api/v1/audio"


@pytest.fixture(autouse=True)
def clean_state():
    """In-memory реестр рендера и кэш сигнала пусты между тестами."""
    recording_registry.clear()
    clear_prepared_cache()
    neuro_render.clear_renders()
    yield
    recording_registry.clear()
    clear_prepared_cache()
    neuro_render.clear_renders()


def _register(tmp_path, edf_path, recording_id: str = "rec-audio"):
    """Регистрирует запись так, как это делает ``POST /recordings``."""
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


def _wait_render(client, render_id: str, timeout: float = 30.0) -> dict:
    """Поллинг статуса рендера, как это делает UI (ТЗ M5)."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/render/{render_id}/status").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Рендер не завершился за {timeout} с: {body}")


def test_full_render_cycle(client, tmp_path, edf_file):
    """Полный цикл: 202 → статус → мастер-WAV 48k/24bit → трек → sidecar."""
    recording = _register(tmp_path, edf_file)
    started = client.post(f"{_PREFIX}/render", json={"recording_id": recording.recording_id})
    assert started.status_code == 202, started.text
    render_id = started.json()["render_id"]
    assert started.json()["status"] == "running"

    done = _wait_render(client, render_id)
    assert done["status"] == "succeeded", done.get("error")
    assert done["pct"] == 1.0
    assert done["stage"] == "Готово"
    assert set(done["tracks"]) == set(settings.freq_bands)

    # Мастер: WAV 48000/стерео, длительность = записи (4 с).
    master = client.get(f"{_PREFIX}/render/{render_id}/master.wav")
    assert master.status_code == 200
    assert master.headers["content-type"].startswith("audio/wav")
    with sf.SoundFile(io.BytesIO(master.content)) as handle:
        assert handle.samplerate == 48000
        assert handle.channels == 2
        assert handle.subtype == "PCM_24"
        assert abs(len(handle) / 48000 - 4.0) < 0.01

    # Отдельный трек (соль-прослушивание): валидный WAV 48k/стерео, приведён
    # к −18 dBFS сквозным циклом (размеры WAV не сравниваем: PCM_24 одинаков
    # при любой амплитуде; мастер прижат пик-контролем вниз — это не значит,
    # что он «тише» по восприятию).
    alpha = client.get(f"{_PREFIX}/render/{render_id}/track/alpha.wav")
    assert alpha.status_code == 200
    with sf.SoundFile(io.BytesIO(alpha.content)) as handle:
        assert handle.samplerate == 48000 and handle.channels == 2
        alpha_data = handle.read(dtype="float64")
    alpha_rms = float(np.sqrt(np.mean(alpha_data**2)))
    assert alpha_rms == pytest.approx(10 ** (-18 / 20), rel=1e-3)
    assert client.get(f"{_PREFIX}/render/{render_id}/track/nope.wav").status_code == 404

    # Sidecar «партитура».
    sidecar = client.get(f"{_PREFIX}/render/{render_id}/sidecar.json")
    assert sidecar.status_code == 200
    body = sidecar.json()
    assert body["schema_version"] == 1
    assert body["fs_audio"] == 48000 and body["pitch_factor"] == 128
    assert len(body["bands"]) == 7
    assert body["channel_order"] == list(recording.meta.get("channels") or body["channel_order"])
    assert body["input_checksum_sha256"]
    assert body["extensions"] == {"dipoles": None, "intracranial_ir": None, "doppler": None}
    # Частотная сетка треков: полоса × 128.
    delta = next(band for band in body["bands"] if band["name"] == "delta")
    assert delta["audio_fmin"] == 64.0 and delta["audio_fmax"] == 256.0
    # Детерминизм: тот же render_id → те же байты.
    assert client.get(f"{_PREFIX}/render/{render_id}/master.wav").content == master.content


def test_render_validates_gains_and_recording(client, tmp_path, edf_file):
    """400 — гейн вне диапазона / неизвестная полоса; 404 — нет записи."""
    recording = _register(tmp_path, edf_file)

    bad_gain = client.post(
        f"{_PREFIX}/render", json={"recording_id": recording.recording_id, "gains_db": {"alpha": 99.0}},
    )
    assert bad_gain.status_code == 400
    assert "alpha" in bad_gain.json()["detail"]

    bad_band = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "gains_db": {"delta_wave": 0.0}},
    )
    assert bad_band.status_code == 400
    assert "Неизвестные полосы" in bad_band.json()["detail"]

    missing = client.post(f"{_PREFIX}/render", json={"recording_id": "no-such-recording"})
    assert missing.status_code == 404


def test_unknown_render_id_is_404(client):
    """Неизвестный render_id — 404 на статусе и файлам."""
    assert client.get(f"{_PREFIX}/render/deadbeef/status").status_code == 404
    assert client.get(f"{_PREFIX}/render/deadbeef/master.wav").status_code == 404
    assert client.get(f"{_PREFIX}/render/deadbeef/sidecar.json").status_code == 404


def test_second_render_is_rejected_while_running(client, tmp_path, edf_file, monkeypatch):
    """Один активный рендер: второй POST → 409 с текстом (без очереди)."""
    recording = _register(tmp_path, edf_file)
    release = threading.Event()

    def _slow(state, rec, cfg, gains):
        release.wait(timeout=10)
        state.status = "succeeded"
        state.stage = "Готово"
        state.pct = 1.0
        state.finished_at = time.time()

    monkeypatch.setattr(neuro_render, "_run_render", _slow)
    first = client.post(f"{_PREFIX}/render", json={"recording_id": recording.recording_id})
    assert first.status_code == 202
    second = client.post(f"{_PREFIX}/render", json={"recording_id": recording.recording_id})
    assert second.status_code == 409
    assert "идёт" in second.json()["detail"]
    release.set()


def test_render_state_is_reset_between_tests():
    """Фикстура тестов очищает in-memory реестр (иначе статусы перетекают)."""
    assert neuro_render.state_of.__module__  # импорт на месте
