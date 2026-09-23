"""Кэш подготовленного сигнала: EDF читается один раз на набор параметров (A4).

За одну сессию работы с записью ``load_edf`` вызывался из пяти мест (``/analyze``,
``preprocess``, ``spectral``, ``spectrogram``, ``dipole_scanner``): каждая стадия
и каждый расчёт **заново** читали EDF целиком, ставили монтаж 10-20, применяли
reference, полосовой и сетевой фильтры. Кнопка «пересчитать» с теми же
параметрами стоила как первый запуск.

Здесь живёт RAM-кэш подготовленного сигнала: ключ — «запись + единицы + каналы +
референс + полоса + notch», значение — готовый ``raw``. Повторный расчёт с теми
же параметрами отдаёт копию из кэша, смена полосы — читает файл заново.

Три инварианта, которые нельзя нарушать:

1. **Наружу отдаётся копия** (``raw.copy()``). ``segment_epochs`` мутирует
   полученный сигнал (``raw.set_annotations(...)``), а разные потребители ставят
   разные аннотации — артефакты в предподготовке, пустые в спектре. Общий объект
   означал бы, что аннотации одной задачи «протекают» в другую.
2. **Ключ — ``recording_id``, без sha256 файла.** Идентификатор записи уже
   адресует содержимое через дедуп (``docs/rules/data-and-caches.md`` п.1);
   считать отпечаток файла в ключе — платить за промах без выигрыша.
3. **Кэш вытесняется вместе с записью.** Очистка — ``_drop_signal_cache`` в
   ``services/recordings.py`` (TTL 24 ч, лимит 10 записей), поэтому кэш не
   переживает вытеснение записи и не отдаёт сигнал чужого файла.

Размер кэша (в наборах параметров) — ``PREPARED_SIGNAL_CACHE_SIZE``; ``0``
выключает кэш целиком. Одна запись в кэше — это float64-данные записи
(130.7 с × 500 Гц × 18 каналов ≈ 9.4 МБ; десятиминутная запись ≈ 43 МБ), поэтому
по умолчанию держим два набора, а не «сколько влезет».
"""
import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import mne

from app.core.config import Settings
from app.services import journal
from app.services.artifact_cleaner import CleanSpec, apply_cleaning
from app.services.edf_loader import load_edf
from app.services.recordings import Recording

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _SignalKey:
    """Ключ кэша: параметры, которые влияют на содержимое подготовленного сигнала.

    ``reference`` — **эффективный** список каналов референса, а не строка
    ``reference`` из формы (``average``/``custom``): пустой список и «average»
    дают одинаковый сигнал, и разные ключи на них — лишние промахи кэша.
    ``reference_mode`` вынесен отдельно: ``"none"`` (миксы каналов «ЭЭГ») даёт
    **другой** сигнал, чем «average» с тем же пустым списком каналов.
    """

    recording_id: str
    units: str | None
    channels: tuple[str, ...]
    reference: tuple[str, ...]
    reference_mode: str
    l_freq: float | None
    h_freq: float | None
    notch_hz: float | None
    # Очистка (N5): спецэффекты подготовки входят в ключ — очищенный сигнал
    # кэшируется отдельно от неочищенного (`services/artifact_cleaner.py`).
    clean: CleanSpec | None = None

    def label(self) -> str:
        """Человекочитаемое описание набора параметров для логов."""
        if self.l_freq is None and self.h_freq is None:
            band = "без полосового фильтра"
        else:
            band = f"полоса {self.l_freq}…{self.h_freq} Гц"
        notch = f", notch {self.notch_hz} Гц" if self.notch_hz else ""
        if self.reference_mode == "none":
            reference = "без референса"
        else:
            reference = ",".join(self.reference) if self.reference else "average"
        clean = f", очистка: {self.clean.label()}" if self.clean and self.clean != CleanSpec() else ""
        return f"{band}{notch}, референс {reference}{clean}"

    def signature(self) -> str:
        """Короткая сигнатура ключа — ``params_key`` строки журнала шагов.

        Это ровно тот ключ, по которому кэшируется сигнал: две задачи с одной
        сигнатурой делят подготовленный сигнал, и по журналу видно, была ли
        между ними кэш-попадание.
        """
        parts = [
            self.recording_id, self.units or "-", ",".join(self.channels),
            ",".join(self.reference) or "average", self.reference_mode,
            str(self.l_freq), str(self.h_freq), str(self.notch_hz),
            self.clean.label() if self.clean else "-",
        ]
        # sha1 здесь — не криптография, а короткий ключ RAM-кэша (12 hex):
        # коллизия стоила бы лишь лишнего попадания/промаха, не подделки данных.
        return hashlib.sha1(  # noqa: S324 — ключ кэша, не защита данных
            "|".join(parts).encode("utf-8"),
        ).hexdigest()[:12]


