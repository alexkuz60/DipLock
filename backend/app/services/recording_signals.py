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

**Три слоя видимости** (шаг 2 плана «слои видимости», 27.09.2026,
``SignalsLayerQuery.layer``): ``raw`` — прежняя сырая пирамида (N14: вьюер
намеренно сырой), ``cleaned`` — подготовленный сигнал расчётов (полоса, notch,
референс и очистка по параметрам стадии «Фильтр и референс»), ``diff`` —
разность «без очистки − с очисткой» на подготовленной базе, то есть чистый
вклад очистки (вариант C, решение владельца 27.09.2026). Слои ``cleaned``/
``diff`` читают EDF через ``prepared_raw_report`` (RAM-кэш A4); их уровни
кэшируются на диске с отпечатком параметров в имени файла и в ``ETag``.
"""
import hashlib
import logging
import struct
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

import mne
import numpy as np

from app.core.config import Settings
from app.schemas.analysis import RecordingSignalsHeader
from app.services import journal
from app.services.artifact_cleaner import CleanSpec
from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write
from app.services.edf_loader import normalize_channel_name
from app.services.prepared_signal import prepared_raw_report
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Метка формата контейнера (см. RecordingSignalsHeader)
MAGIC = b"DPS1"
_HEADER_LEN_FMT = "<I"

# Слои видимости вьюера (шаг 2 плана): сырой / после очистки / разница вклада
# очистки. `raw` — прежнее поведение без изменений. Словарь — единственный
# источник и имён, и литеральных типов (валидация в `api/params.py`).
SignalLayer = Literal["raw", "cleaned", "diff"]
SIGNAL_LAYER_LITERALS: dict[str, SignalLayer] = {
    "raw": "raw",
    "cleaned": "cleaned",
    "diff": "diff",
}
SIGNAL_LAYERS: tuple[str, ...] = tuple(SIGNAL_LAYER_LITERALS)

# Сколько корзин обрабатываем за один проход чтения EDF: файл не читается
# целиком, но и I/O не дробится на мелкие куски.
_BUCKETS_PER_READ = 8192


class SignalBuildError(ValueError):
    """Ошибка параметров/чтения сигналов — превращается в 400 в API."""


@dataclass(frozen=True)
class SignalsLayerQuery:
    """Параметры запроса одного уровня пирамиды: слой + база подготовленных слоёв.

    ``layer='raw'`` — прежняя сырая пирамида, остальные поля не читаются.
    Для ``cleaned``/``diff`` поля ниже — плоская проекция формы стадии
    «Фильтр и референс» (та же семантика, что у ``buildPreprocessForm`` в UI):
    слой — **видимость**, а не расчёт, но его содержимое обязано совпадать с
    тем, что уйдёт в спектр/диполи при тех же параметрах.

    ``signature()`` входит в ``ETag`` и в имя файла дискового кэша: смена
    полосы/notch/референса/очистки — другой уровень, а не молчаливая подмена.
    """

    layer: SignalLayer = "raw"
    band: tuple[float, float] | None = None
    notch_hz: float | None = None
    reference_channels: tuple[str, ...] = ()
    clean: CleanSpec = field(default_factory=CleanSpec)

    def signature(self) -> str:
        """Короткий отпечаток параметров слоя (sha1, 12 hex — как у ключа prepared)."""
        parts = [
            f"{self.band[0]:g}-{self.band[1]:g}" if self.band else "-",
            str(self.notch_hz or 0),
            ",".join(self.reference_channels) or "average",
            self.clean.label(),
        ]
        # sha1 — не криптография, а короткий ключ кэша (та же оговорка, что в
        # `prepared_signal.signature`): коллизия стоит лишнего попадания, не данных.
        return hashlib.sha1(  # noqa: S324 — ключ кэша, не защита данных
            "|".join(parts).encode("utf-8"),
        ).hexdigest()[:12]


def _available_levels(settings: Settings) -> tuple[int, ...]:
    """Уровни пирамиды из конфига (только положительные, по возрастанию)."""
    levels = tuple(sorted({int(level) for level in settings.signal_levels if int(level) > 0}))
    return levels or (1,)


def _resolve_indices(raw: mne.io.BaseRaw, wanted: list[str]) -> tuple[list[str], list[int]]:
    """Индексы каналов EDF для имён из паспорта записи (нормализация 10-20).

    Имена в паспорте уже нормализованы, а ``raw.ch_names`` — как в файле
    («EEG F7», «T3»…), поэтому сопоставляем по ``normalize_channel_name``.
    """
    index_of: dict[str, int] = {}
    for slot, name in enumerate(raw.ch_names):
        index_of.setdefault(normalize_channel_name(name), slot)

    channels: list[str] = []
    indices: list[int] = []
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
    except Exception as exc:
        raise SignalBuildError(f"Не удалось прочитать EDF: {exc}") from exc


def _bucket_edges(n_times: int, n_points: int) -> np.ndarray:
    """Границы корзин: ``n_points`` равномерно растущих индексов (< n_times)."""
    return (np.arange(n_points, dtype=np.int64) * n_times) // n_points


def _grid(n_times: int, level: int, settings: Settings) -> tuple[int, bool]:
    """Точки уровня и признак прореживания: ``n_points = base_points × level``."""
    base_points = max(1, int(settings.signal_base_points))
    n_points = min(n_times, base_points * level)
    return n_points, n_points < n_times


def _envelope_rows(
    data_get: Callable[[int, int], np.ndarray],
    n_times: int,
    n_points: int,
    decimated: bool,
    scale: float,
    n_channels: int,
) -> np.ndarray:
    """min/max по временным корзинам — общий заливщик всех слоёв.

    ``data_get(start, stop)`` отдаёт блок «каналы × отсчёты» в вольтах,
    ``scale`` переводит его в мкВ (у сырого слоя — масштаб паспорта, у
    подготовленных — 1e6: ``load_edf`` всегда отдаёт вольты). Пики артефактов
    не теряются: каждая корзина хранит extremum, а не «каждый N-й отсчёт».
    """
    edges = _bucket_edges(n_times, n_points)
    if decimated:
        rows = np.empty((n_channels * 2, n_points), dtype=np.float32)
    else:
        rows = np.empty((n_channels, n_points), dtype=np.float32)

    for start_bucket in range(0, n_points, _BUCKETS_PER_READ):
        stop_bucket = min(n_points, start_bucket + _BUCKETS_PER_READ)
        first = int(edges[start_bucket])
        last = int(edges[stop_bucket]) if stop_bucket < n_points else n_times
        block = data_get(first, last)
        block = (block * scale).astype(np.float32)
        local_edges = edges[start_bucket:stop_bucket] - first
        mins = np.minimum.reduceat(block, local_edges, axis=1)
        maxs = np.maximum.reduceat(block, local_edges, axis=1)
        if decimated:
            rows[0::2, start_bucket:stop_bucket] = mins
            rows[1::2, start_bucket:stop_bucket] = maxs
        else:
            rows[:, start_bucket:stop_bucket] = maxs
    return rows


def _assemble(
    recording: Recording,
    level: int,
    channels: list[str],
    n_times: int,
    sfreq: float,
    n_points: int,
    decimated: bool,
    layer: SignalLayer,
    rows: np.ndarray,
) -> bytes:
    """Собирает контейнер ``DPS1``: JSON-заголовок (с учётом слоя) + payload."""
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
        layer=layer,
    )
    header_bytes = header.model_dump_json().encode("utf-8")
    return (
        MAGIC
        + struct.pack(_HEADER_LEN_FMT, len(header_bytes))
        + header_bytes
        + rows.astype("<f4").tobytes(order="C")
    )


def _build_raw_level(recording: Recording, level: int, settings: Settings) -> bytes:
    """Сырой слой (``raw``): прежнее потоковое чтение EDF, файл не поднимается целиком."""
    raw = _open_raw(recording, settings)
    n_times = int(raw.n_times)
    sfreq = float(raw.info["sfreq"])
    if n_times <= 0 or sfreq <= 0:
        raise SignalBuildError("Файл не содержит данных (sfreq или длина записи равны нулю)")

    wanted = list(recording.meta.get("channels") or recording.meta.get("unmatched_channels") or [])
    channels, picks = _resolve_indices(raw, wanted)
    if not channels:
        raise SignalBuildError("В файле нет каналов для отрисовки")

    n_points, decimated = _grid(n_times, level, settings)

    # Масштаб: паспорт уже знает, был ли авто-пересчёт единиц. MNE отдаёт
    # «вольты»; без авто-пересчёта домножаем на 1e6 (мкВ), при авто-пересчёте
    # численные значения файла и есть микровольты.
    autoscaled = bool(recording.meta.get("units_autoscaled"))
    scale = 1.0 if autoscaled else 1e6

    rows = _envelope_rows(
        lambda start, stop: raw.get_data(picks=picks, start=start, stop=stop, verbose=False),
        n_times, n_points, decimated, scale, len(channels),
    )
    return _assemble(
        recording, level, channels, n_times, sfreq, n_points, decimated, "raw", rows,
    )


def _prepared(
    recording: Recording,
    settings: Settings,
    query: SignalsLayerQuery,
    clean: CleanSpec | None,
) -> mne.io.BaseRaw:
    """Подготовленный сигнал по параметрам слоя (та же форма, что стадия filter)."""
    band = query.band
    return prepared_raw_report(
        recording,
        settings,
        l_freq=band[0] if band else None,
        h_freq=band[1] if band else None,
        notch_hz=query.notch_hz,
        reference_channels=list(query.reference_channels) or None,
        # Имя пайплайна для журнала шагов: слои различимы в замерах
        pipeline="signals",
        # Пустая очистка — прежний ключ кэша prepared (A4/N5)
        clean=clean,
    )[0]


def _build_prepared_level(
    recording: Recording, level: int, settings: Settings, query: SignalsLayerQuery,
) -> bytes:
    """Слои ``cleaned``/``diff`` на подготовленной базе (вариант C, 27.09.2026).

    ``cleaned`` — сигнал расчётов (полоса + notch + референс + очистка);
    ``diff`` — «без очистки − с очисткой», то есть чистый вклад очистки:
    сравнивать очистку напрямую с сырой пирамидой бессмысленно — в неё не
    входят ни фильтр, ни референс. Обе копии ``diff`` имеют одинаковую сетку
    (отличается только ``CleanSpec``).
    """
    clean = query.clean if query.clean != CleanSpec() else None
    try:
        if query.layer == "cleaned":
            source = _prepared(recording, settings, query, clean=clean)
            data = source.get_data(verbose=False)
        else:
            base = _prepared(recording, settings, query, clean=None)
            cleaned = _prepared(recording, settings, query, clean=clean)
            source = base
            data = base.get_data(verbose=False) - cleaned.get_data(verbose=False)
    except ValueError as exc:
        raise SignalBuildError(str(exc)) from exc
    except Exception as exc:
        raise SignalBuildError(f"Не удалось собрать слой «{query.layer}»: {exc}") from exc

    n_times = int(data.shape[1])
    sfreq = float(source.info["sfreq"])
    if n_times <= 0 or sfreq <= 0:
        raise SignalBuildError("Файл не содержит данных (sfreq или длина записи равны нулю)")
    channels = list(source.ch_names)
    if not channels:
        raise SignalBuildError("В файле нет каналов для отрисовки")

    n_points, decimated = _grid(n_times, level, settings)
    # Вольты → мкВ: то же численное значение, что у сырого слоя после масштаба
    # паспорта (иначе переключение слоя «прыгало» бы масштабом в 1e6 раз).
    rows = _envelope_rows(
        lambda start, stop: data[:, start:stop],
        n_times, n_points, decimated, 1e6, len(channels),
    )
    return _assemble(
        recording, level, channels, n_times, sfreq, n_points, decimated, query.layer, rows,
    )


def _build_level(
    recording: Recording, level: int, settings: Settings, query: SignalsLayerQuery,
) -> bytes:
    """Строит контейнер сигналов уровня ``level`` выбранного слоя."""
    if query.layer in ("cleaned", "diff"):
        return _build_prepared_level(recording, level, settings, query)
    return _build_raw_level(recording, level, settings)


def _cache_path(settings: Settings, recording_id: str, level: int, query: SignalsLayerQuery) -> str:
    """Путь кэша уровня на диске: у подготовленных слоёв — слой и отпечаток параметров.

    Имя сырого слоя не меняется (``level{k}.bin``) — прежние кэши остаются
    валидными; для ``cleaned``/``diff`` отпечаток в имени обязателен: без него
    смена полосы или очистки читала бы чужой файл.
    """
    if query.layer == "raw":
        name = f"level{level}.bin"
    else:
        name = f"level{level}-{query.layer}-{query.signature()}.bin"
    return cache_path(settings.cache_dir, "signals", recording_id, name)


def signal_etag(
    recording: Recording, level: int, settings: Settings,
    query: SignalsLayerQuery | None = None,
) -> str:
    """Стабильный ETag уровня: запись + уровень + параметры сборки (+ слой).

    У сырого слоя формула не менялась (прежние ETag и кэши остаются валидными);
    для ``cleaned``/``diff`` в отпечаток входят слой и параметры подготовки —
    иначе браузер отдал бы 304 для уровней с другой полосой/очисткой.
    """
    query = query or SignalsLayerQuery()
    parts = (
        f"{recording.recording_id}|{level}|{recording.meta.get('sfreq')}|"
        f"{recording.meta.get('duration_sec')}|{settings.signal_base_points}"
    )
    if query.layer != "raw":
        parts += f"|{query.layer}|{query.signature()}"
    return hashlib.sha256(parts.encode()).hexdigest()[:16]


def build_signal_blob(
    recording: Recording,
    level: int,
    settings: Settings,
    query: SignalsLayerQuery | None = None,
) -> tuple[bytes, str]:
    """Контейнер сигналов уровня ``level`` + ETag (диск + пересчёт при промахе).

    ``query`` — слой видимости и параметры подготовленной базы; ``None`` —
    прежний сырой слой. Бросает ``SignalBuildError`` (→ 400) при неверном
    уровне/слое или отсутствии данных.
    """
    query = query or SignalsLayerQuery()
    if query.layer not in SIGNAL_LAYERS:
        allowed = ", ".join(SIGNAL_LAYERS)
        raise SignalBuildError(f"Слой {query.layer!r} не поддерживается (доступны: {allowed})")
    if level not in _available_levels(settings):
        allowed = ", ".join(str(value) for value in _available_levels(settings))
        raise SignalBuildError(f"Уровень {level} не поддерживается (доступны: {allowed})")

    note = f"level={level}" if query.layer == "raw" else f"level={level}, layer={query.layer}"
    path = _cache_path(settings, recording.recording_id, level, query)
    etag = signal_etag(recording, level, settings, query)
    started = time.perf_counter()
    blob = cache_read(path)
    if blob is not None:
        journal.record(
            "signals", "cache_read",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=etag, bytes_out=len(blob), cache_hit=True, note=note,
        )
        return blob, etag

    with journal.step(
        "signals", "build_level", params_key=etag, cache_hit=False, note=note,
    ) as entry:
        blob = _build_level(recording, level, settings, query)
        entry.bytes_out = len(blob)
        cache_write(path, blob, label="Кэш сигналов")
        logger.info(
            "Пирамида сигналов: запись %s, слой %s, уровень ×%d (%.2f МБ)",
            recording.recording_id, query.layer, level, len(blob) / 1e6,
        )
    return blob, etag


def clear_signal_cache(settings: Settings, recording_id: str | None = None) -> None:
    """Удаляет дисковый кэш сигналов: одну запись или весь (тесты и реестр)."""
    parts = ("signals", recording_id) if recording_id else ("signals",)
    cache_clear(settings.cache_dir, *parts)
