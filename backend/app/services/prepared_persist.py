"""Персист подготовленного массива по полосе (Фаза B, 29.09.2026).

RAM-кэш ``prepared_signal`` живёт до вытеснения записи или рестарта процесса —
после перезапуска (dev ``--reload`` перезапускает процесс на каждую правку кода)
любой расчёт по полосе читал EDF заново. Здесь подготовленный (отфильтрованный,
с референсом) массив сигнала кладётся на диск по ключу

    ``recording_id`` + ``band_key`` + notch + референс

— тому же набору параметров, что у ``prepared_signal._SignalKey`` и
``SignalsLayerQuery.signature()`` (инвариант п.16 в
``docs/rules/data-and-caches.md``). ``band_key`` — стабильные ключи полос из
``freq_bands``/``functional_bands`` (фаза A): переименование полосы задним
числом здесь запрещено — это адрес уже посчитанных массивов.

Формат файла (``cache_dir/prepared/<recording_id>/<band_key>-<sig>.bin``):
magic ``DPP1`` | uint32 LE длина JSON-заголовка | заголовок | float32 LE payload
канало-мажорно — тот же приём, что у ``DPS1`` (правило п.5:
``docs/rules/data-and-caches.md``): бинарный контейнер вместо JSON; клиенту
файл не отдаётся — визуализация идёт уровнем пирамиды ``DPS1``. Единицы
данных — **вольты**, как у ``raw.get_data()``: персист — вход расчётов
(диполи, спектр), а они работают в вольтах.

Три свойства:

1. **Кэш, а не источник истины** (правило п.4): сбой чтения/записи — промах,
   который пересчитывается через ``prepared_raw_report``; битый/чужой файл
   опознаётся по заголовку и не отдаётся как данные.
2. **Чистится вместе с записью**: ``clear_persist_cache`` вызывается из
   ``_drop_signal_cache`` (TTL 24 ч, лимит истории) и попадает в обход сирот
   (``orphans.RECORDING_CACHE_SUBDIRS``).
3. **Пишется при промахе, читается первым**: сборщик слоя ``band`` сначала
   пробует диск, при промахе готовит сигнал через RAM-кэш A4 и запоминает.
"""
import hashlib
import json
import logging
import struct
import time
from dataclasses import dataclass

import numpy as np

from app.core.config import Settings
from app.services import journal
from app.services.bandpass_filter import band_bounds
from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write
from app.services.prepared_signal import prepared_raw_report
from app.services.recordings import Recording

logger = logging.getLogger(__name__)

# Метка формата контейнера (чтение — синхронно с записью ниже).
MAGIC = b"DPP1"
_HEADER_LEN_FMT = "<I"
# Версия заголовка: файл другой версии читается как промах, а не как данные.
FORMAT_VERSION = 1


class PreparedPersistError(ValueError):
    """Ошибка параметров персиста (неизвестная полоса) — превращается в 400 в API."""


@dataclass(frozen=True)
class PreparedArray:
    """Подготовленный массив сигнала из персиста (или свежесобранный)."""

    data: np.ndarray
    """float32 ``[n_channels, n_times]``, канало-мажорно, единицы — вольты."""
    channels: list[str]
    """Имена каналов в порядке строк ``data`` (монтаж после ``load_edf``)."""
    sfreq: float
    """Частота дискретизации, Гц — ось времени уровней пирамиды."""


def known_band_keys(cfg: Settings) -> tuple[str, ...]:
    """Все именованные полосы: базовые октавные + функциональные ритмы (фаза A)."""
    return (*cfg.freq_bands.keys(), *cfg.functional_bands.keys())


def band_signature(
    cfg: Settings,
    band_key: str,
    notch_hz: float | None,
    reference_channels: list[str] | None,
    reference_mode: str,
) -> str:
    """Короткий отпечаток ключа персиста (sha1, 12 hex — как у сигнатур выше).

    В части ключа — всё, что меняет содержимое массива: полоса, notch,
    эффективный референс и режим (``none`` миксов «ЭЭГ» даёт другой сигнал),
    плюс единицы/каналы конфига (смена ``standard_channels`` обязана дать
    промах, а не чужой массив). ``recording_id`` живёт в пути каталога.
    """
    parts = [
        band_key,
        str(notch_hz or 0),
        ",".join(reference_channels or ()) or "average",
        reference_mode,
        cfg.edf_units or "-",
        ",".join(cfg.standard_channels),
    ]
    # sha1 — не криптография, а короткий ключ кэша: коллизия стоит лишнего
    # промаха, не подделки данных (та же оговорка, что в prepared_signal).
    return hashlib.sha1(  # noqa: S324 — ключ кэша, не защита данных
        "|".join(parts).encode("utf-8"),
    ).hexdigest()[:12]


def persist_path(cfg: Settings, recording_id: str, band_key: str, signature: str) -> str:
    """Путь файла персиста внутри кэша записи (путь — только из ``settings``)."""
    return cache_path(str(cfg.cache_dir), "prepared", recording_id, f"{band_key}-{signature}.bin")


