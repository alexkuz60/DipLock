"""Тесты кадров радара «Эмо» (спецификация 08.10.2026): FFT 32768 → 7 лучей.

Юнит — покрытие бинов октавными блоками (страж схемы владельца), суммы
счётчиков, сетка кадров 32000 сэмплов, глобальная нормировка, моно-слияние
мастера, WAV-фоллбэк и сериализация; API — ``emo.json`` в манифесте рендера,
``GET …/emo`` (контракт, 404) и добивка кадров для старого манифеста.
"""
import os
import shutil
import time

import numpy as np
import pytest

from app.core.config import settings
from app.services.audio_render import emo_radar, vamp_analysis
from app.services.audio_render import render as neuro_render
from app.services.audio_render import store as neuro_store
from app.services.audio_render.core import FS_AUDIO
from app.services.audio_render.export import wav_bytes
from app.services.prepared_signal import clear_prepared_cache
from app.services.recordings import recording_registry

_PREFIX = "/api/v1/audio"


@pytest.fixture(autouse=True)
def clean_state(tmp_path, monkeypatch):
    """Пустые состояния рендера + изолированный дисковый кэш между тестами.

    VAMP-анализ (внешний sonic-annotator) выключен: тесты герметичны, живой
    прогон плагина — ``test_audio_vamp.py`` (маркер ``integration``).
    """
    monkeypatch.setattr(settings, "cache_dir", str(tmp_path / "cache"))
    monkeypatch.setattr(vamp_analysis, "key_track_from_wav", lambda blob, cfg=None: None)
    recording_registry.clear()
    clear_prepared_cache()
    neuro_render.clear_renders()
    yield
    recording_registry.clear()
    clear_prepared_cache()
    neuro_render.clear_renders()


def _register(tmp_path, edf_path, recording_id: str = "rec-emo"):
    """Регистрирует запись так, как это делает ``POST /recordings``."""
    upload_dir = tmp_path / recording_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = upload_dir / edf_path.name
    shutil.copyfile(edf_path, target)
    return recording_registry.register(str(target), str(upload_dir), edf_path.name, settings)


def _wait_render(client, render_id: str, timeout: float = 30.0) -> dict:
    """Поллинг статуса рендера, как это делает UI."""
    deadline = time.time() + timeout
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/render/{render_id}/status").json()
        if body["status"] in ("succeeded", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"Рендер не завершился за {timeout} с: {body}")


# --- юнит: октавная схема ------------------------------------------------------


def test_octave_blocks_cover_bins_once():
    """Блоки b = 1…14 (ширина 2^b, старт 2^b − 1) покрывают бины 1…32766 ровно
    по одному разу; DC (0) и последний бин 32767 не участвуют."""
    blocks = emo_radar.octave_blocks()
    assert len(blocks) == 14
    assert [width for _, width in blocks] == [2**b for b in range(1, 15)]
    assert blocks[0] == (1, 2) and blocks[6] == (127, 128) and blocks[13] == (16383, 16384)
    covered = np.zeros(emo_radar.EMO_FFT_SIZE, dtype=np.int64)
    for start, width in blocks:
        covered[start : start + width] += 1
    assert int(covered[1:32767].min()) == 1 and int(covered[1:32767].max()) == 1
    assert covered[0] == 0 and covered[32767] == 0


def test_counter_sums_maps_blocks_to_counters():
    """Счётчик k = сумма блоков k и k+7 (по схеме владельца, «+7 новых»)."""
    magnitudes = np.arange(emo_radar.EMO_FFT_SIZE, dtype=np.float64)
    sums = emo_radar.counter_sums(magnitudes)
    blocks = emo_radar.octave_blocks()
    expected = np.zeros(emo_radar.EMO_RAY_COUNT, dtype=np.float64)
    for k in range(emo_radar.EMO_RAY_COUNT):
        for block in (blocks[k], blocks[k + 7]):
            start, width = block
            expected[k] += float(np.sum(magnitudes[start : start + width]))
    np.testing.assert_allclose(sums, expected, rtol=1e-12)


def test_counter_sums_rejects_short_input():
    """Короче окна FFT — ValueError (защита от молчаливого среза бинов)."""
    with pytest.raises(ValueError, match="32768"):
        emo_radar.counter_sums(np.ones(100))


