"""Тесты VAMP-анализа (Sonic Annotator): парсеры CSV Key Detector/Tempo и треки.

Юнит — разбор CSV-таблиц плагинов (составные метки, мусорные строки), запуск
``sonic-annotator`` с моком ``subprocess`` (успех/нет бинаря/нет transform/
падение/таймаут), привязка ``key_track``/``tempo_track`` к контракту кадров
«Эмо» и валидация ``AudioEmoOut``; ``integration`` — живой прогон плагинов
(бинарь в ``tools/``).

Юнит-часть **герметична**: реальный ``sonic-annotator`` не нужен — в CI его
нет (GPL-бинарь не коммитится), бинарь/transform подставляются фиктивными
(``_fake_toolchain``), чтобы мок ``subprocess.run`` действительно вызывался
(ловушка 11.10.2026: ранний выход ``_run_transform`` по ``os.path.isfile``
оставлял мок незатронутым).
"""
import subprocess
from pathlib import Path

import numpy as np
import pytest
from pydantic import ValidationError

from app.core.config import settings
from app.schemas.audio import AudioEmoOut, AudioKeySegment, AudioTempoSegment
from app.services.audio_render import emo_radar, vamp_analysis
from app.services.audio_render.vamp_analysis import KEY_SOURCE, TEMPO_SOURCE

# Выдержка реального вывода Key Detector (--csv-stdout): имя файла только в
# первой строке, метка бывает составной («Eb / D# minor»).
KEY_CSV = (
    '"master.wav",0.000000000,24,"B minor"\n'
    ',3.413333333,21,"G# minor"\n'
    ',6.144000000,12,"B major"\n'
    ',34.816000000,2,"Db major"\n'
    ',166.570666667,16,"Eb / D# minor"\n'
)


def _segments() -> list[dict]:
    """Контрольный key_track для тестов привязки к кадрам."""
    return [
        {"t_sec": 0.0, "key_code": 12, "label": "B major"},
        {"t_sec": 3.413333, "key_code": 22, "label": "Am"},
    ]


# --- юнит: парсер CSV ----------------------------------------------------------


def test_parse_key_csv_segments():
    """CSV → сегменты: времена/коды/метки, составная метка сохраняется."""
    segments = vamp_analysis.parse_key_csv(KEY_CSV)
    assert len(segments) == 5
    assert segments[0] == {"t_sec": 0.0, "key_code": 24, "label": "B minor"}
    assert segments[2]["key_code"] == 12 and segments[2]["label"] == "B major"
    assert segments[4]["t_sec"] == pytest.approx(166.570667, abs=1e-6)
    assert segments[4]["key_code"] == 16 and segments[4]["label"] == "Eb / D# minor"


def test_parse_key_csv_skips_garbage():
    """Мусорные строки (код вне 1…24, не число, короткие) — пропускаются."""
    text = (
        '"f.wav",0.0,0,"nope"\n'      # код 0 — вне диапазона
        ',1.0,25,"nope"\n'            # код 25 — вне диапазона
        ',2.0,xx,"B minor"\n'         # код не число
        "just,a\n"                    # короткая строка
        "\n"                          # пустая строка
        ',3.0,24.0,"B minor"\n'       # валидная (код как float-строка)
    )
    segments = vamp_analysis.parse_key_csv(text)
    assert segments == [{"t_sec": 3.0, "key_code": 24, "label": "B minor"}]
    assert vamp_analysis.parse_key_csv("") == []


# --- юнит: запуск sonic-annotator (мок subprocess) -----------------------------


def _fake_toolchain(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, transform_name: str) -> None:
    """Фиктивная цепочка инструмента: бинарь/transform «существуют» на диске.

    В CI нет ``tools/sonic-annotator`` (GPL-бинарь не коммитится), а
    ``_run_transform`` выходит рано по ``os.path.isfile`` — мок
    ``subprocess.run`` остаётся незатронутым и тест молча проверяет не то
    (ловушка 11.10.2026). Здесь бинарь — любой существующий файл
    (``vamp_analysis.__file__``), transform — созданный в ``tmp_path``.
    """
    (tmp_path / transform_name).write_text("# фиктивный transform\n", encoding="utf-8")
    monkeypatch.setattr(settings, "sonic_annotator_bin", vamp_analysis.__file__)
    monkeypatch.setattr(settings, "vamp_transforms_dir", str(tmp_path))