# LRU подготовленных сигналов и счётчики попаданий (диагностика: «стало ли
# быстрее» должно опираться на цифры, а не на ощущение).
_CACHE: "OrderedDict[_SignalKey, tuple[mne.io.BaseRaw, dict[str, Any]]]" = OrderedDict()
_LOCK = threading.RLock()
# Локи построения по ключу: два потока job-очереди (MAX_CONCURRENT_JOBS=2) не
# должны читать один и тот же EDF дважды, но и не должны сериализоваться на
# разных записях.
_BUILD_LOCKS: dict[_SignalKey, threading.Lock] = {}
_STATS = {"hits": 0, "misses": 0, "evictions": 0}


def _limit(cfg: Settings) -> int:
    """Сколько наборов параметров держать в кэше (0 — кэш выключен)."""
    return max(0, int(getattr(cfg, "prepared_signal_cache_size", 0)))


def _key(
    recording: Recording,
    cfg: Settings,
    l_freq: float | None,
    h_freq: float | None,
    notch_hz: float | None,
    reference_channels: list[str] | None,
    reference_mode: str,
    clean: CleanSpec | None = None,
) -> _SignalKey:
    """Собирает ключ кэша из всех параметров, влияющих на сигнал."""
    return _SignalKey(
        recording_id=recording.recording_id,
        units=cfg.edf_units,
        channels=tuple(cfg.standard_channels),
        reference=tuple(reference_channels or ()),
        reference_mode=reference_mode,
        l_freq=None if l_freq is None else float(l_freq),
        h_freq=None if h_freq is None else float(h_freq),
        notch_hz=None if not notch_hz else float(notch_hz),
        clean=clean,
    )


def _build_lock(key: _SignalKey) -> threading.Lock:
    """Лок построения для конкретного ключа (создаётся по требованию)."""
    with _LOCK:
        lock = _BUILD_LOCKS.get(key)
        if lock is None:
            lock = _BUILD_LOCKS[key] = threading.Lock()
        return lock


def _evict(limit: int) -> None:
    """Уменьшает кэш до ``limit`` записей (вызывается под ``_LOCK``)."""
    while len(_CACHE) > limit:
        evicted, _ = _CACHE.popitem(last=False)
        _BUILD_LOCKS.pop(evicted, None)
        _STATS["evictions"] += 1


def _load(
    recording: Recording,
    cfg: Settings,
    l_freq: float | None,
    h_freq: float | None,
    notch_hz: float | None,
    reference_channels: list[str] | None,
    reference_mode: str,
    clean: CleanSpec | None = None,
) -> tuple[mne.io.BaseRaw, dict[str, Any]]:
    """Читает EDF, применяет предподготовку и очистку (промах кэша).

    Очистка (``CleanSpec``: гармоники notch, bad-каналы, ICA/SSP) применяется
    здесь, до закладки в кэш: все потребители ключа получают один и тот же
    очищенный сигнал, а отчёт очистки едет вместе с ним.
    """
    raw = load_edf(
        recording.path,
        cfg.standard_channels,
        l_freq=l_freq,
        h_freq=h_freq,
        units=cfg.edf_units,
        notch_hz=notch_hz,
        reference_channels=reference_channels,
        reference_mode=reference_mode,
    )
    if clean is None or clean == CleanSpec():
        return raw, {}
    return raw, apply_cleaning(raw, clean, cfg, notch_hz=notch_hz).as_dict()