def test_db_rays_decibel_scale():
    """Децибельная шкала громкости: 0 дБ → 100 %, −60 дБ → 0 %, линейна по дБ.

    Амплитудные счётчики переводятся 20·log10 к глобальному максимуму и
    картируются [−60…0] дБ → [0…100] % R (EMO_DB_FLOOR); тишина и нули — 0.
    """
    peak = 1000.0
    raw = np.array([peak, peak / 2, 100.0, 10.0, 1.0, 0.5, 0.0])
    pct = emo_radar.db_rays(raw, peak)
    assert pct[0] == pytest.approx(100.0)  # 0 дБ
    assert pct[1] == pytest.approx(100.0 * (60.0 - 20 * np.log10(2)) / 60.0)
    assert pct[2] == pytest.approx(100.0 * 40.0 / 60.0)  # −20 дБ → 66.67 %
    assert pct[3] == pytest.approx(100.0 * 20.0 / 60.0)  # −40 дБ → 33.33 %
    assert pct[4] == pytest.approx(0.0, abs=1e-9)  # ровно −60 дБ — на пороге
    assert pct[5] == 0.0  # ниже порога — зажато
    assert pct[6] == 0.0  # ноль счётчика
    # Полная тишина — вся шкала в нуле, без log10(0).
    np.testing.assert_array_equal(emo_radar.db_rays(np.zeros(7), 0.0), np.zeros(7))
    # Сырьё выше референса (теоретически не бывает) — зажим к 100 %.
    assert float(emo_radar.db_rays(np.array([2 * peak]), peak)[0]) == 100.0


def test_sine_peaks_in_counter_of_its_bin_and_mirror():
    """Синус ровно на бине — энергия в двух бинах (k и N−k): счётчики,
    содержащие оба, получают максимум, остальные ≈ 0 (окно прямоугольное)."""
    fs = emo_radar.EMO_FFT_SIZE  # в тесте 1 Гц на бин — частота бина = номер
    bin_index = 400  # блок 8 (бины 255–510) → счётчик 0
    t = np.arange(fs) / fs
    mono = np.sin(2 * np.pi * bin_index * t)
    sums = emo_radar.counter_sums(np.abs(np.fft.fft(mono)))
    mirror = emo_radar.EMO_FFT_SIZE - bin_index  # блок 14 → счётчик 6
    assert mirror == 32368
    assert sums[0] > 0 and sums[6] > 0
    assert sums[0] == pytest.approx(sums[6], rel=1e-9)
    assert int(np.argmax(sums)) in (0, 6)
    rest = np.delete(sums, (0, 6))
    assert float(rest.max()) < sums[0] * 1e-6


def test_frame_starts_grid():
    """Сетка окон: 0, 32000 …; число кадров = ⌈(N−32768)/32000⌉+1, хвост
    покрыт последним окном, окон «одни нули» не появляется."""
    hop = emo_radar.EMO_HOP_SAMPLES
    size = emo_radar.EMO_FFT_SIZE
    assert emo_radar.frame_starts(0).size == 0
    assert emo_radar.frame_starts(-5).size == 0
    np.testing.assert_array_equal(emo_radar.frame_starts(size), [0])
    np.testing.assert_array_equal(emo_radar.frame_starts(1000), [0])
    np.testing.assert_array_equal(emo_radar.frame_starts(size + hop), [0, hop])
    # Неполный хвост: 2 полных кадра + третий, добитый нулями до конца микса.
    np.testing.assert_array_equal(emo_radar.frame_starts(size + hop + 1), [0, hop, 2 * hop])
    for n in (50_000, 192_000, 1_000_003):
        starts = emo_radar.frame_starts(n)
        expected = 1 if n <= size else (n - size + hop - 1) // hop + 1
        assert starts.size == expected
        assert starts[-1] < n and starts[-1] + size >= n  # хвост покрыт


