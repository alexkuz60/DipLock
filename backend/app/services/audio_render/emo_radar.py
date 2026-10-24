"""Кадры радара «Эмо»: динамический спектр чистого микса → 7 лучей полигона.

Спецификация владельца (08.10.2026, `docs/rules/neuromusic.md` §«Эмо»):

* окно FFT — **32768** (2^15) по моно-слиянию чистого аудио-микса (до
  эффектов 3D-цепочки); сдвиг окна между кадрами — **32000** сэмплов
  (перекрытие 768 последних сэмплов предыдущего окна) — сетка синхронизации
  анимации плеера и (в дальнейшем) дипольных эпох: кадр k ↔ время
  ``k · 32000/48000 = k · 2/3`` с;
* частотная шкала: бины собираются от **нулевого DC-бина** в 14 октавных
  блоков (``counter_blocks``, ширины 2, 2, 4, 8 … 8192, последний добирает
  бины до Найквиста включительно) и наполняют **7 счётчиков** в два захода —
  счётчик k — энергия блоков k и k+7: ``sqrt(Σ|Z|²)`` (v10);
* 7 сумм → полярная система координат: длины лучей полигона-звезды,
  шкала **глобальная и линейная** (решение совещания 22.10.2026):
  ``pct = 100·raw / global_max`` — 100 % R = максимум всех счётчиков
  всех кадров (нормировка по пику всего трека, как в старом EmoLab;
  масштаб радара 0..1 = эти проценты / 100); тишина → 0 % радиуса;
* вектор Доминанты и геометрия полигона считаются в UI существующей
  формулой ``dominantPoint`` (единая формула для рандом- и спектрального
  путей) — здесь только данные кадров;
* v3 контракта (09.10.2026): ``key_track`` — сегменты тональности микса
  (VAMP Key Detector, ``vamp_analysis``) для вращения звезды; ``None`` —
  инструмент недоступен, вращение в UI нулевое.
 * v4 контракта (09.10.2026): ``tempo_track`` — оценки темпа микса (VAMP
   Tempo and Beat Tracker, ``vamp_analysis``) для темп-коррекции радара;
   ``None`` — инструмент недоступен, коррекция в UI нулевая.
 * v5 контракта (21.10.2026): ``segment_track`` — сегменты трека (VAMP
   Segmenter, ``vamp_analysis``, «ЕмоЛаб») для визуально-слухового контроля
   (таблица в «Опциях», линии с метками имён); в расчётах не участвует.

Временный моно-файл не нужен: при рендере кадры считаются из массива
мастера в памяти, для старых кэшей — ``frames_from_wav`` по ``master.wav``.
v7 (22.10.2026, решение владельца): ФФТ — **rfft**, амплитуда бина —
``|X_k|`` (фаза не вычисляется и не используется — только амплитуды);
окно аподизации — **Блекмена-Харриса** (минимизация утечки спектра,
боковые лепестки ≈ −92 дБ); участвуют только бины **1…16384** (0…fs/2) —
зеркало отрицательных частот выше Найквиста убрано (блок 14 обрезан).
v8 (22.10.2026, решение совещания): счётчики — снова **суммы** блоков
(вариант B со средними по бинам отменён: он инвертировал спектральный
наклон и уводил доминанту в чужой квадрант), лучи — **линейная шкала по
пику трека** (``peak_rays``) взамен децибельной (20·log10 давал
перекомпрессию динамики: пышная звезда, неустойчивая доминанта).
v9 (23.10.2026, сверка со старым EmoLab): схема счётчиков уточнена
владельцем — сплошная сборка от **DC-бина** (``fft[0]`` входит в счётчик
0) блоками ширин 1, 2, 4 … 8192 в два захода по 7 счётчиков, последний
блок добирает бины до Найквиста включительно (8191–16384); счётчик 6
снова структурно силён (64 + 8194 амплитуд против 128 + 2 до v9).
v10 (23.10.2026, консультация по октавным спектрам): блоки — **ровные
октавные диапазоны** от DC (ширины 2, 2, 4, 8 … 8192, блок 0 = бины 0–1,
«0–2 Гц»), счётчики — **энергетические суммы** ``sqrt(Σ|Z|²)`` взамен сумм
амплитуд: магнитудные суммы по блокам с разбросом числа бинов 2:8193
давали веер ≈8× и «опрокидывали» звезду в 4-й квадрант (счётчик 0 терял
вес); энергия октав на розовом шуме (≈ спектр музыки) равномерна — лучи
выравниваются (``docs/emo_calc.md`` §13).
"""
import io
import json
from functools import lru_cache
from typing import Any

