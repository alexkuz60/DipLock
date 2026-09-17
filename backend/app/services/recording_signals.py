"""Пирамида сигналов записи для вьюера треков (срез 2.5, docs/ui.md §8).

Вьюеру нужны не «сырые» мегабайты ЭЭГ, а готовая к отрисовке огибающая:
на уровне ``×k`` — не больше ``signal_base_points * k`` точек на канал, где
каждая точка — min/max по временной корзине. Так пики артефактов видны на
любом зуме, а размер ответа **не зависит от длины записи**.

Формат ответа — компактный float32-контейнер (см. ``RecordingSignalsHeader``):
``DPS1`` | ``uint32 LE len(header)`` | JSON-заголовок | канало-мажорный payload.

Чтение EDF — потоковое (`preload=False`, блоками по корзинам): 200-МБ файл не
поднимается целиком в память. Готовые уровни кладутся на диск
(``cache_dir/signals/<recording_id>/level<k>.bin``) и отдаются с ``ETag``;
повторный запрос уровня — чтение файла без пересчёта.
"""
import hashlib
import logging
import struct
from typing import List, Optional, Tuple

import mne
import numpy as np

from app.core.config import Settings
from app.schemas.analysis import RecordingSignalsHeader
from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write
from app.services.edf_loader import normalize_channel_name
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Метка формата контейнера (см. RecordingSignalsHeader)
MAGIC = b"DPS1"
_HEADER_LEN_FMT = "<I"

# Сколько корзин обрабатываем за один проход чтения EDF: файл не читается
# целиком, но и I/O не дробится на мелкие куски.
_BUCKETS_PER_READ = 8192


class SignalBuildError(ValueError):
    """Ошибка параметров/чтения сигналов — превращается в 400 в API."""


def _available_levels(settings: Settings) -> Tuple[int, ...]:
    """Уровни пирамиды из конфига (только положительные, по возрастанию)."""
    levels = tuple(sorted({int(level) for level in settings.signal_levels if int(level) > 0}))
    return levels or (1,)


def _resolve_indices(raw: mne.io.BaseRaw, wanted: List[str]) -> Tuple[List[str], List[int]]:
    """Индексы каналов EDF для имён из паспорта записи (нормализация 10-20).

    Имена в паспорте уже нормализованы, а ``raw.ch_names`` — как в файле
    («EEG F7», «T3»…), поэтому сопоставляем по ``normalize_channel_name``.
    """
    index_of: dict[str, int] = {}
    for position, name in enumerate(raw.ch_names):
        index_of.setdefault(normalize_channel_name(name), position)

    channels: List[str] = []
    indices: List[int] = []
    for name in wanted:
        position = index_of.get(name)
        if position is None or name in channels:
            continue
        channels.append(name)
        indices.append(position)
    return channels, indices


def _open_raw(recording: Recording, settings: Settings) -> mne.io.BaseRaw:
    """Открывает EDF без загрузки данных в память (единицы — как в паспорте)."""
    kwargs: dict = {"preload": False, "stim_channel": False, "verbose": False}
    if settings.edf_units:
        kwargs["units"] = settings.edf_units
    try:
        return mne.io.read_raw_edf(recording.path, **kwargs)
    except Exception as exc:  # noqa: BLE001 — отдаём UI понятный текст
        raise SignalBuildError(f"Не удалось прочитать EDF: {exc}") from exc


def _bucket_edges(n_times: int, n_points: int) -> np.ndarray:
    """Границы корзин: ``n_points`` равномерно растущих индексов (< n_times)."""
    return (np.arange(n_points, dtype=np.int64) * n_times) // n_points


