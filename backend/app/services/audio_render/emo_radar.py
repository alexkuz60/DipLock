"""Кадры радара «Эмо»: динамический спектр чистого микса → 7 лучей полигона.

Спецификация владельца (08.10.2026, `docs/rules/neuromusic.md` §«Эмо»):

* окно FFT — **32768** (2^15) по моно-слиянию чистого аудио-микса (до
  эффектов 3D-цепочки); сдвиг окна между кадрами — **32000** сэмплов
  (перекрытие 768 последних сэмплов предыдущего окна) — сетка синхронизации
  анимации плеера и (в дальнейшем) дипольных эпох: кадр k ↔ время
  ``k · 32000/48000 = k · 2/3`` с;
* частотная шкала логарифмическая: 14 «октавных» блоков бинов
  (``octave_blocks``) распределяются по **7 счётчикам** — счётчик k
  суммирует блоки k и k+7 (``2^k + 2^(k+7)`` амплитуд);
* 7 сумм → полярная система координат: длины лучей полигона-звезды,
  шкала **глобальная и децибельная** (решение владельца 08.10.2026):
  ``db = 20·log10(raw / global_max)`` — 0 дБ = максимум всех счётчиков
  всех кадров, порог ``EMO_DB_FLOOR`` = −60 дБ → 0 % радиуса; радиусы
  читаются в единицах громкости и «дышат» с интенсивностью микса;
* вектор Доминанты и геометрия полигона считаются в UI существующей
  формулой ``dominantPoint`` (единая формула для рандом- и спектрального
  путей) — здесь только данные кадров;
* v3 контракта (09.10.2026): ``key_track`` — сегменты тональности микса
  (VAMP Key Detector, ``vamp_analysis``) для вращения звезды; ``None`` —
  инструмент недоступен, вращение в UI нулевое.
 * v4 контракта (09.10.2026): ``tempo_track`` — оценки темпа микса (VAMP
   Tempo and Beat Tracker, ``vamp_analysis``) для темп-коррекции радара;
   ``None`` — инструмент недоступен, коррекция в UI нулевая.

Временный моно-файл не нужен: при рендере кадры считаются из массива
мастера в памяти, для старых кэшей — ``frames_from_wav`` по ``master.wav``.
Амплитуда бина — ``|X_k|`` комплексного FFT (окно прямоугольное, без
аподизации — буквально по спецификации); бины 1…32766 покрыты блоками ровно
по одному разу (DC и последний бин не участвуют).
"""
import io
import json
from typing import Any

import numpy as np
import soundfile as sf

from app.services.audio_render.core import FS_AUDIO
from app.services.audio_render.vamp_analysis import KEY_SOURCE, TEMPO_SOURCE

# Окно FFT (2^15), сдвиг окна и перекрытие кадров (спецификация владельца).
EMO_FFT_SIZE = 32768
EMO_HOP_SAMPLES = 32000
EMO_OVERLAP_SAMPLES = EMO_FFT_SIZE - EMO_HOP_SAMPLES  # 768

# Число счётчиков = число лучей радара = число полос партитуры (7).
EMO_RAY_COUNT = 7

# Версия контракта emo.json (новые ключи — minor, ломающие — major).
# v2 (08.10.2026): лучи приведены к децибельной шкале громкости — старые
# линейные кадры parse_emo отвергает, идёт добивка из master.wav.
# v3 (09.10.2026): добавлен ``key_track`` (тональность сегментов микса из
# VAMP Key Detector) для вращения звезды; кадры v2 отвергаются → добивка.
# v4 (09.10.2026): добавлен ``tempo_track`` (оценки темпа из VAMP Tempo and
# Beat Tracker) для темп-коррекции радара; кадры v3 отвергаются → добивка.
EMO_SCHEMA_VERSION = 4

# Нормировка лучей: шкала одна на весь микс (решение владельца 08.10.2026).
EMO_NORMALIZATION = "db_relative"

# Децибельная шкала громкости: глобальный максимум счётчиков = 0 дБ = 100 % R,
# порог шкалы — −60 дБ (ниже → 0 % R, «глубже» звук в тишину не показываем).
# Амплитудные суммы → дБ через 20·log10 (скорость громкости для амплитуды).
EMO_DB_FLOOR = -60.0