import numpy as np
import soundfile as sf
from scipy.signal.windows import blackmanharris

from app.services.audio_render.core import FS_AUDIO
from app.services.audio_render.vamp_analysis import KEY_SOURCE, SEGMENTER_SOURCE, TEMPO_SOURCE

# Окно FFT (2^15), сдвиг окна и перекрытие кадров (спецификация владельца).
EMO_FFT_SIZE = 32768
EMO_HOP_SAMPLES = 32000
EMO_OVERLAP_SAMPLES = EMO_FFT_SIZE - EMO_HOP_SAMPLES  # 768

# Бины rfft: 0 (DC) … EMO_NYQUIST_BIN (Найквист, fs/2). Бины выше Найквиста —
# зеркало отрицательных частот вещественного сигнала; в расчёте не участвуют
# (F1 зеркала блока 14, решение владельца 22.10.2026).
EMO_NYQUIST_BIN = EMO_FFT_SIZE // 2
EMO_BIN_COUNT = EMO_NYQUIST_BIN + 1  # бинов в rfft-спектре окна

# Окно аподизации ФФТ — **Блекмена-Харриса** (решение владельца 22.10.2026,
# v7): 4-членное, боковые лепестки ≈ −92 дБ — мощный тон не заливает соседние
# октавные блоки. Ограничение BH: при перекрытии 768 сэмплов края окна гасят
# транзиенты у границ кадров — задокументировано в docs/emo_calc.md.
# Выбор окна (опция «Окно ФФТ») отменён 24.10.2026 — окно фиксировано.
EMO_WINDOW_NAME = "blackman_harris"

# Число счётчиков = число лучей радара = число полос партитуры (7).
EMO_RAY_COUNT = 7

# Версия контракта emo.json (новые ключи — minor, ломающие — major).
# v2 (08.10.2026): лучи приведены к децибельной шкале громкости — старые
# линейные кадры parse_emo отвергает, идёт добивка из master.wav.
# v3 (09.10.2026): добавлен ``key_track`` (тональность сегментов микса из
# VAMP Key Detector) для вращения звезды; кадры v2 отвергаются → добивка.
# v4 (09.10.2026): добавлен ``tempo_track`` (оценки темпа из VAMP Tempo and
# Beat Tracker) для темп-коррекции радара; кадры v3 отвергаются → добивка.
# v5 (21.10.2026): добавлен ``segment_track`` (сегменты VAMP Segmenter,
# «ЕмоЛаб» — визуально-слуховой контроль, в расчётах не участвует);
# кадры v4 отвергаются → добивка (у рендера) / честный пересчёт («ЕмоЛаб»).
# v6 (21.10.2026): карта аккордов — Chordino «Chord Estimate» взамен QM Key
# Detector: ``label`` — точное имя аккорда («G7», «Ebm6»), ``key_code`` —
# только корневая нота + лад для звезды; кадры v5 отвергаются → пересчёт
# (старые метки «B major» — не аккорды).
# v7 (22.10.2026): ФФТ «Эмо» — rfft (бины 1…16384, зеркало выше Найквиста
# убрано), окно Блекмена-Харриса, метка ``window``; кадры v6 отвергаются →
# пересчёт («ЕмоЛаб») / добивка из master.wav (рендер).
# v8 (22.10.2026, решение совещания): счётчики — снова суммы блоков
# (вариант B со средними отменён), лучи — линейная шкала по пику трека
# (``normalization`` = ``peak_linear``) взамен децибельной, ``db_floor``
# упразднён; кадры v7 отвергаются → пересчёт/добивка.
# v9 (23.10.2026, сверка со старым EmoLab): схема счётчиков — сплошная
# сборка от DC-бина (fft[0] в счётчике 0) блоками ширин 1, 2, 4 … 8192
# в два захода по 7 счётчиков, последний блок добирает бины до Найквиста
# (8191–16384); кадры v8 отвергаются → пересчёт/добивка.
# v10 (23.10.2026, консультация по октавным спектрам): блоки — октавные
# диапазоны от DC-бина (ширины 2, 2, 4, 8 … 8192, блок 13 добирает
# Найквист — 8192–16384), счётчики — энергии sqrt(Σ|Z|²) взамен сумм
# амплитуд (веер ≈8× и «опрокидывание» звезды в 4-й квадрант); кадры v9
# отвергаются → пересчёт/добивка. Опции сравнения шага 8 (М/А, выбор окна,
# варианты) отменены решением владельца 24.10.2026 — версия остаётся v10.
EMO_SCHEMA_VERSION = 10

