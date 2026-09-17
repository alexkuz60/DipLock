"""Спектрограмма канала для раздела «ЭЭГ» (срез 5): STFT → сетка уровней в дБ.

Зачем отдельный сервис
----------------------
Разделу «ЭЭГ» нужен **один выбранный канал** в двух видах: сырой трек и
спектрограмма под ним. Спектр по ритмам (`services/spectral.py`, срез 3.4)
усредняет запись по эпохам и отвечает на вопрос «сколько мощности в ритме».
Здесь вопрос другой: «когда именно появился ритм» — для этого нужна
**time-frequency**-разметка, то есть короткое окно с перекрытием.

Что считается
-------------
* сигнал читается тем же загрузчиком, что и весь пайплайн (`load_edf`: монтаж
  10-20, average reference, band-pass, notch) — фильтр применяется к
  **continuous raw** до нарезки, как везде в проекте;
* канал — ровно один (`params.channel`): спектрограмма каждого канала вьюера
  не нужна, а «средняя по каналам спектрограмма» смысла не имеет (у каналов
  разная топография);
* окно — окно Ханна ``window_ms``, шаг — ``window_ms × (1 − overlap)``,
  ``n_fft`` — степень двойки не короче окна;
* значения — уровень **амплитуды** в дБ: ``20·lg(2·|X|/Σw + ε)``, где X — FFT
  окна, Σw — нормировка окна, амплитуда в мкВ (MNE отдаёт вольты → ×1e6);
* пол шкалы — ``db_max − 60 дБ``: ниже лежит шум, и растягивать по нему
  палитру незачем. ``db_max`` — 99.9-й процентиль: один выброс артефакта не
  должен «прижимать» всю остальную картинку.

Сетка — числа, а не картинка
----------------------------
Топокарты ритмов отдаются PNG (срез 3.4), потому что палитру рисовать на
сервере незачем. Здесь наоборот: **палитра, окно дБ и сглаживание — параметры
просмотра**, их правят без пересчёта, поэтому сервер отдаёт сетку float32
(``SpectrogramGridHeader``: ``DPS2`` | заголовок | значения, frequency-major),
а UI сам красит, кадрирует и сглаживает её. Иначе каждая правка окна дБ
запускала бы задачу — ровно то, что правилами проекта запрещено.

Кэш
---
Сетка кладётся на диск (``cache_dir/spectrograms/<recording_id>/<signature>.bin``)
и отдаётся с ETag. ``signature`` — отпечаток расчёта (канал, полоса, notch,
окно, перекрытие, верхняя частота, набор каналов): сменили окно — сменилась
подпись, и старая сетка не «залипнет» в кэше браузера.
"""
import hashlib
import logging
import struct
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.core.config import Settings
from app.schemas.analysis import SpectrogramGridHeader
from app.services import journal
from app.services.cache_store import cache_clear, cache_path, cache_write
from app.services.prepared_signal import prepared_raw
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Метка формата контейнера (см. ``SpectrogramGridHeader``)
MAGIC = b"DPS2"
_HEADER_LEN_FMT = "<I"

# Окно STFT по умолчанию: 500 мс — компромисс между временным разрешением
# (полсекунды видно глазами) и частотным (2 Гц — α от θ отличим).
SPECTROGRAM_WINDOW_MS = 500.0
SPECTROGRAM_WINDOW_RANGE_MS: tuple[float, float] = (64.0, 4000.0)
SPECTROGRAM_OVERLAP_PCT = 75.0
SPECTROGRAM_OVERLAP_RANGE_PCT: tuple[float, float] = (0.0, 95.0)
# Верхняя частота сетки по умолчанию: 40 Гц — верхняя граница ЭЭГ-ритмов.
# Граница ввода — 120 Гц: выше начинается область, которой в ЭЭГ нет.
SPECTROGRAM_FMAX_HZ = 40.0
SPECTROGRAM_FMAX_RANGE_HZ: tuple[float, float] = (1.0, 120.0)

# Пол шкалы дБ относительно потолка (шум ниже пола в палитру не попадает)
SPECTROGRAM_DB_FLOOR = 60.0