def _build_level(recording: Recording, level: int, settings: Settings) -> bytes:
    """Строит контейнер сигналов уровня ``level`` (каналы × корзины)."""
    raw = _open_raw(recording, settings)
    n_times = int(raw.n_times)
    sfreq = float(raw.info["sfreq"])
    if n_times <= 0 or sfreq <= 0:
        raise SignalBuildError("Файл не содержит данных (sfreq или длина записи равны нулю)")

    wanted = list(recording.meta.get("channels") or recording.meta.get("unmatched_channels") or [])
    channels, picks = _resolve_indices(raw, wanted)
    if not channels:
        raise SignalBuildError("В файле нет каналов для отрисовки")

    base_points = max(1, int(settings.signal_base_points))
    n_points = min(n_times, base_points * level)
    decimated = n_points < n_times
    edges = _bucket_edges(n_times, n_points)

    # Масштаб: паспорт уже знает, был ли авто-пересчёт единиц. MNE отдаёт
    # «вольты»; без авто-пересчёта домножаем на 1e6 (мкВ), при авто-пересчёте
    # численные значения файла и есть микровольты.
    autoscaled = bool(recording.meta.get("units_autoscaled"))
    scale = 1.0 if autoscaled else 1e6

    if decimated:
        rows = np.empty((len(channels) * 2, n_points), dtype=np.float32)
    else:
        rows = np.empty((len(channels), n_points), dtype=np.float32)

    # Потоковый расчёт min/max по корзинам: читаем группами корзин.
    for start_bucket in range(0, n_points, _BUCKETS_PER_READ):
        stop_bucket = min(n_points, start_bucket + _BUCKETS_PER_READ)
        first = int(edges[start_bucket])
        last = int(edges[stop_bucket]) if stop_bucket < n_points else n_times
        block = raw.get_data(picks=picks, start=first, stop=last, verbose=False)
        block = (block * scale).astype(np.float32)
        local_edges = edges[start_bucket:stop_bucket] - first
        mins = np.minimum.reduceat(block, local_edges, axis=1)
        maxs = np.maximum.reduceat(block, local_edges, axis=1)
        if decimated:
            rows[0::2, start_bucket:stop_bucket] = mins
            rows[1::2, start_bucket:stop_bucket] = maxs
        else:
            rows[:, start_bucket:stop_bucket] = maxs

    duration_sec = n_times / sfreq
    header = RecordingSignalsHeader(
        recording_id=recording.recording_id,
        level=level,
        channels=channels,
        sfreq=round(n_points / duration_sec, 6),
        duration_sec=round(duration_sec, 3),
        n_points=n_points,
        decimated=decimated,
        arrays_per_channel=2 if decimated else 1,
    )
    header_bytes = header.model_dump_json().encode("utf-8")
    return (
        MAGIC
        + struct.pack(_HEADER_LEN_FMT, len(header_bytes))
        + header_bytes
        + rows.astype("<f4").tobytes(order="C")
    )


def _cache_path(settings: Settings, recording_id: str, level: int) -> str:
    """Путь кэша одного уровня на диске."""
    return cache_path(settings.cache_dir, "signals", recording_id, f"level{level}.bin")


def signal_etag(recording: Recording, level: int, settings: Settings) -> str:
    """Стабильный ETag уровня: запись + уровень + параметры сборки."""
    digest = hashlib.sha256()
    digest.update(
        f"{recording.recording_id}|{level}|{recording.meta.get('sfreq')}|"
        f"{recording.meta.get('duration_sec')}|{settings.signal_base_points}".encode("utf-8")
    )
    return digest.hexdigest()[:16]


def build_signal_blob(recording: Recording, level: int, settings: Settings) -> Tuple[bytes, str]:
    """Контейнер сигналов уровня ``level`` + ETag (диск + пересчёт при промахе).

    Бросает ``SignalBuildError`` (→ 400) при неверном уровне или отсутствии данных.
    """
    if level not in _available_levels(settings):
        allowed = ", ".join(str(value) for value in _available_levels(settings))
        raise SignalBuildError(f"Уровень {level} не поддерживается (доступны: {allowed})")

    path = _cache_path(settings, recording.recording_id, level)
    blob = cache_read(path)
    if blob is None:
        blob = _build_level(recording, level, settings)
        cache_write(path, blob, label="Кэш сигналов")
        logger.info(
            "Пирамида сигналов: запись %s, уровень ×%d (%.2f МБ)",
            recording.recording_id, level, len(blob) / 1e6,
        )
    return blob, signal_etag(recording, level, settings)


def clear_signal_cache(settings: Settings, recording_id: Optional[str] = None) -> None:
    """Удаляет дисковый кэш сигналов: одну запись или весь (тесты и реестр)."""
    parts = ("signals", recording_id) if recording_id else ("signals",)
    cache_clear(settings.cache_dir, *parts)
