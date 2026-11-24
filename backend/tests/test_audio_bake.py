"""Тесты 3D-bake «Нейромузыки» (spatial-audio, п.3): цепочка → детерминированный WAV.

Юнит — геометрия модулей (спецификация 07.10.2026), формулы widening/панорамы,
ключ кэша и печать на memory-артефактах; API — полный цикл (202 → поллинг →
WAV → cached), валидация 400/404 и конфликт 409.
"""
import io
import json
import shutil
import threading
import time

import numpy as np
import pytest
import soundfile as sf

from app.core.config import settings
from app.services.audio_render import bake as neuro_bake
from app.services.audio_render import render as neuro_render
from app.services.audio_render import store as neuro_store
from app.services.audio_render.export import wav_bytes
from app.services.prepared_signal import clear_prepared_cache
from app.services.recordings import recording_registry

_PREFIX = "/api/v1/audio"

# Короткий stereo-IR «импульс»: единичной энергии после нормировки — свёртка
# с ним равна исходному сигналу (проверка влажности и детерминизма).
_IR_BLOB = wav_bytes(np.vstack([np.eye(1, 2, 0)[0], np.zeros((479, 2))]))


@pytest.fixture(autouse=True)
def clean_state():
    """In-memory состояния рендера и бака пусты между тестами."""
    recording_registry.clear()
    clear_prepared_cache()
    neuro_render.clear_renders()
    neuro_bake.clear_bakes()
    yield
    recording_registry.clear()
    clear_prepared_cache()
    neuro_render.clear_renders()
    neuro_bake.clear_bakes()


def _register(tmp_path, edf_path, recording_id: str = "rec-bake"):
    """Регистрирует запись так, как это делает ``POST /recordings``."""
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


def _wait_render(client, render_id: str, timeout: float = 60.0) -> dict:
    """Поллинг статуса рендера, как это делает UI."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/render/{render_id}/status").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Рендер не завершился за {timeout} с: {body}")


def _wait_bake(client, render_id: str, bake_id: str, timeout: float = 60.0) -> dict:
    """Поллинг статуса бака, как это делает UI."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/render/{render_id}/bake/{bake_id}/status").json()
        if body.get("status") in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Бак не завершился за {timeout} с: {body}")


def _memory_artifacts(
    variant: str = "express", dipole: dict | None = None,
) -> neuro_render.RenderArtifacts:
    """Артефакты с WAV в памяти (без диска) — вход юнит-печати.

    Амплитуда стема падает с индексом полосы — иначе симметричные гейны
    панорамы делают каналы равными и тест панорамы ничего не проверяет.
    Для «Монтажа» в память кладётся sidecar с блоком ``extensions.dipoles``
    (средние позиции диполей — геометрия печати).
    """
    bands = ["delta", "alpha"]
    memory: dict[str, bytes] = {}
    for index, band in enumerate(bands):
        amp = 0.5 / (index + 1)
        stem = np.stack([np.full(480, amp), np.full(480, amp / 2)], axis=1)
        memory[neuro_store.track_name(band)] = wav_bytes(stem)
    if variant == "montage":
        sidecar = {"extensions": {"dipoles": dipole or {}}}
        memory[neuro_store.SIDECAR_NAME] = json.dumps(sidecar).encode("utf-8")
    return neuro_render.RenderArtifacts(
        bands=bands,
        recording_id="rec-unit",
        sig="sig-unit",
        variant=variant,
        memory=memory,
    )


# --- юнит: геометрия и формулы -------------------------------------------------