# Предохранитель от «сетки на миллион столбцов»: 20 000 окон × 257 частот —
# это уже ~20 МБ float32, больше по HTTP возить незачем. Достигается только
# очень коротким окном на длинной записи — текст ошибки говорит, что делать.
SPECTROGRAM_MAX_FRAMES = 20000

# Сколько окон считаем за один проход: прогресс задачи виден, а память не растёт
SPECTROGRAM_CHUNK_FRAMES = 256


class SpectrogramError(ValueError):
    """Ошибка параметров/данных спектрограммы — превращается в понятный текст задачи."""


@dataclass
class SpectrogramParams:
    """Параметры расчёта спектрограммы (плоская проекция формы запроса)."""

    channel: str = ""
    filter_band: tuple[float, float] | None = None
    notch_hz: float | None = None
    reference: str = "average"
    reference_channels: list[str] | None = None
    window_ms: float = SPECTROGRAM_WINDOW_MS
    overlap_pct: float = SPECTROGRAM_OVERLAP_PCT
    fmax_hz: float = SPECTROGRAM_FMAX_HZ


def validate_params(params: SpectrogramParams, cfg: Settings) -> None:
    """Проверка параметров: 400 с понятным текстом, а не «странная картинка».

    Зажимать значения молча нельзя: пользователь прислал окно 5000 мс, а получил
    бы 4000 — и не понял, почему спектрограмма другая.
    """
    if not params.channel.strip():
        raise SpectrogramError("Спектрограмма считается по одному каналу: канал не указан")
    low, high = SPECTROGRAM_WINDOW_RANGE_MS
    if not low <= params.window_ms <= high:
        raise SpectrogramError(f"Окно STFT должно быть от {low:g} до {high:g} мс")
    low, high = SPECTROGRAM_OVERLAP_RANGE_PCT
    if not low <= params.overlap_pct <= high:
        raise SpectrogramError(f"Перекрытие окон должно быть от {low:g} до {high:g} %")
    low, high = SPECTROGRAM_FMAX_RANGE_HZ
    if not low <= params.fmax_hz <= high:
        raise SpectrogramError(f"Верхняя частота должна быть от {low:g} до {high:g} Гц")
    if params.notch_hz is not None and params.notch_hz <= 0:
        raise SpectrogramError("Частота сетевого фильтра должна быть положительной")


def spectrogram_signature(
    params: SpectrogramParams, cfg: Settings, channels: Sequence[str],
) -> str:
    """Отпечаток расчёта: ключ дискового кэша сетки и её ETag.

    Канал входит осознанно: сетки разных каналов — разные данные, и подменять
    одну другой нельзя.
    """
    digest = hashlib.sha256()
    band = f"{params.filter_band[0]:g}-{params.filter_band[1]:g}" if params.filter_band else "none"
    digest.update("|".join((
        params.channel,
        band,
        f"notch={params.notch_hz}",
        f"win={params.window_ms:g}",
        f"overlap={params.overlap_pct:g}",
        f"fmax={params.fmax_hz:g}",
        f"ref={params.reference}",
        # Каналы своей ссылки обязаны входить в отпечаток (A11): иначе сетка,
        # посчитанная со ссылкой «F3,F4», отдавалась бы как сетка другой ссылки.
        f"ref_ch={','.join(params.reference_channels or [])}",
        ",".join(channels),
    )).encode("utf-8"))
    return digest.hexdigest()[:16]


def grid_path(cfg: Settings, recording_id: str, signature: str) -> str:
    """Путь сетки в дисковом кэше."""
    return cache_path(cfg.cache_dir, "spectrograms", recording_id, f"{signature}.bin")


def grid_url(cfg: Settings, recording_id: str, job_id: str) -> str:
    """URL бинарной сетки задачи (версию клиент добавляет из `grid_version`)."""
    return f"{cfg.api_prefix}/recordings/{recording_id}/spectrogram/{job_id}/grid.bin"