def octave_blocks() -> list[tuple[int, int]]:
    """14 октавных блоков бинов: ``(первый бин, ширина)`` по возрастанию.

    Блок b (b = 1…14) начинается с бина ``2^b − 1`` и шириной ``2^b``:
    блок 1 — бины 1–2, блок 2 — 3–6, блок 3 — 7–14, …, блок 7 — 127–254,
    блок 8 — 255–510, …, блок 14 — 16383–32766. Вместе блоки покрывают бины
    **1…32766 ровно по одному разу** — «все 32768 результатов» расчётного
    окна FFT без постоянной составляющей и последнего бина (страж покрытия —
    в ``tests/test_audio_emo.py``).
    """
    return [(2**b - 1, 2**b) for b in range(1, EMO_RAY_COUNT * 2 + 1)]


def counter_sums(magnitudes: np.ndarray) -> np.ndarray:
    """Суммы амплитуд бинов одного кадра → 7 октавных счётчиков.

    Счётчик k (k = 0…6) суммирует блок k+1 (ширина ``2^(k+1)``) и блок k+8
    (ширина ``2^(k+8)``) — по схеме владельца: «7 счётчиков увеличиваются на
    7 новых значений» следующих семи октав. Итого на счётчик
    ``2^(k+1) + 2^(k+8)`` амплитуд.

    ``magnitudes`` — ``|X_k|`` одного окна FFT (длины ≥ ``EMO_FFT_SIZE``).
    """
    mag = np.asarray(magnitudes, dtype=np.float64).ravel()
    if mag.size < EMO_FFT_SIZE:
        raise ValueError(
            f"Амплитуд должно быть ≥ {EMO_FFT_SIZE}, получено {mag.size}",
        )
    sums = np.zeros(EMO_RAY_COUNT, dtype=np.float64)
    for index, (start, width) in enumerate(octave_blocks()):
        sums[index % EMO_RAY_COUNT] += float(
            np.sum(mag[start : start + width], dtype=np.float64),
        )
    return sums


def frame_starts(n_samples: int) -> np.ndarray:
    """Начала окон FFT кадров в сэмплах: 0, 32000, 64000 … до конца микса.

    Число кадров = ``⌈(N − 32768)/32000⌉ + 1`` (при N ≤ 32768 — один кадр
    с zero-pad): последнее окно всегда покрывает хвост микса, при этом лишних
    окон «только из нулей» не появляется (хвост < 32000 сэмплов покрыт
    последним окном с добивкой). Пустой сигнал → пустой список кадров.
    """
    if n_samples <= 0:
        return np.zeros(0, dtype=np.int64)
    if n_samples <= EMO_FFT_SIZE:
        return np.zeros(1, dtype=np.int64)
    last = (n_samples - EMO_FFT_SIZE + EMO_HOP_SAMPLES - 1) // EMO_HOP_SAMPLES
    return np.arange(last + 1, dtype=np.int64) * EMO_HOP_SAMPLES


def db_rays(raw: np.ndarray, peak: float) -> np.ndarray:
    """Сырые счётчики кадров → лучи в % радиуса по **децибельной шкале**.

    ``db = 20·log10(raw / peak)`` — референс 0 дБ = глобальный максимум
    ``peak`` по всем счётчикам всех кадров (глобальная шкала владельца
    08.10.2026); линейная карта ``[EMO_DB_FLOOR … 0]`` дБ → ``[0 … 100]`` %
    радиуса с зажимом: −60 дБ и ниже → 0 % (тишина), 0 дБ → 100 % R.
    Так радиусы читаются в единицах громкости, а не линейной амплитуды.

    ``peak <= 0`` (полная тишина) либо нулевой счётчик → 0 %. Доминанта и
    геометрия полигона считаются в UI из уже dB-лучей — их масштаб
    наследует шкалу автоматически (без повторного перевода).
    """
    values = np.asarray(raw, dtype=np.float64)
    pct = np.zeros_like(values)
    if peak <= 0.0:
        return pct
    positive = values > 0.0
    db = 20.0 * np.log10(values[positive] / peak)  # ≤ 0 дБ
    pct[positive] = 100.0 * (db - EMO_DB_FLOOR) / (0.0 - EMO_DB_FLOOR)
    return np.clip(pct, 0.0, 100.0)