def test_montage_azimuths_follow_dipole_mean_positions():
    """«Монтаж»: азимут полосы — средняя позиция её диполя; spread схлопывает.

    Азимут ``atan2(x, y)`` MNI: 0° — фронт (+y), +90° — вправо (+x).
    """
    dipole = {
        "bands": {
            # Фронт (x=0, y>0) → 0°; правое ухо (x>0, y=0) → +90°;
            # тыл (y<0) → ±180°.
            "delta": {"frames": [{"x": 0.0, "y": 70.0}, {"x": 0.0, "y": 70.0}]},
            "alpha": {"frames": [{"x": 70.0, "y": 0.0}, {"x": 70.0, "y": 0.0}]},
        }
    }
    artifacts = _memory_artifacts(variant="montage", dipole=dipole)
    sources = neuro_bake._source_azimuths(artifacts, spread=1.0)
    assert sources == [
        (neuro_store.track_name("delta"), pytest.approx(0.0)),
        (neuro_store.track_name("alpha"), pytest.approx(90.0)),
    ]
    # spread 0 схлопывает азимуты к фронту (0°).
    collapsed = neuro_bake._source_azimuths(artifacts, spread=0.0)
    assert [azimuth for _, azimuth in collapsed] == pytest.approx([0.0, 0.0])

    # Нет дипольной сцены (старый формат) — честная ошибка статуса.
    with pytest.raises(ValueError, match="дипольной сцены"):
        neuro_bake._source_azimuths(_memory_artifacts(variant="montage"), spread=1.0)


def test_arc_position_and_pan_gains():
    """«Экспресс»: дуга ±60° и равномощная панорама (gL²+gR² = 1)."""
    left = neuro_bake.arc_position(0, 7, 1.0)
    right = neuro_bake.arc_position(6, 7, 1.0)
    center = neuro_bake.arc_position(3, 7, 1.0)
    assert neuro_bake.azimuth_deg(*left) == pytest.approx(-neuro_bake.ARC_HALF_DEG)
    assert neuro_bake.azimuth_deg(*right) == pytest.approx(neuro_bake.ARC_HALF_DEG)
    assert center == pytest.approx((0.0, -neuro_bake.SOURCE_DISTANCE_M))
    assert neuro_bake.arc_position(0, 7, 0.0) == pytest.approx((0.0, -1.5))

    gain_l, gain_r = neuro_bake.pan_gains(0.0)
    assert gain_l == pytest.approx(2**-0.5) and gain_r == pytest.approx(2**-0.5)
    assert neuro_bake.pan_gains(-90.0) == pytest.approx((1.0, 0.0))
    assert neuro_bake.pan_gains(90.0) == pytest.approx((0.0, 1.0))
    for azimuth in (-60.0, -18.0, 0.0, 45.0, 90.0):
        gl, gr = neuro_bake.pan_gains(azimuth)
        assert gl**2 + gr**2 == pytest.approx(1.0)


def test_widen_formula():
    """M/S-формула: 100 % — без изменения, 0 % — моно L+R (свойство Tone)."""
    stereo = np.array([[1.0, -0.5], [0.25, 0.75], [-1.0, 0.0]])
    assert neuro_bake.widen(stereo, 100.0) == pytest.approx(stereo)
    mono = neuro_bake.widen(stereo, 0.0)
    assert mono[:, 0] == pytest.approx(stereo[:, 0] + stereo[:, 1])
    assert mono[:, 1] == pytest.approx(stereo[:, 0] + stereo[:, 1])
    half = neuro_bake.widen(stereo, 50.0)
    mid = (stereo[:, 0] + stereo[:, 1]) / 2
    side = (stereo[:, 0] - stereo[:, 1]) / 2
    assert half[:, 0] == pytest.approx(1.5 * mid + 0.5 * side)