def clear_spectrogram_cache(cfg: Settings, recording_id: str | None = None) -> None:
    """Удаляет дисковый кэш спектрограмм: одну запись или весь (тесты и реестр)."""
    parts = ("spectrograms", recording_id) if recording_id else ("spectrograms",)
    cache_clear(cfg.cache_dir, *parts)


def stft_grid(
    data_uv: np.ndarray,
    sfreq: float,
    params: SpectrogramParams,
    progress: Any = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """STFT одного канала: ``(freqs, times, db, n_fft)``.

    Чистая функция (без MNE и диска) — её и проверяет тест сервиса: тон 10 Гц
    обязан дать максимум на 10 Гц, а уровень — расти вместе с амплитудой.
    """
    report = progress or (lambda *args, **kwargs: None)
    n_times = data_uv.shape[0]
    n_per_seg = max(8, round(params.window_ms / 1000.0 * sfreq))
    if n_per_seg > n_times:
        raise SpectrogramError(
            f"Запись короче окна STFT ({n_times} отсчётов < {n_per_seg}): "
            "уменьшите окно или возьмите запись подлиннее"
        )
    # Окно FFT — степень двойки не короче сегмента: rfft по такой длине
    # считается быстро и не «размазывает» пик нулевым дополнением.
    n_fft = 8
    while n_fft < n_per_seg:
        n_fft *= 2

    hop = max(1, round(n_per_seg * (1.0 - params.overlap_pct / 100.0)))
    starts = np.arange(0, n_times - n_per_seg + 1, hop, dtype=np.int64)
    if starts.size == 0:
        starts = np.array([0], dtype=np.int64)
    if starts.size > SPECTROGRAM_MAX_FRAMES:
        raise SpectrogramError(
            f"Окон STFT слишком много ({starts.size} > {SPECTROGRAM_MAX_FRAMES}): "
            "увеличьте окно или уменьшите перекрытие"
        )

    window = np.hanning(n_per_seg)
    norm = float(window.sum()) or 1.0
    offsets = np.arange(n_per_seg, dtype=np.int64)
    scale = 2.0 / norm
    epsilon = 1e-6  # мкВ: ниже этого уровня сигнала нет, lg(0) недопустим

    n_freqs_total = n_fft // 2 + 1
    db = np.empty((starts.size, n_freqs_total), dtype=np.float32)
    report("stft", message=f"STFT: {starts.size} окон", epochs_done=0, epochs_total=int(starts.size))
    for begin in range(0, starts.size, SPECTROGRAM_CHUNK_FRAMES):
        end = min(starts.size, begin + SPECTROGRAM_CHUNK_FRAMES)
        index = starts[begin:end, None] + offsets[None, :]
        frames = data_uv[index] * window[None, :]
        spectrum = np.fft.rfft(frames, n=n_fft, axis=1)
        amplitude = np.abs(spectrum) * scale  # single-sided, мкВ
        db[begin:end, :] = 20.0 * np.log10(amplitude + epsilon)
        report(
            "stft",
            message=f"STFT: окно {end} из {starts.size}",
            epochs_done=int(end),
            epochs_total=int(starts.size),
        )

    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sfreq)
    times = (starts + n_per_seg / 2.0) / sfreq
    keep = freqs <= params.fmax_hz + 1e-9
    # Транспонируем сразу: сетка живёт как (частоты × времена) — строки картинки
    return freqs[keep], times, np.asarray(db[:, keep].T), n_fft


def _levels(db: np.ndarray) -> tuple[float, float]:
    """Потолок и пол шкалы дБ: процентиль, а не максимум (выброс не «съедает» картинку)."""
    finite = db[np.isfinite(db)]
    if finite.size == 0:
        return 0.0, -SPECTROGRAM_DB_FLOOR
    top = float(np.percentile(finite, 99.9))
    return top - SPECTROGRAM_DB_FLOOR, top


def build_grid_blob(header: SpectrogramGridHeader, db: np.ndarray) -> bytes:
    """Собирает контейнер сетки: ``DPS2`` | длина заголовка | JSON | float32 LE.

    Значения лежат частото-мажорно: строка сетки — строка картинки, и клиент
    читает её без перестановок по всему массиву.
    """
    payload = np.ascontiguousarray(db, dtype="<f4").tobytes()
    raw = header.model_dump_json().encode("utf-8")
    return MAGIC + struct.pack(_HEADER_LEN_FMT, len(raw)) + raw + payload


