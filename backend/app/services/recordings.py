"""Записи EDF для просмотра: сохранённый файл + паспорт метаданных.

Просмотр ≠ обработка: создание записи не запускает артефакты, эпохи или диполи —
они приходят из отдельной задачи предподготовки по явной кнопке UI
(принцип «обработка — только по кнопке», docs/ui.md).

Реестр — in-memory + каталог на диске (``data/edf/<recording_id>/<имя>.edf``).
Записи старше TTL и сверх лимита истории удаляются с диска и из реестра
при обращении (ленивая очистка, без фоновых потоков).
"""
import logging
import os
import shutil
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

import mne

from app.core.config import Settings, settings
from app.services.edf_loader import looks_unscaled, normalize_channel_name

logger = logging.getLogger(__name__)

# Окно оценки масштаба единиц: весь файл в память не грузим.
_PROBE_SEC = 10.0


@dataclass
class Recording:
    """Загруженная запись: где лежит файл и его паспорт метаданных."""

    recording_id: str
    filename: str
    path: str
    upload_dir: str
    created_at: float
    meta: Dict[str, Any]


def read_recording_meta(path: str, cfg: Settings, filename: str) -> Dict[str, Any]:
    """Читает паспорт EDF: заголовок + короткое окно данных для оценки масштаба.

    Обработки (фильтры, монтаж, референс, артефакты) здесь нет — только то, что
    нужно карточке записи и вьюеру треков.
    """
    kwargs: Dict[str, Any] = {"preload": False, "stim_channel": False}
    if cfg.edf_units:
        kwargs["units"] = cfg.edf_units
    try:
        raw = mne.io.read_raw_edf(path, verbose=False, **kwargs)
    except Exception as exc:
        raise ValueError(f"Не удалось прочитать EDF: {exc}") from exc

    sfreq = float(raw.info["sfreq"])
    if sfreq <= 0 or raw.n_times == 0:
        raise ValueError("Файл не содержит данных (sfreq или длина записи равны нулю)")

    # Масштаб единиц оцениваем по короткому окну (preload=False: читается не
    # весь файл). Явный EDF_UNITS отключает авто-детект.
    probe_samples = min(int(_PROBE_SEC * sfreq), raw.n_times)
    probe = raw.get_data(start=0, stop=probe_samples, verbose=False)
    units_autoscaled = cfg.edf_units is None and looks_unscaled(probe)

    original = list(raw.ch_names)
    normalized = [normalize_channel_name(name) for name in original]
    matched = {name for name in normalized if name in cfg.standard_channels}
    # Порядок монтажа 10-20, а не порядок следования каналов в файле.
    channels = [name for name in cfg.standard_channels if name in matched]
    unmatched = [name for name in normalized if name not in matched]

    warnings: List[str] = []
    if units_autoscaled:
        warnings.append(
            "EDF без physical dimension: масштаб трактуется как микровольты "
            "(если это не так, задайте EDF_UNITS вручную)"
        )
    if not channels:
        warnings.append(
            f"Ни один канал не соответствует монтажу 10-20 (в файле: {original[:8]})"
        )

    return {
        "recording_id": "",  # проставляет реестр
        "filename": filename,
        "n_channels": len(original),
        "channels": channels,
        "unmatched_channels": unmatched,
        "sfreq": sfreq,
        "duration_sec": round(raw.n_times / sfreq, 2),
        "units_autoscaled": units_autoscaled,
        "edf_units": cfg.edf_units,
        "warnings": warnings,
        "created_at": datetime.utcnow(),
    }


def _drop_signal_cache(recording_id: str) -> None:
    """Удаляет производные кэши записи: пирамиду сигналов (2.5) и топокарты (3.4).

    Импорт локальный: ``recording_signals``/``spectral`` импортируют ``recordings``,
    и модульный импорт дал бы цикл. Кэши — только оптимизация, поэтому сбой и не
    должен ронять очистку реестра.
    """
    try:
        from app.services.recording_signals import clear_signal_cache
    except ImportError:  # pragma: no cover — модуль всегда есть
        return
    clear_signal_cache(settings, recording_id)

    try:
        from app.services.spectral import clear_spectrum_cache
    except ImportError:  # pragma: no cover — модуль всегда есть
        return
    clear_spectrum_cache(settings, recording_id)


class RecordingRegistry:
    """In-memory реестр записей с TTL-очисткой каталогов и лимитом истории."""
    def __init__(self, max_recordings: int, ttl_hours: float) -> None:
        self._max = max(1, max_recordings)
        self._ttl_sec = ttl_hours * 3600.0
        self._items: Dict[str, Recording] = {}

    def register(self, path: str, upload_dir: str, filename: str, cfg: Settings) -> Recording:
        """Читает метаданные, регистрирует запись и применяет лимиты хранения."""
        meta = read_recording_meta(path, cfg, filename)
        recording_id = os.path.basename(upload_dir)
        meta["recording_id"] = recording_id
        recording = Recording(recording_id, filename, path, upload_dir, time.time(), meta)

        self._drop_expired()
        self._items[recording_id] = recording
        self._evict()
        logger.info(
            "Запись %s зарегистрирована (%s, %d каналов, %.1f с)",
            recording_id, filename, meta["n_channels"], meta["duration_sec"],
        )
        return recording

    def get(self, recording_id: str) -> Optional[Recording]:
        """Запись по id (None — неизвестна, устарела или файл уже удалён)."""
        self._drop_expired()
        rec = self._items.get(recording_id)
        if rec is None or not os.path.exists(rec.path):
            return None
        return rec

    def list(self) -> List[Recording]:
        """Живые записи в порядке создания (для будущего списка в UI)."""
        self._drop_expired()
        return [
            rec
            for rec in sorted(self._items.values(), key=lambda r: r.created_at)
            if os.path.exists(rec.path)
        ]

    def clear(self) -> None:
        """Сброс реестра (тесты): каталоги записей удаляются с диска."""
        for rec in self._items.values():
            shutil.rmtree(rec.upload_dir, ignore_errors=True)
            _drop_signal_cache(rec.recording_id)
        self._items.clear()

    def _drop(self, recording_id: str) -> None:
        rec = self._items.pop(recording_id, None)
        if rec is not None:
            shutil.rmtree(rec.upload_dir, ignore_errors=True)
            _drop_signal_cache(rec.recording_id)

    def _drop_expired(self) -> None:
        if self._ttl_sec <= 0:
            return
        deadline = time.time() - self._ttl_sec
        for recording_id in [
            rid for rid, rec in self._items.items() if rec.created_at < deadline
        ]:
            self._drop(recording_id)

    def _evict(self) -> None:
        while len(self._items) > self._max:
            oldest = min(self._items.values(), key=lambda r: r.created_at)
            self._drop(oldest.recording_id)


recording_registry = RecordingRegistry(
    max_recordings=settings.recordings_history_limit,
    ttl_hours=settings.recordings_ttl_hours,
)