# Нормировка лучей: линейная по пику всего трека (решение совещания
# 22.10.2026; масштаб радара 0..1 = проценты / 100; тишина → 0 %).
EMO_NORMALIZATION = "peak_linear"


@lru_cache(maxsize=1)
def _cached_window() -> np.ndarray:
    """Собирает окно Блекмена-Харриса один раз (кэш модуля); мутировать нельзя."""
    return blackmanharris(EMO_FFT_SIZE)


def emo_window() -> np.ndarray:
    """Окно аподизации Блекмена-Харриса длины ``EMO_FFT_SIZE`` (кэш модуля).

    Окно применяется к кадру **до** FFT, включая zero-pad хвост. Когерентный
    выигрыш окна — общий множитель всех счётчиков и сокращается в шкале
    ``raw / global_max``: амплитудную коррекцию не вводим. Возвращается
    кэшированный массив — **только читать**.
    """
    return _cached_window()


def counter_blocks() -> list[tuple[int, int]]:
    """14 блоков бинов двух заходов: ``(первый бин, ширина)`` по возрастанию.

    Схема v10 (23.10.2026, консультация по октавным спектрам): сборка идёт
    сплошняком от **нулевого DC-бина** ровными октавными диапазонами бинов —
    границы блоков на степенях двойки (в герцах — октавы 0–2, 2–4, 4–8 …
    Гц×Δf): ширины **2, 2, 4, 8 … 8192**, последний блок добирает бины до
    Найквиста включительно:

    * блок 0 — бины 0–1 (``fft[0]`` DC + бин 1, «0–2 Гц»), блок 1 — 2–3,
      блок 2 — 4–7, блок 3 — 8–15, блок 4 — 16–31, блок 5 — 32–63,
      блок 6 — 64–127 (первый заход: 2 + 2 + 4 + 8 + 16 + 32 + 64 = 128
      бинов);
    * блок 7 — 128–255, блок 8 — 256–511, блок 9 — 512–1023,
      блок 10 — 1024–2047, блок 11 — 2048–4095, блок 12 — 4096–8191,
      блок 13 — 8192–16384 (ширина 8193: 8192 + Найквист-добор).

    Вместе блоки покрывают бины **0…16384 ровно по одному разу** (DC
    участвует; зеркало отрицательных частот выше ``EMO_NYQUIST_BIN`` — нет;
    страж покрытия — в ``tests/test_audio_emo.py``). Блоки 0…6 — первый
    заход наполнения счётчиков, блоки 7…13 — второй (возврат к счётчику 0).
    """
    blocks: list[tuple[int, int]] = []
    start = 0
    for index in range(EMO_RAY_COUNT * 2):
        width = 2 if index < 2 else 2**index
        if index == EMO_RAY_COUNT * 2 - 1:  # последний блок — до Найквиста
            width = EMO_NYQUIST_BIN + 1 - start
        blocks.append((start, width))
        start += width
    return blocks