def read_grid_blob(data: bytes) -> tuple[SpectrogramGridHeader, np.ndarray]:
    """Разбирает контейнер сетки обратно (нужно тестам и ленивому пересчёту)."""
    if len(data) < 8 or data[:4] != MAGIC:
        raise SpectrogramError("Неожиданный формат сетки спектрограммы")
    (header_len,) = struct.unpack(_HEADER_LEN_FMT, data[4:8])
    end = 8 + header_len
    if end > len(data):
        raise SpectrogramError("Заголовок сетки выходит за границы ответа")
    header = SpectrogramGridHeader.model_validate_json(data[8:end])
    payload = np.frombuffer(data, dtype="<f4", offset=end)
    expected = header.n_freqs * header.n_times
    if payload.size != expected:
        raise SpectrogramError(
            f"Размер сетки не совпал: {payload.size} значений вместо {expected}"
        )
    return header, payload.reshape(header.n_freqs, header.n_times)


def _prepare_signal(
    recording: Recording, cfg: Settings, params: SpectrogramParams,
) -> tuple[np.ndarray, float, list[str]]:
    """Читает запись и отдаёт данные одного канала в мкВ: ``(data, sfreq, channels)``.

    Сигнал берётся из кэша подготовленного сигнала (A4): смена канала или окна
    STFT — параметры просмотра, и они не должны заставлять перечитывать EDF,
    если параметры фильтра те же.
    """
    l_freq: float | None = None
    h_freq: float | None = None
    if params.filter_band is not None:
        l_freq, h_freq = params.filter_band

    try:
        raw = prepared_raw(
            recording,
            cfg,
            l_freq=l_freq,
            h_freq=h_freq,
            notch_hz=params.notch_hz,
            reference_channels=params.reference_channels,
            pipeline="spectrogram",
        )
    except ValueError as exc:
        raise SpectrogramError(str(exc)) from exc

    channels = list(raw.ch_names)
    if params.channel not in channels:
        raise SpectrogramError(
            f"Канал {params.channel} не найден в записи. Доступные: {', '.join(channels)}"
        )
    # ×1e6: MNE отдаёт вольты, а сетка (как и мощности в spectral.py) считается
    # в микровольтах — единицы должны быть одни на весь проект.
    data = raw.get_data(picks=[params.channel], verbose=False)[0] * 1e6
    return np.asarray(data, dtype=float), float(raw.info["sfreq"]), channels