def test_emo_frames_contract_and_global_normalization():
    """Контракт кадров: сетка t_sec, 7 лучей ≤ 100, максимум микса = 100 % R
    (децибельная шкала от глобального максимума), детерминизм."""
    rng = np.random.default_rng(42)
    n = 192_000  # 4 с @48 кГц, как у тестового EDF
    mono = rng.standard_normal(n)
    mono[96_000:] *= 5.0  # вторая половина микса громче — «дыхание» между кадрами
    payload = emo_radar.emo_frames(mono)
    assert payload["schema_version"] == emo_radar.EMO_SCHEMA_VERSION == 4
    assert payload["tempo_track"] is None and payload["tempo_source"] is None
    assert payload["fs_audio"] == FS_AUDIO
    assert payload["fft_size"] == 32768 and payload["fft_size"] == 2**15
    assert payload["hop_samples"] == 32000 and payload["overlap_samples"] == 768
    assert payload["normalization"] == "db_relative"
    assert payload["db_floor"] == emo_radar.EMO_DB_FLOOR == -60.0
    assert payload["global_max"] > 0
    assert payload["duration_s"] == pytest.approx(4.0, abs=1e-6)
    assert payload["frame_count"] == len(payload["frames"]) == 6
    hop_sec = 32000 / FS_AUDIO
    for index, frame in enumerate(payload["frames"]):
        assert frame["t_sec"] == pytest.approx(index * hop_sec, abs=1e-6)
        assert len(frame["rays"]) == emo_radar.EMO_RAY_COUNT
        assert all(0.0 <= value <= 100.0 for value in frame["rays"])
    # Глобальная нормировка: ровно один (первый встреченный) луч = 100 %.
    peak = max(max(frame["rays"]) for frame in payload["frames"])
    assert peak == 100.0
    assert emo_radar.emo_frames(mono) == payload  # детерминизм


def test_emo_frames_silence_is_zero_rays():
    """Полная тишина: кадры на месте, лучи и global_max — нули, без NaN."""
    payload = emo_radar.emo_frames(np.zeros(40_000))
    assert payload["frame_count"] == len(payload["frames"]) == 2
    assert payload["global_max"] == 0.0
    assert all(value == 0.0 for frame in payload["frames"] for value in frame["rays"])
    assert all(np.isfinite(value) for frame in payload["frames"] for value in frame["rays"])


def test_frames_from_master_mono_blend():
    """Моно-слияние (L+R)/2: одинаковые каналы = моно; антифаза = тишина."""
    rng = np.random.default_rng(7)
    mono = rng.standard_normal(40_000) * 0.1
    stereo = np.column_stack([mono, mono])
    same = emo_radar.frames_from_master(stereo)
    direct = emo_radar.emo_frames(mono)
    assert same["frame_count"] == direct["frame_count"]
    assert [frame["rays"] for frame in same["frames"]] == [
        frame["rays"] for frame in direct["frames"]
    ]
    anti = np.column_stack([mono, -mono])
    assert emo_radar.frames_from_master(anti)["global_max"] == 0.0


def test_frames_from_wav_roundtrip():
    """Байты master.wav → те же кадры (частота из файла, без временных файлов)."""
    rng = np.random.default_rng(11)
    # Амплитуда ≪ 1: PCM_24 клипует |x| > 1 — иначе форма лучей исказится.
    mono = np.clip(rng.standard_normal(40_000) * 0.2, -0.9, 0.9)
    payload = emo_radar.frames_from_wav(wav_bytes(np.column_stack([mono, mono])))
    expected = emo_radar.emo_frames(mono)
    assert payload["fs_audio"] == FS_AUDIO
    assert payload["frame_count"] == expected["frame_count"]
    assert [frame["t_sec"] for frame in payload["frames"]] == [
        frame["t_sec"] for frame in expected["frames"]
    ]
    # PCM_24 квантование + округление до 0.001 % R не меняют форму заметнее.
    np.testing.assert_allclose(
        [frame["rays"] for frame in payload["frames"]],
        [frame["rays"] for frame in expected["frames"]],
        atol=2e-3,
    )


def test_emo_bytes_parse_roundtrip():
    """Сериализация детерминирована; битый/чужой файл — None."""
    payload = emo_radar.emo_frames(np.ones(40_000))
    blob = emo_radar.emo_bytes(payload)
    assert emo_radar.parse_emo(blob) == payload
    assert emo_radar.emo_bytes(payload) == blob  # детерминизм байтов
    assert emo_radar.parse_emo(b"not json") is None
    assert emo_radar.parse_emo(b'{"schema_version": 99}') is None