def counter_sums(magnitudes: np.ndarray) -> np.ndarray:
    """Энергия бинов одного кадра → 7 счётчиков (два захода сборки).

    Счётчик k (k = 0…6) — агрегат двух блоков ``counter_blocks``: блока k
    первого захода и блока k+7 второго («7 счётчиков увеличиваются на 7 новых
    значений»). Формула — энергетическая сумма ``sqrt(Σ|X_k|²)`` (v10,
    консультация по октавным спектрам): мощности бинов **аддитивны**, корень
    извлекается **один раз на счётчик** по сумме квадратов обоих блоков. На
    розовом шуме (≈ спектр музыки) энергия октав равномерна — лучи
    сопоставимы, без веера ≈8× магнитудных сумм v9. Никаких средних
    «сумма / число бинов» нет.

    ``magnitudes`` — ``|X_k|`` ``rfft`` одного окна (длины ≥ ``EMO_BIN_COUNT``:
    бины 0…``EMO_NYQUIST_BIN``, **DC участвует** — блок 0); фаза не
    используется — только амплитуды.
    """
    mag = np.asarray(magnitudes, dtype=np.float64).ravel()
    if mag.size < EMO_BIN_COUNT:
        raise ValueError(
            f"Амплитуд должно быть ≥ {EMO_BIN_COUNT} (бины 0…{EMO_NYQUIST_BIN}), "
            f"получено {mag.size}",
        )
    power = np.zeros(EMO_RAY_COUNT, dtype=np.float64)
    for index, (start, width) in enumerate(counter_blocks()):
        segment = mag[start : start + width]
        power[index % EMO_RAY_COUNT] += float(
            np.sum(segment * segment, dtype=np.float64),
        )
    return np.sqrt(power)


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


def peak_rays(raw: np.ndarray, peak: float) -> np.ndarray:
    """Сырые счётчики кадров → лучи в % радиуса по **линейной шкале пика**.

    ``pct = 100·raw / peak`` — референс 100 % R = глобальный максимум
    ``peak`` по всем счётчикам всех кадров (**нормировка по пику всего
    трека**, механика старого EmoLab; решение совещания 22.10.2026;
    масштаб радара 0..1 = эти проценты / 100). Логарифмирование **не
    применяется**: дБ-шкала ``20·log10`` перекомпрессировала динамику —
    пышная звезда, неустойчивая доминанта, хаос эмограммы.

    ``peak <= 0`` (полная тишина) либо нулевой счётчик → 0 %. Доминанта и
    геометрия полигона считаются в UI из уже готовых процентов.
    """
    values = np.asarray(raw, dtype=np.float64)
    if peak <= 0.0:
        return np.zeros_like(values)
    return np.clip(100.0 * values / peak, 0.0, 100.0)


def _raw_counters(data: np.ndarray, starts: np.ndarray) -> np.ndarray:
    """Сырые счётчики всех кадров (энергия блоков, окно Блекмена-Харриса).

    Кадр: окно аподизации → ``|X_k|`` ``rfft`` (бины 0…16384, DC входит в
    блок 0, без зеркала) → ``counter_sums``; хвост короче ``EMO_FFT_SIZE``
    добивается нулями.
    """
    apodization = emo_window()
    raw = np.zeros((starts.size, EMO_RAY_COUNT), dtype=np.float64)
    for row, start in enumerate(starts):
        chunk = data[start : start + EMO_FFT_SIZE]
        if chunk.size < EMO_FFT_SIZE:
            padded = np.zeros(EMO_FFT_SIZE, dtype=np.float64)
            padded[: chunk.size] = chunk
            chunk = padded
        raw[row] = counter_sums(np.abs(np.fft.rfft(chunk * apodization)))
    return raw


def _frame_rows(
    starts: np.ndarray, fs: int, raw: np.ndarray,
) -> tuple[float, list[dict[str, Any]]]:
    """Сырые счётчики кадров → ``(global_max, frames)``: шкала по пику трека.

    ``pct = 100·raw / global_max`` (``peak_rays``): 100 % R = глобальный
    максимум счётчиков всех кадров **этого** варианта расчёта; тишина → нули.
    """
    peak = float(raw.max()) if raw.size else 0.0
    rays = peak_rays(raw, peak)
    frames: list[dict[str, Any]] = [
        {
            "t_sec": round(int(start) / fs, 6),
            "rays": [round(float(value), 3) for value in row],
        }
        for start, row in zip(starts, rays, strict=True)
    ]
    return peak, frames