def emo_frames(
    mono: np.ndarray,
    fs: int = FS_AUDIO,
    key_track: list[dict[str, Any]] | None = None,
    tempo_track: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Кадры анимации радара «Эмо» для моно-сигнала микса.

    Окна FFT (32768, сдвиг 32000, хвост — с zero-pad) → ``|X_k|`` → 7
    счётчиков (``counter_sums``) → децибельная шкала громкости (``db_rays``):
    ``db = 20·log10(raw / global_max)`` (0 дБ = глобальный максимум счётчиков
    всех кадров), карта ``[−60 … 0]`` дБ → ``[0 … 100]`` % радиуса; тишина →
    нули.

    ``key_track`` — сегменты тональности микса (VAMP Key Detector,
    ``vamp_analysis.key_track_from_wav``): ``None`` — инструмент недоступен,
    вращение звезды в UI остаётся нулевым. ``tempo_track`` — оценки темпа
    микса (VAMP Tempo and Beat Tracker, ``vamp_analysis.tempo_track_from_wav``):
    ``None`` — инструмент недоступен, темп-коррекция в UI нулевая.

    Возвращает dict контракта ``emo.json`` (он же ответ ``GET …/emo``):
    метаданные окна/сетки/шкалы + список кадров ``{t_sec, rays[7]}`` в
    процентах радиуса (порядок лучей — ``BAND_ORDER`` полос, δ…γ-high).
    """
    data = np.asarray(mono, dtype=np.float64).ravel()
    starts = frame_starts(data.size)
    raw = np.zeros((starts.size, EMO_RAY_COUNT), dtype=np.float64)
    for row, start in enumerate(starts):
        window = data[start : start + EMO_FFT_SIZE]
        if window.size < EMO_FFT_SIZE:
            padded = np.zeros(EMO_FFT_SIZE, dtype=np.float64)
            padded[: window.size] = window
            window = padded
        raw[row] = counter_sums(np.abs(np.fft.fft(window)))
    peak = float(raw.max()) if raw.size else 0.0
    rays = db_rays(raw, peak)
    frames: list[dict[str, Any]] = [
        {
            "t_sec": round(int(start) / fs, 6),
            "rays": [round(float(value), 3) for value in row],
        }
        for start, row in zip(starts, rays, strict=True)
    ]
    return {
        "schema_version": EMO_SCHEMA_VERSION,
        "fs_audio": int(fs),
        "fft_size": EMO_FFT_SIZE,
        "hop_samples": EMO_HOP_SAMPLES,
        "overlap_samples": EMO_OVERLAP_SAMPLES,
        "normalization": EMO_NORMALIZATION,
        "db_floor": EMO_DB_FLOOR,
        "global_max": peak,
        "duration_s": round(data.size / fs, 6),
        "frame_count": len(frames),
        "frames": frames,
        "key_track": key_track,
        "key_source": KEY_SOURCE if key_track else None,
        "tempo_track": tempo_track,
        "tempo_source": TEMPO_SOURCE if tempo_track else None,
    }


def frames_from_master(
    master: np.ndarray,
    fs: int = FS_AUDIO,
    key_track: list[dict[str, Any]] | None = None,
    tempo_track: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Кадры из стерео-мастера рендера: моно-слияние ``(L+R)/2`` → расчёт.

    Мастер (после контроля пика) — это и есть «чистый аудио-микс до
    эффектов»: те же байты уходят в ``master.wav`` и в источник ``master``
    плеера, поэтому кадры синхронны с воспроизведением без поправок.
    """
    arr = np.asarray(master, dtype=np.float64)
    mono = arr.mean(axis=1) if arr.ndim == 2 else arr.ravel()
    return emo_frames(mono, fs=fs, key_track=key_track, tempo_track=tempo_track)


def frames_from_wav(
    blob: bytes,
    key_track: list[dict[str, Any]] | None = None,
    tempo_track: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Кадры из байтов ``master.wav`` (добивка рендеров до среза «Эмо»).

    Моно-слияние ``(L+R)/2`` и частота — из файла (контракт рендера —
    48000 Гц); временных файлов не создаётся — WAV читается в память через
    ``soundfile``.
    """
    data, samplerate = sf.read(io.BytesIO(blob), dtype="float64")
    arr = np.asarray(data)
    mono = arr.mean(axis=1) if arr.ndim == 2 else arr.ravel()
    return emo_frames(mono, fs=int(samplerate), key_track=key_track, tempo_track=tempo_track)


def emo_bytes(payload: dict[str, Any]) -> bytes:
    """``emo.json`` → байты: детерминированный компактный JSON (кадров много)."""
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


def parse_emo(blob: bytes) -> dict[str, Any] | None:
    """Разбор ``emo.json``; ``None`` — битый файл либо другая версия контракта."""
    try:
        payload = json.loads(blob)
    except ValueError:
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != EMO_SCHEMA_VERSION:
        return None
    return payload