def _file_size(path: str) -> int | None:
    """Размер файла записи в байтах (``None`` — файл недоступен: это не ошибка шага)."""
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def prepared_raw_report(
    recording: Recording,
    cfg: Settings,
    l_freq: float | None = None,
    h_freq: float | None = None,
    notch_hz: float | None = None,
    reference_channels: list[str] | None = None,
    reference_mode: str = "average",
    pipeline: str | None = None,
    clean: CleanSpec | None = None,
) -> tuple[mne.io.BaseRaw, dict[str, Any]]:
    """Подготовленный сигнал записи: ``load_edf`` с кэшем по параметрам расчёта.

    Возвращает сигнал, которым владеет вызывающий: его можно мутировать
    (``segment_epochs`` ставит аннотации) — кэш хранит собственную копию.

    ``reference_mode`` — ``"average"`` (по умолчанию) или ``"none"``: вторым
    пользуются миксы каналов раздела «ЭЭГ» (``services/channel_mix.py``),
    которым референс не нужен — среднее по группе само является ссылкой.

    ``pipeline`` — имя пайплайна для журнала шагов (`docs/data_map.md` §9):
    попадание в этот кэш — главный ответ на «почему повторный расчёт стоит как
    первый». ``None`` означает «не измерять» (разовые вызовы, тесты).
    """
    started = time.perf_counter()
    limit = _limit(cfg)
    key = _key(
        recording, cfg, l_freq, h_freq, notch_hz, reference_channels, reference_mode, clean,
    )

    def _report(hit: bool, raw: mne.io.BaseRaw) -> None:
        """Строка журнала о шаге чтения EDF (``cache_hit`` — попали ли в кэш)."""
        if pipeline is None:
            return
        journal.record(
            pipeline, "load_edf",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=key.signature(),
            bytes_in=None if hit else _file_size(recording.path),
            bytes_out=int(raw.info["nchan"]) * int(raw.n_times) * 8,  # float64-данные
            cache_hit=hit,
            note=key.label(),
        )

    with _LOCK:
        # Лимит мог быть понижен между вызовами (в т.ч. до нуля — «кэш выключен»):
        # приводим размер к текущему лимиту до поиска.
        _evict(limit)
        cached = _CACHE.get(key) if limit > 0 else None
        if cached is not None:
            _CACHE.move_to_end(key)
            _STATS["hits"] += 1
            logger.info(
                "Подготовленный сигнал: попадание в кэш (запись %s, %s)",
                recording.recording_id, key.label(),
            )
            hit_raw, hit_report = cached[0].copy(), dict(cached[1])
            _report(True, hit_raw)
            return hit_raw, hit_report

    if limit <= 0:
        logger.info("Подготовленный сигнал: кэш выключен, читаю EDF (%s)", key.label())
        raw, clean_report = _load(
            recording, cfg, l_freq, h_freq, notch_hz, reference_channels, reference_mode, clean,
        )
        _report(False, raw)
        return raw, clean_report

    with _build_lock(key):
        # Пока ждали лок, сигнал мог построить соседний поток — второй раз
        # читать файл незачем (в job-очереди два расчёта идут параллельно).
        with _LOCK:
            cached = _CACHE.get(key)
            if cached is not None:
                _CACHE.move_to_end(key)
                _STATS["hits"] += 1
                hit_raw, hit_report = cached[0].copy(), dict(cached[1])
                _report(True, hit_raw)
                return hit_raw, hit_report

        raw, clean_report = _load(
            recording, cfg, l_freq, h_freq, notch_hz, reference_channels, reference_mode, clean,
        )
        _report(False, raw)
        with _LOCK:
            _STATS["misses"] += 1
            _CACHE[key] = (raw.copy(), dict(clean_report))
            _CACHE.move_to_end(key)
            _evict(limit)
        logger.info(
            "Подготовленный сигнал: прочитан EDF (запись %s, %s, %.1f с сигнала)",
            recording.recording_id, key.label(),
            float(raw.n_times) / float(raw.info["sfreq"] or 1.0),
        )
        return raw, clean_report


def prepared_cache_stats(cfg: Settings | None = None) -> dict[str, int]:
    """Счётчики кэша: попадания, промахи, убранные из памяти наборы и их число сейчас."""
    with _LOCK:
        stats = dict(_STATS)
        stats["entries"] = len(_CACHE)
    if cfg is not None:
        stats["limit"] = _limit(cfg)
    return stats


def clear_prepared_cache(recording_id: str | None = None) -> None:
    """Сбрасывает кэш: одну запись или весь.

    Вызывается при вытеснении записи из реестра (``_drop_signal_cache``): кэш
    подготовленного сигнала — производная записи, а не самостоятельные данные.
    """
    with _LOCK:
        if recording_id is None:
            removed = len(_CACHE)
            _CACHE.clear()
            _BUILD_LOCKS.clear()
        else:
            keys = [key for key in _CACHE if key.recording_id == recording_id]
            for key in keys:
                _CACHE.pop(key, None)
                _BUILD_LOCKS.pop(key, None)
            removed = len(keys)
        _STATS["evictions"] += removed
    if removed:
        logger.info("Кэш подготовленного сигнала очищен: наборов %d", removed)


def prepared_raw(
    recording: Recording,
    cfg: Settings,
    l_freq: float | None = None,
    h_freq: float | None = None,
    notch_hz: float | None = None,
    reference_channels: list[str] | None = None,
    reference_mode: str = "average",
    pipeline: str | None = None,
    clean: CleanSpec | None = None,
) -> mne.io.BaseRaw:
    """Подготовленный сигнал записи: тот же кэш, но без отчёта очистки (A4).

    Совместимая обёртка над ``prepared_raw_report`` для расчётов, которым отчёт
    не нужен (спектр, спектрограмма, быстрый расчёт диполей). Они вызывают её
    **без** ``clean``: очистка живёт в пайплайне предподготовки, граница
    задокументирована в `docs/rules/artifacts.md`.
    """
    return prepared_raw_report(
        recording, cfg,
        l_freq=l_freq, h_freq=h_freq, notch_hz=notch_hz,
        reference_channels=reference_channels, reference_mode=reference_mode,
        pipeline=pipeline, clean=clean,
    )[0]