def test_bake_sig_key_depends_on_everything():
    """Ключ меняется от render_id/каждого параметра/IR; повтор — тот же."""
    params = neuro_bake.BakeParams()
    base = neuro_bake.bake_sig("render-a", params, "sha-1")
    assert base == neuro_bake.bake_sig("render-a", neuro_bake.BakeParams(), "sha-1")
    assert base != neuro_bake.bake_sig("render-b", params, "sha-1")
    assert base != neuro_bake.bake_sig("render-a", neuro_bake.BakeParams(width_pct=110.0), "sha-1")
    assert base != neuro_bake.bake_sig("render-a", neuro_bake.BakeParams(spread_pct=50.0), "sha-1")
    assert base != neuro_bake.bake_sig("render-a", neuro_bake.BakeParams(wet_pct=0.0), "sha-1")
    assert base != neuro_bake.bake_sig("render-a", neuro_bake.BakeParams(ir="cranium"), "sha-1")
    assert base != neuro_bake.bake_sig("render-a", params, "sha-2")


def test_bake_wav_is_deterministic_and_bounded():
    """Печать «Экспресса»: те же входы → байты в байт, WAV 48k/стерео/PCM_16."""
    artifacts = _memory_artifacts()
    params = neuro_bake.BakeParams(width_pct=100.0, spread_pct=100.0, wet_pct=0.0)
    first = neuro_bake.bake_wav(artifacts, params, _IR_BLOB)
    second = neuro_bake.bake_wav(artifacts, params, _IR_BLOB)
    assert first == second
    with sf.SoundFile(io.BytesIO(first)) as handle:
        assert handle.samplerate == 48000
        assert handle.channels == 2
        assert handle.subtype == "PCM_16"
        data = handle.read(dtype="float64")
    assert data.shape == (480, 2)
    # δ слева на полном разбросе: левый канал громче правого.
    assert float(np.sqrt(np.mean(data[:, 0] ** 2))) > float(np.sqrt(np.mean(data[:, 1] ** 2)))
    # Пик-контроль рендера прижимает сцену к −1 dBFS.
    assert float(np.max(np.abs(data))) <= 0.892


def test_bake_wav_montage_widens_and_counts_sources():
    """«Монтаж»: печатаются треки полос по дипольным позициям; spread 0 + width 0 → моно."""
    dipole = {
        "bands": {
            "delta": {"frames": [{"x": -40.0, "y": 30.0}]},
            "alpha": {"frames": [{"x": 40.0, "y": -30.0}]},
        }
    }
    artifacts = _memory_artifacts(variant="montage", dipole=dipole)
    stages: list[str] = []

    def _progress(pct: float, stage: str) -> None:
        assert 0.0 <= pct <= 1.0
        stages.append(stage)

    # spread 0 схлопывает азимуты диполей к фронту (0°) — панорама не раскидывает
    # моно-сигнал по каналам, и M/S-формула width 0 видна в равенстве L/R.
    params = neuro_bake.BakeParams(width_pct=0.0, spread_pct=0.0, wet_pct=0.0)
    wav = neuro_bake.bake_wav(artifacts, params, _IR_BLOB, on_progress=_progress)
    # 2 полосы = 2 стема + служебные шаги.
    assert sum("стем" in stage for stage in stages) == 2
    with sf.SoundFile(io.BytesIO(wav)) as handle:
        data = handle.read(dtype="float64")
    assert data.shape == (480, 2)
    assert data[:, 0] == pytest.approx(data[:, 1])


# --- API: полный цикл, валидация, конфликт -------------------------------------