# --- API: манифест рендера, GET …/emo, добивка старого манифеста ---------------


def test_render_writes_emo_and_endpoint_serves(client, tmp_path, edf_file):
    """Полный цикл: рендер кладёт emo.json в манифест, GET …/emo — контракт."""
    recording = _register(tmp_path, edf_file)
    started = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "boost_db": 0.0, "loudness_phon": None},
    )
    assert started.status_code == 202, started.text
    render_id = started.json()["render_id"]
    done = _wait_render(client, render_id)
    assert done["status"] == "succeeded", done.get("error")

    manifest = neuro_store.load_manifest(settings, recording.recording_id, render_id)
    assert manifest is not None
    assert neuro_store.EMO_NAME in manifest["files"]

    body = client.get(f"{_PREFIX}/render/{render_id}/emo")
    assert body.status_code == 200, body.text
    payload = body.json()
    assert payload["schema_version"] == emo_radar.EMO_SCHEMA_VERSION
    assert payload["fs_audio"] == FS_AUDIO
    assert payload["fft_size"] == 32768 and payload["hop_samples"] == 32000
    assert payload["overlap_samples"] == 768
    assert payload["normalization"] == "db_relative"
    assert payload["db_floor"] == emo_radar.EMO_DB_FLOOR
    assert payload["global_max"] > 0
    assert payload["frame_count"] == len(payload["frames"])
    assert payload["key_track"] is None and payload["key_source"] is None
    expected = emo_radar.frame_starts(
        round(payload["duration_s"] * FS_AUDIO),
    ).size
    assert payload["frame_count"] == expected >= 1
    hop_sec = emo_radar.EMO_HOP_SAMPLES / FS_AUDIO
    for index, frame in enumerate(payload["frames"]):
        assert frame["t_sec"] == pytest.approx(index * hop_sec, abs=1e-4)
        assert len(frame["rays"]) == emo_radar.EMO_RAY_COUNT
    # Глобальная шкала: лучей ровно на 100 % (максимум микса) и нет NaN.
    assert max(max(frame["rays"]) for frame in payload["frames"]) == 100.0
    assert all(
        np.isfinite(value) for frame in payload["frames"] for value in frame["rays"]
    )


def test_emo_unknown_render_is_404(client):
    """Неизвестный render_id — 404 (как у файлов рендера)."""
    assert client.get(f"{_PREFIX}/render/deadbeef/emo").status_code == 404


def test_emo_backfills_old_manifest_without_emo(client, tmp_path, edf_file):
    """Рендер без emo.json (срез до «Эмо»): кадры добиваются из master.wav,
    файл и запись в files манифеста появляются, повторный GET — из кэша."""
    recording = _register(tmp_path, edf_file, recording_id="rec-emo-backfill")
    started = client.post(
        f"{_PREFIX}/render",
        json={"recording_id": recording.recording_id, "boost_db": 0.0, "loudness_phon": None},
    )
    render_id = started.json()["render_id"]
    assert _wait_render(client, render_id)["status"] == "succeeded"

    # Симулируем старый кэш: манифест без emo.json и без самого файла.
    directory = neuro_store.render_dir(settings, recording.recording_id, render_id)
    manifest = neuro_store.load_manifest(settings, recording.recording_id, render_id)
    assert manifest is not None
    manifest["files"].pop(neuro_store.EMO_NAME, None)
    assert neuro_store.write_manifest(
        settings, recording.recording_id, render_id, manifest,
    )
    os.unlink(os.path.join(directory, neuro_store.EMO_NAME))
    neuro_render.clear_renders()  # состояние рендера только из манифеста диска

    body = client.get(f"{_PREFIX}/render/{render_id}/emo")
    assert body.status_code == 200, body.text
    payload = body.json()
    assert payload["frame_count"] >= 1
    assert os.path.isfile(os.path.join(directory, neuro_store.EMO_NAME))
    fresh = neuro_store.load_manifest(settings, recording.recording_id, render_id)
    assert fresh is not None and neuro_store.EMO_NAME in fresh["files"]

    # Второй GET — из дописанного артефакта (тот же контракт).
    again = client.get(f"{_PREFIX}/render/{render_id}/emo")
    assert again.status_code == 200
    assert again.json()["frame_count"] == payload["frame_count"]



