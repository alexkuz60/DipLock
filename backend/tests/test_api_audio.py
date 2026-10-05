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
    started = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "boost_db": 0.0, "loudness_phon": None},
    )
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
    assert body["boost_db"] == 0.0  # переданный boost фиксируется в партитуре
    assert body["notch_harmonics"] == 2  # обязательные гармоники 100/150 Гц
    assert body["loudness"] is None  # loudness_phon=null — чистый RMS без поправок
    assert body["extensions"] == {"dipoles": None, "intracranial_ir": None, "doppler": None}
    # Частотная сетка треков: полоса × 128.
    delta = next(band for band in body["bands"] if band["name"] == "delta")
    assert delta["audio_fmin"] == 64.0 and delta["audio_fmax"] == 256.0
    # Детерминизм: тот же render_id → те же байты.
    assert client.get(f"{_PREFIX}/render/{render_id}/master.wav").content == master.content


def test_render_validates_gains_and_recording(client, tmp_path, edf_file):
    """400 — гейн/boost вне диапазона / неизвестная полоса; 404 — нет записи."""
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

    too_low = client.post(
        f"{_PREFIX}/render", json={"recording_id": recording.recording_id, "boost_db": -1.0},
    )
    assert too_low.status_code == 400
    assert "boost_db" in too_low.json()["detail"]

    too_high = client.post(
        f"{_PREFIX}/render", json={"recording_id": recording.recording_id, "boost_db": 13.0},
    )
    assert too_high.status_code == 400
    assert "boost_db" in too_high.json()["detail"]

    missing = client.post(f"{_PREFIX}/render", json={"recording_id": "no-such-recording"})
    assert missing.status_code == 404


def test_render_applies_default_boost(client, tmp_path, edf_file):
    """Дефолтное усиление +6 дБ: RMS трека −12 dBFS, boost в sidecar (05.10.2026).

    Компенсация ISO 226 здесь выключена (``loudness_phon: null``) — чистый
    boost-контракт; дефолтный loudness покрывает отдельный тест ниже.
    """
    recording = _register(tmp_path, edf_file)
    started = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "loudness_phon": None},
    )
    assert started.status_code == 202, started.text

    done = _wait_render(client, started.json()["render_id"])
    assert done["status"] == "succeeded", done.get("error")

    alpha = client.get(f"{_PREFIX}/render/{done['render_id']}/track/alpha.wav")
    with sf.SoundFile(io.BytesIO(alpha.content)) as handle:
        alpha_data = handle.read(dtype="float64")
    alpha_rms = float(np.sqrt(np.mean(alpha_data**2)))
    # Целевой уровень −18 + 6 = −12 dBFS; допуск 0.3 дБ на потолок трека
    # (пик синтетического трека почти наверняка ниже 0.891 — проверка покажет).
    assert alpha_rms == pytest.approx(10 ** (-12 / 20), rel=10 ** (0.3 / 20) - 1)

    sidecar = client.get(f"{_PREFIX}/render/{done['render_id']}/sidecar.json").json()
    assert sidecar["boost_db"] == pytest.approx(6.0)
    assert sidecar["loudness"] is None