def test_key_track_from_wav_success(monkeypatch, tmp_path):
    """Успех: команда/окружение собраны верно (VAMP_PATH явно), CSV разобран."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(cmd, 0, stdout=KEY_CSV, stderr="")

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.KEY_TRANSFORM_NAME)
    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    track = vamp_analysis.key_track_from_wav(b"RIFF-fake")
    assert track is not None and len(track) == 5
    cmd = captured["cmd"]
    assert cmd[0] == settings.sonic_annotator_bin
    assert "-t" in cmd and vamp_analysis.KEY_TRANSFORM_NAME in cmd[2]
    assert cmd[-3:] == ["-w", "csv", "--csv-stdout"]
    # Ловушка сборки 1.7: VAMP_PATH обязан передаваться явно.
    assert captured["kwargs"]["env"]["VAMP_PATH"]
    # Временный WAV удалён после прогона.
    import os

    assert not os.path.exists(cmd[3])


def test_key_track_from_wav_missing_binary(monkeypatch, tmp_path):
    """Нет бинаря — None и subprocess не вызывается (best-effort, не падение)."""
    called = False

    def fake_run(*args, **kwargs):
        nonlocal called
        called = True
        raise AssertionError("subprocess не должен вызываться")

    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    monkeypatch.setattr(settings, "sonic_annotator_bin", str(tmp_path / "nope"))
    assert vamp_analysis.key_track_from_wav(b"x") is None
    assert called is False


def test_key_track_from_wav_missing_transform(monkeypatch, tmp_path):
    """Бинарь есть, transform-файла нет — None (конфигурация не собрана)."""
    monkeypatch.setattr(settings, "sonic_annotator_bin", vamp_analysis.__file__)
    monkeypatch.setattr(settings, "vamp_transforms_dir", str(tmp_path))
    assert vamp_analysis.key_track_from_wav(b"x") is None


@pytest.mark.parametrize(
    "effect",
    [
        FileNotFoundError("sonic-annotator"),
        subprocess.TimeoutExpired(cmd="sonic-annotator", timeout=1),
    ],
    ids=["not-executed", "timeout"],
)
def test_key_track_from_wav_process_failures(monkeypatch, tmp_path, effect):
    """Сбой запуска/таймаут — None, рендер и кадры не падают."""
    called = False

    def fake_run(*args, **kwargs):
        nonlocal called
        called = True
        raise effect

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.KEY_TRANSFORM_NAME)
    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    assert vamp_analysis.key_track_from_wav(b"x") is None
    # Мок обязан быть вызван: ранний выход по isfile — молчаливая потеря теста.
    assert called is True


def test_key_track_from_wav_nonzero_rc(monkeypatch, tmp_path):
    """Ненулевой код возврата (например, «buffer overflow») — None."""
    called = False

    def fake_run(cmd, **kwargs):
        nonlocal called
        called = True
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.KEY_TRANSFORM_NAME)
    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    assert vamp_analysis.key_track_from_wav(b"x") is None
    assert called is True


# --- юнит: контракт кадров «Эмо» с key_track -----------------------------------


def test_emo_frames_attach_key_track():
    """key_track попадает в payload (+key_source); без него оба поля None."""
    track = _segments()
    payload = emo_radar.emo_frames(np.ones(40_000), key_track=track)
    assert payload["key_track"] == track
    assert payload["key_source"] == KEY_SOURCE
    plain = emo_radar.emo_frames(np.ones(40_000))
    assert plain["key_track"] is None and plain["key_source"] is None


def test_audio_emo_out_validates_key_track():
    """AudioEmoOut принимает key_track; код тональности вне 1…24 — ошибка."""
    payload = emo_radar.emo_frames(np.ones(40_000), key_track=_segments())
    validated = AudioEmoOut.model_validate(payload)
    assert validated.key_track is not None
    assert validated.key_track[0].key_code == 12
    assert validated.key_source == KEY_SOURCE
    with pytest.raises(ValidationError):
        AudioKeySegment(t_sec=0.0, key_code=25, label="X")


# --- юнит: парсер CSV Tempo -----------------------------------------------------


def test_parse_tempo_csv_estimates():
    """CSV → оценки темпа: времена/bpm, метка и имя файла игнорируются."""
    text = (
        '"master.wav",0.000000000,120.185,"120,19 bpm"\n'
        ',7.430385488,90.6661,"90,67 bpm"\n'
        ',15.0,96.0,"96,00 bpm"\n'
    )
    estimates = vamp_analysis.parse_tempo_csv(text)
    assert estimates == [
        {"t_sec": 0.0, "bpm": 120.185},
        {"t_sec": 7.430385, "bpm": 90.666},
        {"t_sec": 15.0, "bpm": 96.0},
    ]


def test_parse_tempo_csv_skips_garbage():
    """Мусорные строки (bpm ≤ 0, не число, короткие) — пропускаются."""
    text = (
        '"f.wav",0.0,0,"0 bpm"\n'   # bpm 0 — не оценка
        ',1.0,-90,"-90 bpm"\n'     # отрицательный bpm
        ',2.0,xx,"xx"\n'           # bpm не число
        "just,a,b,c\n"             # время не число
        "\n"                       # пустая строка
        ',3.0,75.0,"75 bpm"\n'     # валидная
    )
    estimates = vamp_analysis.parse_tempo_csv(text)
    assert estimates == [{"t_sec": 3.0, "bpm": 75.0}]
    assert vamp_analysis.parse_tempo_csv("") == []


# --- юнит: запуск sonic-annotator для темпа (мок subprocess) --------------------


def test_tempo_track_from_wav_success(monkeypatch, tmp_path):
    """Успех: команда собрана с transform Tempo, CSV разобран в оценки."""
    captured: dict = {}
    tempo_csv = '"master.wav",0.0,120.185,"120,19 bpm"\n,1.0,122.5,"122,50 bpm"\n'

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=tempo_csv, stderr="")

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.TEMPO_TRANSFORM_NAME)
    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    track = vamp_analysis.tempo_track_from_wav(b"RIFF-fake")
    assert track == [{"t_sec": 0.0, "bpm": 120.185}, {"t_sec": 1.0, "bpm": 122.5}]
    assert vamp_analysis.TEMPO_TRANSFORM_NAME in captured["cmd"][2]


def test_tempo_track_from_wav_missing_transform(monkeypatch, tmp_path):
    """Бинарь есть, transform-файла темпа нет — None (конфигурация не собрана)."""
    monkeypatch.setattr(settings, "sonic_annotator_bin", vamp_analysis.__file__)
    monkeypatch.setattr(settings, "vamp_transforms_dir", str(tmp_path))
    assert vamp_analysis.tempo_track_from_wav(b"x") is None


def test_tempo_track_from_wav_nonzero_rc(monkeypatch, tmp_path):
    """Ненулевой код возврата — None (best-effort, как у key_track)."""
    called = False

    def fake_run(cmd, **kwargs):
        nonlocal called
        called = True
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.TEMPO_TRANSFORM_NAME)
    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    assert vamp_analysis.tempo_track_from_wav(b"x") is None
    assert called is True


# --- юнит: контракт кадров «Эмо» с tempo_track ----------------------------------


def _tempo_estimates() -> list[dict]:
    """Контрольный tempo_track для тестов привязки к кадрам."""
    return [
        {"t_sec": 0.0, "bpm": 120.0},
        {"t_sec": 3.413333, "bpm": 90.0},
    ]


def test_emo_frames_attach_tempo_track():
    """tempo_track попадает в payload (+tempo_source); без него оба поля None."""
    track = _tempo_estimates()
    payload = emo_radar.emo_frames(np.ones(40_000), tempo_track=track)
    assert payload["tempo_track"] == track
    assert payload["tempo_source"] == TEMPO_SOURCE
    plain = emo_radar.emo_frames(np.ones(40_000))
    assert plain["tempo_track"] is None and plain["tempo_source"] is None


def test_audio_emo_out_validates_tempo_track():
    """AudioEmoOut принимает tempo_track; bpm ≤ 0 — ошибка."""
    payload = emo_radar.emo_frames(np.ones(40_000), tempo_track=_tempo_estimates())
    validated = AudioEmoOut.model_validate(payload)
    assert validated.tempo_track is not None
    assert validated.tempo_track[0].bpm == 120.0
    assert validated.tempo_source == TEMPO_SOURCE
    with pytest.raises(ValidationError):
        AudioTempoSegment(t_sec=0.0, bpm=0.0)


# --- integration: живой прогон Key Detector ------------------------------------


@pytest.mark.integration
def test_key_track_live_sonic_annotator():
    """Реальный sonic-annotator + qm-keydetector по синтетическому WAV.

    Маркер ``integration``: пропускается без бинаря в ``tools/`` (в CI его
    нет); содержимое тональности не проверяем — важна работоспособность
    цепочки и формат сегментов.
    """
    import os

    from app.services.audio_render.export import wav_bytes

    if not os.path.isfile(settings.sonic_annotator_bin):
        pytest.skip("sonic-annotator не установлен")
    # Синус 440 Гц (ля первой октавы) — минимум осмысленного для детектора.
    fs = 48_000
    t = np.arange(fs * 3) / fs
    blob = wav_bytes(np.stack([np.sin(2 * np.pi * 440 * t)] * 2, axis=1), fs)
    track = vamp_analysis.key_track_from_wav(blob)
    assert track is not None
    assert all(1 <= seg["key_code"] <= 24 for seg in track)


@pytest.mark.integration
def test_tempo_track_live_sonic_annotator():
    """Реальный sonic-annotator + qm-tempotracker (вывод tempo) по щелчкам.

    Маркер ``integration``: пропускается без бинаря в ``tools/`` (в CI его
    нет); синтетические щелчки каждые 0.5 с (120 bpm) — плагин обязан найти
    темп рядом с 120 (без жёсткого допуска — важна работоспособность цепочки).
    """
    import os

    from app.services.audio_render.export import wav_bytes

    if not os.path.isfile(settings.sonic_annotator_bin):
        pytest.skip("sonic-annotator не установлен")
    fs = 48_000
    t = np.arange(fs * 8) / fs
    sig = np.zeros_like(t)
    for k in range(16):
        sig[(t >= k * 0.5) & (t < k * 0.5 + 0.02)] = 0.8
    blob = wav_bytes(np.stack([sig] * 2, axis=1), fs)
    track = vamp_analysis.tempo_track_from_wav(blob)
    assert track is not None and len(track) >= 1
    assert all(seg["bpm"] > 0 for seg in track)
    assert any(abs(seg["bpm"] - 120.0) < 5.0 for seg in track)