def emo_frames(
    mono: np.ndarray,
    fs: int = FS_AUDIO,
    key_track: list[dict[str, Any]] | None = None,
    tempo_track: list[dict[str, Any]] | None = None,
    segment_track: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Кадры анимации радара «Эмо» для моно-сигнала микса.

    Окна FFT (32768, сдвиг 32000, хвост — с zero-pad) с окном аподизации
    Блекмена-Харриса → ``|X_k|`` ``rfft`` (бины 0…16384, DC входит в блок 0,
    без зеркала) → 7 счётчиков двух заходов (``counter_sums``, энергия блоков)
    → линейная шкала по пику трека (``peak_rays``):
    ``pct = 100·raw / global_max`` (100 % R = глобальный максимум счётчиков
    всех кадров, масштаб радара 0..1 = проценты / 100); тишина → нули.

    ``key_track`` — карта аккордов микса (VAMP Chordino, ``vamp_analysis``):
    ``None`` — инструмент недоступен, вращение в UI нулевое. ``tempo_track`` —
    ``segment_track`` — сегменты трека (VAMP Segmenter,
    ``vamp_analysis.segment_track_from_wav``, «ЕмоЛаб»): ``None`` — инструмент
    недоступен; данные только для визуально-слухового контроля (таблица и
    линии в UI), в расчётах лучей не участвуют.

    Возвращает dict контракта ``emo.json`` (он же ответ ``GET …/emo``):
    метаданные окна/сетки/шкалы + список кадров ``{t_sec, rays[7]}`` в
    процентах радиуса (порядок лучей — ``BAND_ORDER`` полос, δ…γ-high).
    """
    data = np.asarray(mono, dtype=np.float64).ravel()
    starts = frame_starts(data.size)
    peak, frames = _frame_rows(starts, fs, _raw_counters(data, starts))
    return {
        "schema_version": EMO_SCHEMA_VERSION,
        "fs_audio": int(fs),
        "fft_size": EMO_FFT_SIZE,
        "hop_samples": EMO_HOP_SAMPLES,
        "overlap_samples": EMO_OVERLAP_SAMPLES,
        "window": EMO_WINDOW_NAME,
        "normalization": EMO_NORMALIZATION,
        "global_max": peak,
        "duration_s": round(data.size / fs, 6),
        "frame_count": len(frames),
        "frames": frames,
        "key_track": key_track,
        "key_source": KEY_SOURCE if key_track else None,
        "tempo_track": tempo_track,
        "tempo_source": TEMPO_SOURCE if tempo_track else None,
        "segment_track": segment_track,
        "segment_source": SEGMENTER_SOURCE if segment_track else None,
    }


def frames_from_master(
    master: np.ndarray,
    fs: int = FS_AUDIO,
    key_track: list[dict[str, Any]] | None = None,
    tempo_track: list[dict[str, Any]] | None = None,
    segment_track: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Кадры из стерео-мастера рендера: моно-слияние ``(L+R)/2`` → расчёт.

    Мастер (после контроля пика) — это и есть «чистый аудио-микс до
    эффектов»: те же байты уходят в ``master.wav`` и в источник ``master``
    плеера, поэтому кадры синхронны с воспроизведением без поправок.
    """
    arr = np.asarray(master, dtype=np.float64)
    mono = arr.mean(axis=1) if arr.ndim == 2 else arr.ravel()
    return emo_frames(
        mono, fs=fs,
        key_track=key_track, tempo_track=tempo_track, segment_track=segment_track,
    )


def frames_from_wav(
    blob: bytes,
    key_track: list[dict[str, Any]] | None = None,
    tempo_track: list[dict[str, Any]] | None = None,
    segment_track: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Кадры из байтов ``master.wav`` (добивка рендеров до среза «Эмо»).

    Моно-слияние ``(L+R)/2`` и частота — из файла (контракт рендера —
    48000 Гц); временных файлов не создаётся — WAV читается в память через
    ``soundfile``.
    """
    data, samplerate = sf.read(io.BytesIO(blob), dtype="float64")
    arr = np.asarray(data)
    mono = arr.mean(axis=1) if arr.ndim == 2 else arr.ravel()
    return emo_frames(
        mono, fs=int(samplerate),
        key_track=key_track, tempo_track=tempo_track, segment_track=segment_track,
    )


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


