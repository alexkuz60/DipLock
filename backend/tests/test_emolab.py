"""Тесты «ЕмоЛаб» (шаг 1): вход аудиотрека, анализ, кэш и API.

Юнит — разбор wav/mp3 (``track_input``), контракт кадров «Эмо» и жизненный
цикл кэша (``store``); интеграционный — ``POST /emolab/analyze`` → статус →
``GET …/emo`` с моком VAMP (``stub_vamp``: subprocess sonic-annotator в
тестах не запускается — как в ``test_audio_vamp.py`` юнит-часть герметична).
"""
import io
import os
import time

import numpy as np
import pytest
import soundfile as sf

from app.core.config import settings
from app.schemas.audio import AudioEmoOut
from app.services.audio_render import emo_radar, vamp_analysis
from app.services.emolab import store, track_analysis, track_input

_PREFIX = f"{settings.api_prefix}/emolab"

# Фиксированные карты VAMP для мока (код 1 = C major, темп 120 bpm).
KEY_SEGMENTS = [{"t_sec": 0.0, "key_code": 1, "label": "C major"}]
TEMPO_SEGMENTS = [{"t_sec": 0.0, "bpm": 120.0}]


def _wav_blob(
    seconds: float = 1.0, fs: int = 44100, freq: float = 440.0, channels: int = 2,
) -> bytes:
    """Синтетический WAV (тон) — внешний аудиотрек для анализа."""
    t = np.arange(int(seconds * fs)) / fs
    tone = 0.5 * np.sin(2 * np.pi * freq * t)
    data = np.stack([tone, -tone] if channels == 2 else [tone], axis=1)
    buffer = io.BytesIO()
    sf.write(buffer, data, fs, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


@pytest.fixture
def stub_vamp(monkeypatch):
    """VAMP «под рукой»: фиксированные карты темпа/аккордов без subprocess.

    Возвращает журнал вызовов: ключевой прогон обязан идти 32k-трансформом
    (``KEY_TRANSFORM_NAME_32K`` — требование плагина при 32 кГц).
    """
    calls: dict[str, str | None] = {"key_transform": None}

    def _key(blob, cfg=None, transform_name=None):
        calls["key_transform"] = transform_name
        return [dict(segment) for segment in KEY_SEGMENTS]

    def _tempo(blob, cfg=None):
        return [dict(segment) for segment in TEMPO_SEGMENTS]

    monkeypatch.setattr(vamp_analysis, "key_track_from_wav", _key)
    monkeypatch.setattr(vamp_analysis, "tempo_track_from_wav", _tempo)
    return calls


def _wait_track(track_id: str, timeout: float = 30.0) -> track_analysis.TrackState:
    """Ждёт завершения фонового анализа (сервис крутит его в потоке)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = track_analysis.state_of(track_id, settings)
        if state.status != "running":
            return state
        time.sleep(0.02)
    raise AssertionError("анализ не завершился вовремя")


# --- track_input: зонд, декод, ресемпл --------------------------------------


def test_probe_reads_header():
    """Зонд читает заголовок: частота/каналы/длительность без декодирования."""
    fs, channels, duration = track_input.probe(_wav_blob(seconds=1.0, fs=44100))
    assert fs == 44100 and channels == 2
    assert duration == pytest.approx(1.0, abs=0.01)


def test_decode_resamples_to_analysis_mono():
    """Моно 44100 → моно 32000: длительность сохраняется, отсчёты конечны."""
    audio = track_input.decode_track(_wav_blob(seconds=0.5, fs=44100, channels=1))
    assert audio.fs_source == 44100 and audio.channels_source == 1
    assert track_input.ANALYSIS_FS == 32000
    assert audio.data.ndim == 1
    assert audio.duration_s == pytest.approx(0.5, abs=0.01)
    assert np.isfinite(audio.data).all()


def test_decode_merges_stereo_to_mono_mean():
    """Стерео сливается (L+R)/2: противоположные каналы дают тишину."""
    audio = track_input.decode_track(_wav_blob(seconds=0.2, fs=32000, channels=2))
    assert audio.data.ndim == 1
    assert np.abs(audio.data).max() == pytest.approx(0.0, abs=1e-3)


def test_decode_rejects_garbage_and_empty():
    """Не аудио и пустой файл — TrackInputError (400 в API), не 500."""
    for blob in (b"", b"not audio at all"):
        with pytest.raises(track_input.TrackInputError):
            track_input.decode_track(blob)


def test_decode_rejects_too_long(monkeypatch):
    """Потолок длительности режет файл до накопления буфера."""
    monkeypatch.setattr(track_input, "MAX_DURATION_SEC", 0.1)
    with pytest.raises(track_input.TrackInputError, match="длиннее"):
        track_input.decode_track(_wav_blob(seconds=1.0))


def test_wav_bytes_is_analysis_contract():
    """WAV для VAMP: моно 32000 Гц (временный файл входа sonic-annotator)."""
    audio = track_input.decode_track(_wav_blob())
    info = sf.info(io.BytesIO(track_input.wav_bytes(audio)))
    assert info.samplerate == track_input.ANALYSIS_FS == 32000
    assert info.channels == 1


# --- track_analysis: контракт кадров, кэш, восстановление --------------------


def test_analysis_writes_cache_and_contract(stub_vamp, isolated_io):
    """Полный конвейер: кэш-манифест, emo.json — контракт AudioEmoOut (v4)."""
    track_analysis.clear_states()
    track_id, cached = track_analysis.start_analysis(_wav_blob(), "song.wav", settings)
    assert not cached
    state = _wait_track(track_id)
    assert state.status == "succeeded", state.error
    assert stub_vamp["key_transform"] == vamp_analysis.KEY_TRANSFORM_NAME_32K

    manifest = store.load_manifest(settings, track_id)
    assert manifest is not None
    assert store.EMO_NAME in manifest["files"]
    assert "source.wav" in manifest["files"]
    assert manifest["fs_source"] == 44100 and manifest["channels_source"] == 2
    assert manifest["fs_analysis"] == track_input.ANALYSIS_FS == 32000

    payload = track_analysis.emo_payload_of(state, settings)
    assert payload is not None
    validated = AudioEmoOut.model_validate(payload)
    assert validated.schema_version == emo_radar.EMO_SCHEMA_VERSION
    assert validated.fs_audio == track_input.ANALYSIS_FS == 32000
    assert validated.fft_size == 32768 and validated.hop_samples == 32000
    assert validated.frame_count == len(validated.frames) >= 1
    hop_sec = emo_radar.EMO_HOP_SAMPLES / track_input.ANALYSIS_FS
    assert hop_sec == 1.0  # кадр звезды = 32000 сэмплов = ровно 1 с (шаг 2)
    for index, frame in enumerate(validated.frames):
        assert frame.t_sec == pytest.approx(index * hop_sec, abs=1e-4)
        assert len(frame.rays) == emo_radar.EMO_RAY_COUNT
    assert validated.key_track is not None and validated.key_track[0].key_code == 1
    assert validated.tempo_track is not None and validated.tempo_track[0].bpm == 120.0


def test_start_analysis_caches_by_digest(stub_vamp, isolated_io):
    """sha256 содержимого = track_id: повтор — из кэша, «рестарт» — из манифеста."""
    track_analysis.clear_states()
    blob = _wav_blob(seconds=0.5, freq=330.0)
    track_id, cached = track_analysis.start_analysis(blob, "a.wav", settings)
    assert not cached
    assert _wait_track(track_id).status == "succeeded"

    again_id, again_cached = track_analysis.start_analysis(blob, "a.wav", settings)
    assert again_id == track_id and again_cached

    track_analysis.clear_states()  # смерть процесса: память пуста, диск жив
    state = track_analysis.state_of(track_id, settings)
    assert state.status == "succeeded"

    other_id, other_cached = track_analysis.start_analysis(
        _wav_blob(seconds=0.5, freq=340.0), "b.wav", settings,
    )
    assert other_id != track_id and not other_cached
    assert _wait_track(other_id).status == "succeeded"


def test_store_sweep_keeps_only_limit(isolated_io, monkeypatch):
    """Чистка кэша: лимит числа треков стареет LRU по mtime."""
    monkeypatch.setattr(store, "MAX_TRACKS", 2)
    for index in range(4):
        track_id = f"{index:032d}"
        assert store.write_track_files(settings, track_id, {store.EMO_NAME: b"{}"})
        assert store.write_manifest(
            settings, track_id,
            {"format": store.TRACK_FORMAT_VERSION, "files": {store.EMO_NAME: 2}},
        )
        os.utime(
            store.track_dir(settings, track_id),
            (time.time() - (4 - index), time.time() - (4 - index)),
        )
    removed = store.sweep_tracks(settings)
    assert removed == 2
    assert store.load_manifest(settings, f"{0:032d}") is None
    assert store.load_manifest(settings, f"{1:032d}") is None
    assert store.load_manifest(settings, f"{3:032d}") is not None


# --- API: POST /analyze → статус → GET …/emo ---------------------------------


def _wait_api(client, track_id: str, timeout: float = 30.0) -> dict:
    """Поллинг статуса через API (как это делает UI)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/{track_id}/status")
        assert body.status_code == 200, body.text
        data = body.json()
        if data["status"] != "running":
            return data
        time.sleep(0.02)
    raise AssertionError("анализ не завершился вовремя")


def test_api_analyze_flow(stub_vamp, client, isolated_io):
    """Загрузка трека → анализ → контракт кадров; повтор — cached."""
    track_analysis.clear_states()
    blob = _wav_blob(seconds=1.0, freq=550.0)
    started = client.post(
        f"{_PREFIX}/analyze", files={"file": ("song.wav", blob, "audio/wav")},
    )
    assert started.status_code == 202, started.text
    body = started.json()
    assert body["cached"] is False
    assert body["duration_s"] == pytest.approx(1.0, abs=0.02)
    track_id = body["track_id"]

    done = _wait_api(client, track_id)
    assert done["status"] == "succeeded", done.get("error")
    assert done["duration_s"] == pytest.approx(1.0, abs=0.02)

    emo = client.get(f"{_PREFIX}/{track_id}/emo")
    assert emo.status_code == 200, emo.text
    payload = emo.json()
    assert payload["schema_version"] == emo_radar.EMO_SCHEMA_VERSION
    assert payload["fs_audio"] == track_input.ANALYSIS_FS == 32000
    assert payload["key_track"][0]["key_code"] == 1
    assert payload["tempo_track"][0]["bpm"] == 120.0

    again = client.post(
        f"{_PREFIX}/analyze", files={"file": ("song.wav", blob, "audio/wav")},
    )
    assert again.status_code == 202
    assert again.json()["cached"] is True
    assert again.json()["status"] == "succeeded"


def test_api_rejects_bad_upload(client, isolated_io):
    """Не wav/mp3 и битые байты — 400 (текст для UI)."""
    bad_ext = client.post(
        f"{_PREFIX}/analyze", files={"file": ("song.txt", b"data", "text/plain")},
    )
    assert bad_ext.status_code == 400
    garbage = client.post(
        f"{_PREFIX}/analyze", files={"file": ("song.wav", b"not audio", "audio/wav")},
    )
    assert garbage.status_code == 400


def test_api_unknown_track_is_404(client, isolated_io):
    """Неизвестный track_id — 404 в обоих GET."""
    assert client.get(f"{_PREFIX}/deadbeef/status").status_code == 404
    assert client.get(f"{_PREFIX}/deadbeef/emo").status_code == 404


def test_api_emo_gates_on_state(monkeypatch, client, isolated_io):
    """GET …/emo: идёт анализ — 409 с шагом; упал — 409 с текстом ошибки."""

    def running(track_id, cfg=None):
        return track_analysis.TrackState(track_id=track_id, status="running", stage="ФФТ", pct=0.5)

    monkeypatch.setattr(track_analysis, "state_of", running)
    body = client.get(f"{_PREFIX}/x/emo")
    assert body.status_code == 409 and "ФФТ" in body.json()["detail"]

    def failed(track_id, cfg=None):
        return track_analysis.TrackState(track_id=track_id, status="failed", error="упал")

    monkeypatch.setattr(track_analysis, "state_of", failed)
    body = client.get(f"{_PREFIX}/x/emo")
    assert body.status_code == 409 and "упал" in body.json()["detail"]


# --- integration: живой прогон VAMP по моно-файлу 32 кГц -----------------------


@pytest.mark.integration
def test_live_vamp_chain_on_32k_mono():
    """Реальный sonic-annotator по моно-файлу 32 кГц (вход VAMP «ЕмоЛаб»).

    Ловушка шага 2: Key Detector требует step/block 16384 при 32 кГц — с общим
    трансформом рендера (32768/32768) плагин не инициализируется и карта
    аккордов молча пропадает (best-effort). Маркер ``integration``:
    пропускается без бинаря в ``tools/`` (в CI его нет).
    """
    if not os.path.isfile(settings.sonic_annotator_bin):
        pytest.skip("sonic-annotator не установлен")
    # Тон ля + щелчки каждые 0.5 с (120 bpm), 8 с @32000 моно.
    fs = 32000
    t = np.arange(fs * 8) / fs
    sig = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.15 * np.sin(2 * np.pi * 440 * t)
    clicks = np.zeros_like(t)
    for k in range(16):
        clicks[(t >= k * 0.5) & (t < k * 0.5 + 0.02)] = 0.5
    buffer = io.BytesIO()
    sf.write(buffer, sig + clicks, fs, format="WAV", subtype="PCM_16")
    audio = track_input.decode_track(buffer.getvalue())
    wav = track_input.wav_bytes(audio)
    key = vamp_analysis.key_track_from_wav(
        wav, settings, transform_name=vamp_analysis.KEY_TRANSFORM_NAME_32K,
    )
    tempo = vamp_analysis.tempo_track_from_wav(wav, settings)
    assert key and all(1 <= seg["key_code"] <= 24 for seg in key)
    assert tempo is not None and any(abs(seg["bpm"] - 120.0) < 5.0 for seg in tempo)