def test_render_default_loudness_compensation(client, tmp_path, edf_file):
    """Дефолт: компенсация ISO 226 + автобаза — середина θ/α/β выровнена по перцептиву.

    Стратегия A (приёмка 05.10.2026): база ограничена потолком «ямы», поэтому
    ни одна из трёх полос не упирается в 0.891 и P = RMS − offset одинаков для
    всех (иначе при boost все crest-limited и компенсация не работает).
    """
    recording = _register(tmp_path, edf_file)
    started = client.post(f"{_PREFIX}/render", json={"recording_id": recording.recording_id})
    assert started.status_code == 202, started.text

    done = _wait_render(client, started.json()["render_id"])
    assert done["status"] == "succeeded", done.get("error")

    body = client.get(f"{_PREFIX}/render/{done['render_id']}/sidecar.json").json()
    loudness = body["loudness"]
    assert loudness is not None
    assert loudness["method"] == "iso226"
    assert loudness["phon"] == pytest.approx(75.0)
    assert loudness["autobase"] is True
    assert loudness["base_db"] <= -12.0 + 1e-9  # база только опускается (min)
    offsets = loudness["offsets_db"]
    assert offsets["delta"] > 5.0 and offsets["beta"] < 0.0

    # Строки банд несут применённые смещения (воспроизводимость партитуры).
    alpha_row = next(row for row in body["bands"] if row["name"] == "alpha")
    beta_row = next(row for row in body["bands"] if row["name"] == "beta")
    assert alpha_row["loudness_offset_db"] == pytest.approx(offsets["alpha"])
    assert beta_row["loudness_offset_db"] == pytest.approx(offsets["beta"])

    # Перцептив «ямы»: P = 20·log10(RMS) − offset — выровнен для θ/α/β.
    percepts: list[float] = []
    for band in ("theta", "alpha", "beta"):
        with sf.SoundFile(
            io.BytesIO(client.get(f"{_PREFIX}/render/{done['render_id']}/track/{band}.wav").content)
        ) as handle:
            data = handle.read(dtype="float64")
        rms = float(np.sqrt(np.mean(data**2)))
        assert rms > 0.0, f"{band}: тихий трек не участвует в выравнивании"
        percepts.append(20.0 * float(np.log10(rms)) - offsets[band])
    assert max(percepts) - min(percepts) < 0.15, f"середина не выровнена: {percepts}"


def test_render_max_loudness_mode_keeps_boost_base(client, tmp_path, edf_file):
    """Режим «максимум громкости» (loudness_autobase=false): база = −18+boost.

    Компенсация считается, но при boost все треки crest-limited (приёмка
    зафиксировала «дельта 0.00») — режим нужен для максимальной громкости.
    """
    recording = _register(tmp_path, edf_file)
    started = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "loudness_autobase": False},
    )
    assert started.status_code == 202, started.text

    done = _wait_render(client, started.json()["render_id"])
    assert done["status"] == "succeeded", done.get("error")

    body = client.get(f"{_PREFIX}/render/{done['render_id']}/sidecar.json").json()
    loudness = body["loudness"]
    assert loudness is not None
    assert loudness["autobase"] is False
    assert loudness["base_db"] == pytest.approx(-18.0 + 6.0)


def test_render_validates_loudness_phon(client, tmp_path, edf_file):
    """400 — loudness_phon вне 60…90; null проходит (выключить)."""
    recording = _register(tmp_path, edf_file)

    too_low = client.post(
        f"{_PREFIX}/render", json={"recording_id": recording.recording_id, "loudness_phon": 55.0},
    )
    assert too_low.status_code == 400
    assert "loudness_phon" in too_low.json()["detail"]

    too_high = client.post(
        f"{_PREFIX}/render", json={"recording_id": recording.recording_id, "loudness_phon": 95.0},
    )
    assert too_high.status_code == 400
    assert "loudness_phon" in too_high.json()["detail"]

    off = client.post(
        f"{_PREFIX}/render", json={"recording_id": recording.recording_id, "loudness_phon": None},
    )
    assert off.status_code == 202
    done = _wait_render(client, off.json()["render_id"])
    assert done["status"] == "succeeded", done.get("error")


def test_unknown_render_id_is_404(client):
    """Неизвестный render_id — 404 на статусе и файлам."""
    assert client.get(f"{_PREFIX}/render/deadbeef/status").status_code == 404
    assert client.get(f"{_PREFIX}/render/deadbeef/master.wav").status_code == 404
    assert client.get(f"{_PREFIX}/render/deadbeef/sidecar.json").status_code == 404


def test_second_render_is_rejected_while_running(client, tmp_path, edf_file, monkeypatch):
    """Один активный рендер: второй POST → 409 с текстом (без очереди)."""
    recording = _register(tmp_path, edf_file)
    release = threading.Event()

    def _slow(state, rec, cfg, gains, boost=0.0, phon=None, autobase=True):
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