def load_persisted(
    cfg: Settings, recording_id: str, band_key: str, signature: str,
) -> PreparedArray | None:
    """Читает массив с диска; ``None`` — промах (нет файла, битый, чужой версии).

    Любая нестыковка заголовка с ожиданиями — промах: кэш обязан пересчитаться,
    а не отдать «что-нибудь» (правило п.4 ``docs/rules/data-and-caches.md``).
    """
    blob = cache_read(persist_path(cfg, recording_id, band_key, signature))
    if blob is None or len(blob) < 8 or blob[:4] != MAGIC:
        return None
    header_len = struct.unpack_from(_HEADER_LEN_FMT, blob, 4)[0]
    try:
        header = json.loads(blob[8 : 8 + header_len].decode("utf-8"))
        payload = np.frombuffer(blob[8 + header_len :], dtype="<f4")
    except (ValueError, UnicodeDecodeError):
        return None
    if (
        not isinstance(header, dict)
        or header.get("version") != FORMAT_VERSION
        or header.get("band_key") != band_key
        or header.get("signature") != signature
    ):
        return None
    channels = header.get("channels")
    n_times = header.get("n_times")
    sfreq = header.get("sfreq")
    if not isinstance(channels, list) or not isinstance(n_times, int):
        return None
    if not isinstance(sfreq, (int, float)) or not channels or n_times <= 0 or sfreq <= 0:
        return None
    if payload.size != len(channels) * n_times:
        return None
    return PreparedArray(
        data=payload.reshape(len(channels), n_times).copy(),
        channels=[str(name) for name in channels],
        sfreq=float(sfreq),
    )


def save_persisted(
    cfg: Settings,
    recording_id: str,
    band_key: str,
    signature: str,
    data: np.ndarray,
    channels: list[str],
    sfreq: float,
) -> bool:
    """Атомарно пишет массив на диск (``False`` — не записался, расчёт продолжается).

    ``data`` принимается в вольтах (float64 от ``raw.get_data()``) и кладётся
    float32: по правилу п.16 — формат «float32, канало-мажорно (как DPS1)»,
    объём файла уменьшается вдвое без заметной для ЭЭГ потери точности.
    """
    header = {
        "version": FORMAT_VERSION,
        "band_key": band_key,
        "signature": signature,
        "channels": list(channels),
        "n_times": int(data.shape[1]),
        "sfreq": float(sfreq),
        "units": "V",
        "dtype": "float32",
        "layout": "channel_major",
    }
    header_bytes = json.dumps(header, ensure_ascii=False).encode("utf-8")
    blob = (
        MAGIC
        + struct.pack(_HEADER_LEN_FMT, len(header_bytes))
        + header_bytes
        + np.ascontiguousarray(data, dtype="<f4").tobytes(order="C")
    )
    return cache_write(
        persist_path(cfg, recording_id, band_key, signature),
        blob, label="Кэш подготовленных массивов",
    )


def clear_persist_cache(cfg: Settings, recording_id: str | None = None) -> None:
    """Удаляет персист: одну запись или весь (тесты и реестр).

    Вызывается из ``_drop_signal_cache``: персист — производная записи и живёт
    по её TTL (правило п.3 ``docs/rules/data-and-caches.md``).
    """
    parts = ("prepared", recording_id) if recording_id else ("prepared",)
    cache_clear(str(cfg.cache_dir), *parts)



def prepared_array(
    recording: Recording,
    cfg: Settings,
    band_key: str,
    notch_hz: float | None = None,
    reference_channels: list[str] | None = None,
    reference_mode: str = "average",
    pipeline: str | None = None,
) -> PreparedArray:
    """Подготовленный массив по именованной полосе: диск → RAM-кэш → EDF.

    ``band_key`` обязан быть ключом из ``freq_bands``/``functional_bands``
    (иначе ``PreparedPersistError`` → 400 в API): произвольные границы адреса
    не имеют — для них остаётся слой ``cleaned`` со своей подписью параметров.

    ``pipeline`` — имя пайплайна для журнала шагов (``docs/data_map.md`` §9);
    ``None`` — не измерять (тесты, разовые вызовы).
    """
    if band_key not in known_band_keys(cfg):
        raise PreparedPersistError(
            f"band_key должен быть одним из {list(known_band_keys(cfg))} "
            f"(получено: {band_key!r})"
        )
    bounds = band_bounds(band_key)
    if bounds is None:  # pragma: no cover — «all» не бывает именованной полосой
        raise PreparedPersistError(f"Полоса {band_key!r} не имеет границ")
    signature = band_signature(cfg, band_key, notch_hz, reference_channels, reference_mode)
    started = time.perf_counter()

    cached = load_persisted(cfg, recording.recording_id, band_key, signature)
    if cached is not None:
        if pipeline:
            journal.record(
                pipeline, "prepared_persist",
                ms=(time.perf_counter() - started) * 1000.0,
                params_key=signature, bytes_out=int(cached.data.nbytes),
                cache_hit=True, note=f"band={band_key}",
            )
        return cached

    raw, _report = prepared_raw_report(
        recording, cfg,
        l_freq=bounds[0], h_freq=bounds[1],
        notch_hz=notch_hz,
        reference_channels=reference_channels,
        reference_mode=reference_mode,
        pipeline=pipeline,
    )
    data = raw.get_data(verbose=False)
    channels = list(raw.ch_names)
    sfreq = float(raw.info["sfreq"] or 0.0)
    if sfreq <= 0 or data.shape[1] <= 0 or not channels:
        raise PreparedPersistError("Подготовленный сигнал пуст (нет каналов или длины записи)")
    if not save_persisted(
        cfg, recording.recording_id, band_key, signature, data, channels, sfreq,
    ):
        logger.warning(
            "Персист подготовленного сигнала не записан (расчёт продолжается): "
            "запись %s, полоса %s",
            recording.recording_id, band_key,
        )
    if pipeline:
        journal.record(
            pipeline, "prepared_persist",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=signature, bytes_out=int(data.nbytes),
            cache_hit=False, note=f"band={band_key}",
        )
    return PreparedArray(
        data=np.ascontiguousarray(data, dtype=np.float32),
        channels=channels,
        sfreq=sfreq,
    )