def test_bake_full_cycle_and_cache(client, tmp_path, edf_file):
    """202 → поллинг → WAV 48k/PCM_16 → повтор POST: cached, байты те же."""
    recording = _register(tmp_path, edf_file)
    started = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "boost_db": 0.0, "loudness_phon": None},
    )
    assert started.status_code == 202, started.text
    render_id = started.json()["render_id"]
    assert _wait_render(client, render_id)["status"] == "succeeded"

    baked = client.post(f"{_PREFIX}/render/{render_id}/bake", json={"wet_pct": 0.0})
    assert baked.status_code == 202, baked.text
    assert baked.json()["cached"] is False
    bake_id = baked.json()["bake_id"]

    done = _wait_bake(client, render_id, bake_id)
    assert done["status"] == "succeeded", done.get("error")
    assert done["pct"] == 1.0 and done["stage"] == "Готово"
    assert done["bytes_total"] > 0 and done["render_id"] == render_id

    wav = client.get(f"{_PREFIX}/render/{render_id}/bake/{bake_id}.wav")
    assert wav.status_code == 200
    assert wav.headers["content-type"].startswith("audio/wav")
    with sf.SoundFile(io.BytesIO(wav.content)) as handle:
        assert handle.samplerate == 48000
        assert handle.channels == 2
        assert handle.subtype == "PCM_16"
        assert abs(len(handle) / 48000 - 4.0) < 0.01

    # Повтор тех же параметров — кэш: тот же ключ, конвейер не запускался.
    launched = []
    original = neuro_bake._run_bake

    def _forbidden(*args, **kwargs):
        launched.append(args)
        original(*args, **kwargs)

    neuro_bake._run_bake = _forbidden
    try:
        again = client.post(f"{_PREFIX}/render/{render_id}/bake", json={"wet_pct": 0.0})
    finally:
        neuro_bake._run_bake = original
    assert again.status_code == 202
    assert again.json()["cached"] is True
    assert again.json()["bake_id"] == bake_id
    assert launched == []
    assert client.get(
        f"{_PREFIX}/render/{render_id}/bake/{bake_id}.wav",
    ).content == wav.content

    # Принадлежность бака рендеру: чужой render_id в пути — 404.
    assert client.get(
        f"{_PREFIX}/render/deadbeef/bake/{bake_id}/status",
    ).status_code == 404


def test_bake_validates_params_and_render(client):
    """400 — параметры/пресет IR; 404 — неизвестный рендер/бак."""
    bad = client.post(
        f"{_PREFIX}/render/deadbeef/bake", json={"width_pct": 200.0},
    )
    assert bad.status_code == 400
    assert "width_pct" in bad.json()["detail"]

    bad = client.post(f"{_PREFIX}/render/deadbeef/bake", json={"spread_pct": -1.0})
    assert bad.status_code == 400 and "spread_pct" in bad.json()["detail"]

    bad = client.post(f"{_PREFIX}/render/deadbeef/bake", json={"wet_pct": 101.0})
    assert bad.status_code == 400 and "wet_pct" in bad.json()["detail"]

    bad = client.post(f"{_PREFIX}/render/deadbeef/bake", json={"ir": "castle"})
    assert bad.status_code == 400 and "castle" in bad.json()["detail"]

    # Валидация параметров идёт до поиска рендера; с валидными — 404.
    assert client.post(f"{_PREFIX}/render/deadbeef/bake", json={}).status_code == 404
    assert client.get(
        f"{_PREFIX}/render/deadbeef/bake/deadbeef/status",
    ).status_code == 404


def test_second_bake_is_rejected_while_running(client, tmp_path, edf_file, monkeypatch):
    """Один активный бак: второй POST → 409, WAV ещё печатается → 409."""
    recording = _register(tmp_path, edf_file)
    render = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "boost_db": 0.0, "loudness_phon": None},
    )
    render_id = render.json()["render_id"]
    assert _wait_render(client, render_id)["status"] == "succeeded"

    release = threading.Event()

    def _hold(*args, **kwargs):
        release.wait(timeout=10)

    monkeypatch.setattr(neuro_bake, "_run_bake", _hold)
    first = client.post(f"{_PREFIX}/render/{render_id}/bake", json={})
    assert first.status_code == 202 and first.json()["cached"] is False
    bake_id = first.json()["bake_id"]

    second = client.post(f"{_PREFIX}/render/{render_id}/bake", json={})
    assert second.status_code == 409
    assert "идёт" in second.json()["detail"]

    status = client.get(f"{_PREFIX}/render/{render_id}/bake/{bake_id}/status").json()
    assert status["status"] == "running"
    wav = client.get(f"{_PREFIX}/render/{render_id}/bake/{bake_id}.wav")
    assert wav.status_code == 409
    release.set()