def compute_spectrogram(
    recording: Recording,
    cfg: Settings,
    params: SpectrogramParams,
    progress: Any = None,
) -> dict[str, Any]:
    """Считает сетку STFT, кладёт её на диск и отдаёт dict под ``SpectrogramResult``.

    Воркер не зависит от схемы ответа (её валидирует API), поэтому результат —
    обычный dict, а прогресс доступен по ходу вычислений. ``grid_url`` здесь
    пустой: его подставляет роут, когда знает ``job_id`` задачи.
    """
    report = progress or (lambda *args, **kwargs: None)
    started = time.perf_counter()
    validate_params(params, cfg)
    report("load_edf", message="Чтение EDF, монтаж 10-20")

    data, sfreq, channels = _prepare_signal(recording, cfg, params)
    with journal.step(
        "spectrogram", "stft",
        note=(
            f"channel={params.channel}, window={params.window_ms:g}ms, "
            f"overlap={params.overlap_pct:g}%, fmax={params.fmax_hz:g}"
        ),
    ) as entry:
        freqs, times, db, n_fft = stft_grid(data, sfreq, params, progress=report)
        entry.epochs = int(times.size)
        entry.bytes_out = int(db.nbytes)
    if not freqs.size or not times.size:
        raise SpectrogramError("Сетка спектрограммы пуста: проверьте окно и верхнюю частоту")

    db_min, db_max = _levels(db)
    duration_sec = float(data.shape[0]) / sfreq if sfreq > 0 else 0.0
    signature = spectrogram_signature(params, cfg, channels)
    header = SpectrogramGridHeader(
        recording_id=recording.recording_id,
        channel=params.channel,
        window_ms=params.window_ms,
        overlap_pct=params.overlap_pct,
        fmax_hz=params.fmax_hz,
        sfreq=round(sfreq, 6),
        n_fft=n_fft,
        n_freqs=int(db.shape[0]),
        n_times=int(db.shape[1]),
        db_min=round(db_min, 3),
        db_max=round(db_max, 3),
    )
    with journal.step(
        "spectrogram", "grid_write", params_key=signature,
        epochs=int(times.size), note="формат DPS2",
    ) as entry:
        blob = build_grid_blob(header, db)
        entry.bytes_out = len(blob)
        _write_grid(cfg, recording.recording_id, signature, blob)

    warnings: list[str] = []
    if times.size and times[-1] < duration_sec - 1e-6:
        # Хвост записи короче окна: последние окна в сетку не попали
        warnings.append(
            "Хвост записи короче окна STFT — последние "
            f"{duration_sec - float(times[-1]):.2f} с в спектрограмму не попали"
        )

    report(
        "done", 1.0,
        message=f"Спектрограмма готова: {db.shape[0]} частот × {db.shape[1]} окон",
        epochs_done=int(times.size),
        epochs_total=int(times.size),
    )
    return {
        "recording_id": recording.recording_id,
        "channel": params.channel,
        "channels": channels,
        "sfreq": float(sfreq),
        "duration_sec": round(duration_sec, 3),
        "window_ms": params.window_ms,
        "overlap_pct": params.overlap_pct,
        "fmax_hz": params.fmax_hz,
        "n_fft": n_fft,
        "filter_band_hz": list(params.filter_band) if params.filter_band else None,
        "notch_hz": params.notch_hz,
        # Референс — параметр расчёта, а не просмотра (A11): без него ленивый
        # пересчёт сетки (cached_grid) подставил бы «average» и посчитал бы
        # другую спектрограмму под тем же ETag.
        "reference": params.reference,
        "reference_channels": list(params.reference_channels or []),
        "freqs": [float(value) for value in freqs],
        "times": [float(value) for value in times],
        "db_min": round(db_min, 3),
        "db_max": round(db_max, 3),
        "grid_url": "",
        "grid_version": signature,
        "warnings": warnings,
        "duration_sec_calc": round(time.perf_counter() - started, 3),
    }


def _write_grid(cfg: Settings, recording_id: str, signature: str, blob: bytes) -> None:
    """Атомарно кладёт сетку на диск; сбой кэша не критичен."""
    cache_write(grid_path(cfg, recording_id, signature), blob, label="Кэш спектрограммы")


def cached_grid(recording: Recording, cfg: Settings, params: SpectrogramParams) -> tuple[bytes, str]:
    """Сетка + версия из дискового кэша; при промахе считается заново.

    Ленивый пересчёт — как у топокарт (3.4) и пирамиды сигналов (2.5): браузер
    может запросить сетку уже показанного результата после перезапуска сервера,
    и отдать 404 на живую ссылку было бы хуже, чем посчитать снова.
    """
    validate_params(params, cfg)
    channels = list(recording.meta.get("channels") or [])
    signature = spectrogram_signature(params, cfg, channels)
    path = grid_path(cfg, recording.recording_id, signature)
    started = time.perf_counter()
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        journal.record(
            "spectrogram", "grid_read",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=signature, bytes_out=len(data), cache_hit=True,
            note=f"channel={params.channel}",
        )
        return data, signature
    except OSError:
        journal.record(
            "spectrogram", "grid_read",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=signature, cache_hit=False,
            note=f"channel={params.channel}, reason=cold",
        )
    compute_spectrogram(recording, cfg, params)
    try:
        with open(path, "rb") as fh:
            return fh.read(), signature
    except OSError as exc:
        raise SpectrogramError("Сетка спектрограммы недоступна: не удалось построить") from exc
