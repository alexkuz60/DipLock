"""Тесты VAMP-анализа (Sonic Annotator): парсеры CSV Chordino/Tempo/Segmenter.

Юнит — разбор CSV-таблиц плагинов (имена аккордов, мусорные строки, дедуп),
запуск ``sonic-annotator`` с моком ``subprocess`` (успех/нет бинаря/нет
transform/падение/таймаут), привязка ``key_track``/``tempo_track``/
``segment_track`` к контракту кадров «Эмо» и валидация ``AudioEmoOut``;
``integration`` — живой прогон плагинов (бинарь в ``tools/``).

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
from app.schemas.audio import AudioEmoOut, AudioEmoSegment, AudioKeySegment, AudioTempoSegment
from app.services.audio_render import emo_radar, vamp_analysis
from app.services.audio_render.vamp_analysis import KEY_SOURCE, SEGMENTER_SOURCE, TEMPO_SOURCE

# Выдержка реального вывода Chordino «Chord Estimate» (--csv-stdout): точки на
# сменах аккордов (без длительности), имя файла только в первой строке, «N» —
# нет аккорда. Живой прогон — 3 аккорда (C/Am/G7) по 4 с, моно 32 кГц.
CHORD_CSV = (
    '"song.wav",0.000000000,"N"\n'
    ',0.100000000,"C"\n'
    ',4.100000000,"Am"\n'
    ',8.100000000,"G7"\n'
    ',11.500000000,"N"\n'
)


def _segments() -> list[dict]:
    """Контрольный key_track (аккорды Chordino) для тестов привязки к кадрам."""
    return [
        {"t_sec": 0.1, "key_code": 1, "label": "C"},
        {"t_sec": 4.1, "key_code": 22, "label": "Am"},
    ]


# --- юнит: парсер CSV аккордов --------------------------------------------------


def test_parse_chord_csv_segments():
    """CSV → сегменты: времена/точные имена, «N» не порождает сегмент."""
    segments = vamp_analysis.parse_chord_csv(CHORD_CSV)
    assert segments == [
        {"t_sec": 0.1, "key_code": 1, "label": "C"},
        {"t_sec": 4.1, "key_code": 22, "label": "Am"},
        {"t_sec": 8.1, "key_code": 8, "label": "G7"},
    ]


def test_chord_key_code_rules():
    """Код звезды — только корневая нота + лад; уточнения интервалов мимо."""
    assert vamp_analysis.chord_key_code("C") == 1
    assert vamp_analysis.chord_key_code("Bb") == 11
    assert vamp_analysis.chord_key_code("B") == 12
    assert vamp_analysis.chord_key_code("Am") == 22
    assert vamp_analysis.chord_key_code("Ebm6") == 16
    assert vamp_analysis.chord_key_code("Dm6") == 15
    assert vamp_analysis.chord_key_code("Cdim") == 13  # малая терция → минор
    assert vamp_analysis.chord_key_code("Gaug") == 8  # мажорная основа
    assert vamp_analysis.chord_key_code("G7") == 8
    assert vamp_analysis.chord_key_code("Cmaj7") == 1
    assert vamp_analysis.chord_key_code("Csus4") == 1


def test_chord_key_code_rejects_non_chords():
    """«N» (нет аккорда), пустая/чужая метка — None (строка без сегмента)."""
    assert vamp_analysis.chord_key_code("N") is None
    assert vamp_analysis.chord_key_code("") is None
    assert vamp_analysis.chord_key_code("Xy") is None


def test_parse_chord_csv_skips_garbage_and_dedupes():
    """Мусор/дубли — мимо; «N» — разделитель: «C» после него — новый сегмент."""
    text = (
        '"f.wav",0.0,"N"\n'  # нет аккорда — без сегмента
        ',0.5,"Xy"\n'  # не аккорд
        ',xx,"C"\n'  # время не число
        "just,a,b\n"  # мусорная строка
        "\n"  # пустая строка
        ',2.0,"C"\n'  # валидная
        ',3.0,"C"\n'  # дубль подряд — схлопывается
        ',4.0,"N"\n'  # разделитель
        ',5.0,"C"\n'  # новая смена «C» — остаётся
    )
    segments = vamp_analysis.parse_chord_csv(text)
    assert segments == [
        {"t_sec": 2.0, "key_code": 1, "label": "C"},
        {"t_sec": 5.0, "key_code": 1, "label": "C"},
    ]
    assert vamp_analysis.parse_chord_csv("") == []


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
        return subprocess.CompletedProcess(cmd, 0, stdout=CHORD_CSV, stderr="")

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.CHORD_TRANSFORM_NAME)
    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    track = vamp_analysis.key_track_from_wav(b"RIFF-fake")
    assert track is not None and len(track) == 3
    cmd = captured["cmd"]
    assert cmd[0] == settings.sonic_annotator_bin
    assert "-t" in cmd and vamp_analysis.CHORD_TRANSFORM_NAME in cmd[2]
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

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.CHORD_TRANSFORM_NAME)
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

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.CHORD_TRANSFORM_NAME)
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
    assert validated.key_track[0].key_code == 1
    assert validated.key_track[0].label == "C"
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


# --- юнит: парсер CSV Segmenter ------------------------------------------------

# Выдержка реального вывода QM Segmenter (--csv-stdout): начало, длительность,
# тип, имя (метка плагина A, B, … по типу); имя файла только в первой строке.
SEGMENT_CSV = (
    '"song.wav",0.000000000,6.000000000,1,"A"\n'
    ',6.000000000,3.200000000,2,"B"\n'
    ',9.200000000,2.400000000,3,"C"\n'
    ',11.600000000,9.600000000,4,"D"\n'
    ',21.200000000,5.000000000,5,"E"\n'
    ',26.200000000,6.400000000,1,"A"\n'
)


def _segment_track() -> list[dict]:
    """Контрольный segment_track для тестов привязки к контракту кадров."""
    return [
        {"t_sec": 0.0, "segment_type": 1, "name": "A"},
        {"t_sec": 3.5, "segment_type": 2, "name": "B"},
    ]


def test_parse_segmenter_csv_segments():
    """CSV → сегменты: начала/типы/имена (A, B, … — метки плагина по типу)."""
    segments = vamp_analysis.parse_segmenter_csv(SEGMENT_CSV)
    assert len(segments) == 6
    assert segments[0] == {"t_sec": 0.0, "segment_type": 1, "name": "A"}
    assert segments[1] == {"t_sec": 6.0, "segment_type": 2, "name": "B"}
    assert segments[5] == {"t_sec": 26.2, "segment_type": 1, "name": "A"}
    times = [seg["t_sec"] for seg in segments]
    assert times == sorted(times)


def test_parse_segmenter_csv_skips_garbage():
    """Мусорные строки пропускаются, пустая метка достраивается буквой типа."""
    text = (
        '"f.wav",0.0,5.0,0,"X"\n'   # тип 0 — вне диапазона
        ',1.0,5.0,13,"X"\n'         # тип 13 — вне диапазона
        ',2.0,0.0,2,"B"\n'          # длительность 0 — не сегмент
        ',3.0,-1.0,2,"B"\n'         # отрицательная длительность
        ',4.0,xx,2,"B"\n'           # длительность не число
        "just,a,b,c,d,e\n"          # время не число
        "\n"                        # пустая строка
        ',5.0,3.0,3,\n'             # пустая метка → буква по типу (C)
    )
    segments = vamp_analysis.parse_segmenter_csv(text)
    assert segments == [{"t_sec": 5.0, "segment_type": 3, "name": "C"}]
    assert vamp_analysis.parse_segmenter_csv("") == []


def test_segment_track_from_wav_success(monkeypatch, tmp_path):
    """Успех: идёт 32k-трансформ Segmenter, CSV разобран в segment_track."""
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=SEGMENT_CSV, stderr="")

    _fake_toolchain(monkeypatch, tmp_path, vamp_analysis.SEGMENTER_TRANSFORM_NAME_32K)
    monkeypatch.setattr(vamp_analysis.subprocess, "run", fake_run)
    track = vamp_analysis.segment_track_from_wav(b"RIFF-fake")
    assert track is not None and len(track) == 6
    assert vamp_analysis.SEGMENTER_TRANSFORM_NAME_32K in captured["cmd"][2]


def test_emo_frames_attach_segment_track():
    """segment_track попадает в payload (+segment_source); без него оба None."""
    track = _segment_track()
    payload = emo_radar.emo_frames(np.ones(40_000), segment_track=track)
    assert payload["segment_track"] == track
    assert payload["segment_source"] == SEGMENTER_SOURCE
    plain = emo_radar.emo_frames(np.ones(40_000))
    assert plain["segment_track"] is None and plain["segment_source"] is None


def test_audio_emo_out_validates_segment_track():
    """AudioEmoOut принимает segment_track; тип вне 1…12 — ошибка."""
    payload = emo_radar.emo_frames(np.ones(40_000), segment_track=_segment_track())
    validated = AudioEmoOut.model_validate(payload)
    assert validated.segment_track is not None
    assert validated.segment_track[0].name == "A"
    assert validated.segment_source == SEGMENTER_SOURCE
    with pytest.raises(ValidationError):
        AudioEmoSegment(t_sec=0.0, name="X", segment_type=13)


# --- integration: живой прогон Chordino ----------------------------------------


@pytest.mark.integration
def test_chord_track_live_sonic_annotator():
    """Реальный sonic-annotator + chordino («Chord Estimate») по аккордам.

    Маркер ``integration``: пропускается без бинаря в ``tools/`` (в CI его
    нет). Синтетические аккорды по 4 с (C → Am → G7, синусы нот, моно 32 кГц) —
    плагин обязан найти все три смены с точными именами «C», «Am», «G7»
    (постановка 21.10.2026: Chordino не должен пропускать смены аккордов);
    «N» сегментом не становится.
    """
    import os

    from app.services.audio_render.export import wav_bytes

    if not os.path.isfile(settings.sonic_annotator_bin):
        pytest.skip("sonic-annotator не установлен")
    fs = 32_000

    def chord(freqs: list[float], dur: float = 4.0) -> np.ndarray:
        t = np.arange(int(fs * dur)) / fs
        return sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)

    sig = np.concatenate(
        [
            chord([261.63, 329.63, 392.0]),  # C
            chord([220.0, 261.63, 329.63]),  # Am
            chord([196.0, 246.94, 293.66, 349.23]),  # G7
        ],
    )
    blob = wav_bytes(np.stack([sig] * 2, axis=1), fs)
    track = vamp_analysis.key_track_from_wav(
        blob, transform_name=vamp_analysis.CHORD_TRANSFORM_NAME_32K,
    )
    assert track is not None and len(track) == 3
    assert [seg["label"] for seg in track] == ["C", "Am", "G7"]
    assert [seg["key_code"] for seg in track] == [1, 22, 8]
    times = [seg["t_sec"] for seg in track]
    assert times == sorted(times)
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


@pytest.mark.integration
def test_segment_track_live_sonic_annotator():
    """Реальный sonic-annotator + qm-segmenter по моно-файлу 32 кГц.

    Ловушка: плагин диктует step/block 6400/19200 при 32 кГц — с другим
    трансформом не инициализируется и сегменты молча пропадают (best-effort).
    Синтетический трек из разных фрагментов (тоны/шум) — плагин обязан найти
    несколько сегментов с именами A, B, … по типам 1…8 (без жёстких границ —
    важна работоспособность цепочки и формат имён).
    """
    import os

    from app.services.audio_render.export import wav_bytes

    if not os.path.isfile(settings.sonic_annotator_bin):
        pytest.skip("sonic-annotator не установлен")
    fs = 32_000
    t = np.arange(fs * 6) / fs

    def tone(freq: float) -> np.ndarray:
        return 0.3 * np.sin(2 * np.pi * freq * t)

    rng = np.random.default_rng(7)
    noise = 0.3 * rng.standard_normal(t.size)
    sig = np.concatenate([tone(220.0), noise, tone(880.0), tone(330.0)])
    blob = wav_bytes(np.stack([sig] * 2, axis=1), fs)
    track = vamp_analysis.segment_track_from_wav(blob)
    assert track is not None and len(track) >= 2
    assert track[0]["t_sec"] == 0.0
    assert all(1 <= seg["segment_type"] <= 8 for seg in track)
    assert all(len(seg["name"]) == 1 and "A" <= seg["name"] <= "H" for seg in track)
    times = [seg["t_sec"] for seg in track]
    assert times == sorted(times)