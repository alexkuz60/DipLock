"""Тесты IR-ассетов «Нейромузыки» (spatial-audio, п.2): генерация, кэш, роуты.

Контракт: ``GET /audio/ir`` — каталог; ``GET /audio/ir/{id}.wav`` — стерео-IR
48 кГц/PCM_24 с ETag/304; детерминизм (одинаковые входы → одинаковые байты);
неизвестный пресет — 404.
"""
import io

import numpy as np
import pytest
import soundfile as sf

from app.services import audio_ir

_PREFIX = "/api/v1/audio"


def test_catalog_lists_all_presets(client):
    """Каталог отдаёт все пресеты с id/label/описанием — для селекта UI."""
    response = client.get(f"{_PREFIX}/ir")
    assert response.status_code == 200
    presets = response.json()["presets"]
    assert [preset["id"] for preset in presets] == audio_ir.preset_ids()
    for preset in presets:
        assert preset["label"] and preset["description"]


def test_ir_wav_is_stereo_48k_pcm24(client):
    """IR — стерео WAV 48 кГц/PCM_24, конечные значения, пик в допуске."""
    response = client.get(f"{_PREFIX}/ir/room_small.wav")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    assert response.headers.get("etag")
    with sf.SoundFile(io.BytesIO(response.content)) as handle:
        assert handle.samplerate == 48000
        assert handle.channels == 2
        assert handle.subtype == "PCM_24"
        data = handle.read(dtype="float64")
    assert np.isfinite(data).all()
    # Нормировка пика к потолку мастера (0.891): PCM_24 не клипчит.
    assert np.abs(data).max() <= 0.891 + 1e-6
    # IR — не тишина: прямой приход даёт заметный отсчёт.
    assert np.abs(data).max() > 0.1


def test_ir_generation_is_deterministic(tmp_path, monkeypatch):
    """Повторная генерация того же пресета даёт идентичные байты (детерминизм)."""
    monkeypatch.setattr(audio_ir.settings, "cache_dir", str(tmp_path))
    first = audio_ir.generate_ir(audio_ir.get_preset("cranium"))
    second = audio_ir.generate_ir(audio_ir.get_preset("cranium"))
    assert first == second
    assert audio_ir.ir_version(first) == audio_ir.ir_version(second)


def test_ir_cache_written_and_reused(tmp_path, monkeypatch):
    """Первый запрос пишет кэш-файл, повтор читает его без пересчёта."""
    monkeypatch.setattr(audio_ir.settings, "cache_dir", str(tmp_path))
    first = audio_ir.ir_bytes("room_small")
    path = audio_ir.ir_path("room_small")
    assert (tmp_path / "ir" / "room_small.wav").read_bytes() == first
    # Читаем из кэша напрямую (сервис вернёт те же байты).
    from app.services.cache_store import cache_read

    assert cache_read(str(path)) == first


def test_ir_unknown_preset_404(client):
    """Неизвестный пресет — 404 с перечнем доступных (текст для UI)."""
    response = client.get(f"{_PREFIX}/ir/no_such.wav")
    assert response.status_code == 404
    assert "room_small" in response.json()["detail"]


def test_brainroom_presets_in_catalog_with_canonical_proportions(client):
    """BrainRoom: три дискретных размера (2/3.5/5 м), пропорции сверху 1.0:1.3.

    Спецификация владельца 07.10.2026: слушатель внутри муляжа черепа
    габаритом 2…5 м (иначе слух не локализует источники), пропорции
    канонические, размер дискретный — IR-байты стабильны.
    """
    response = client.get(f"{_PREFIX}/ir")
    assert response.status_code == 200
    presets = {preset["id"]: preset for preset in response.json()["presets"]}
    for preset_id, length_m in (
        ("brainroom_s", 2.0),
        ("brainroom_m", 3.5),
        ("brainroom_l", 5.0),
    ):
        assert preset_id in presets, f"пресет {preset_id} отсутствует в каталоге"
        assert presets[preset_id]["tags"] == ["brainroom", "муляж черепа"]
        preset = audio_ir.get_preset(preset_id)
        assert preset is not None
        width, length, height = preset.dims_m
        assert length == pytest.approx(length_m)  # габарит = длина
        assert width == pytest.approx(length_m / 1.3)  # вид сверху 1.0 : 1.3
        assert height == pytest.approx(width)  # высота ≈ ширина
        # Слушатель в центре комнаты.
        assert preset.mic_m[0] == pytest.approx(width / 2)
        assert preset.mic_m[2] == pytest.approx(height / 2)


def test_brainroom_ir_is_generated_deterministic(tmp_path, monkeypatch):
    """BrainRoom IR генерируется детерминированно и отдаётся WAV 48кГц/стерео."""
    monkeypatch.setattr(audio_ir.settings, "cache_dir", str(tmp_path))
    first = audio_ir.generate_ir(audio_ir.get_preset("brainroom_s"))
    second = audio_ir.generate_ir(audio_ir.get_preset("brainroom_s"))
    assert first == second
    with sf.SoundFile(io.BytesIO(first)) as handle:
        assert handle.samplerate == 48000
        assert handle.channels == 2
        data = handle.read(dtype="float64")
    assert np.isfinite(data).all()
    assert np.abs(data).max() <= 0.891 + 1e-6
    assert np.abs(data).max() > 0.1  # не тишина


def test_ir_etag_304(client):
    """If-None-Match с текущим ETag → 304 без тела (ассет-помощник A2)."""
    first = client.get(f"{_PREFIX}/ir/room_large.wav")
    assert first.status_code == 200
    etag = first.headers["etag"]
    second = client.get(f"{_PREFIX}/ir/room_large.wav", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""
