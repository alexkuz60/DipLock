"""Записи EDF для просмотра: сохранённый файл + паспорт метаданных.

Просмотр ≠ обработка: создание записи не запускает артефакты, эпохи или диполи —
они приходят из отдельной задачи предподготовки по явной кнопке UI
(принцип «обработка — только по кнопке», docs/ui.md).

Реестр — in-memory + каталог на диске (``data/edf/<recording_id>/<имя>.edf``).
Записи старше TTL и сверх лимита истории удаляются с диска и из реестра
при обращении (ленивая очистка, без фоновых потоков).

Дубликаты не хранятся: содержимое загрузки опознаётся отпечатком sha256, и
повторная загрузка того же файла **открывает существующую запись**
(``deduplicated=True``) вместо второй копии. Отпечаток и паспорт лежат рядом с
файлом — в сайдкаре ``recording.json`` каталога записи, поэтому дедуп переживает
рестарт процесса (в dev ``--reload`` перезапускает его на каждое изменение кода):
индекс каталогов собирается с диска лениво, при первом обращении. Каталоги
прошлых запусков без живого владельца (легаси без сайдкара) удаляются
``prune_orphans`` — но не автоматически: см. ``backend/scripts/dedupe_recordings.py``.
"""
import hashlib
import json
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

# Сайдкар записи (отпечаток содержимого + паспорт) — источник дедупа и
# восстановления реестра после рестарта: без него отпечаток пришлось бы
# пересчитывать по всему EDF, а паспорт — перечитывать через MNE.
SIDECAR_NAME = "recording.json"
SIDECAR_VERSION = 1

# Обязательные поля паспорта в сайдкаре: неполный сайдкар не восстанавливаем
# (иначе в API ушёл бы паспорт без частоты дискретизации и каналов).
_REQUIRED_META_KEYS = ("filename", "n_channels", "sfreq", "duration_sec", "units_autoscaled")


@dataclass
class Recording:
    """Загруженная запись: где лежит файл и его паспорт метаданных."""

    recording_id: str
    filename: str
    path: str
    upload_dir: str
    created_at: float
    meta: Dict[str, Any]
    digest: Optional[str] = None
    """sha256 содержимого файла — по нему опознаётся повторная загрузка."""
    deduplicated: bool = False
    """true — запись отдана повторно, только что записанная копия не понадобилась."""
    owned: bool = True
    """true — каталог создан этим процессом (только такие удаляются с диска)."""


def sidecar_path(upload_dir: str) -> str:
    """Путь сайдкара записи в её каталоге."""
    return os.path.join(upload_dir, SIDECAR_NAME)


def file_digest(path: str) -> str:
    """sha256 содержимого файла (потоково: файл в память не грузится)."""
    with open(path, "rb") as fh:
        return hashlib.file_digest(fh, "sha256").hexdigest()


def read_sidecar(upload_dir: str) -> Optional[Dict[str, Any]]:
    """Читает сайдкар каталога записи (None — нет, битый или чужой версии)."""
    try:
        with open(sidecar_path(upload_dir), "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("version") != SIDECAR_VERSION:
        return None
    return payload


def write_sidecar(recording: Recording) -> bool:
    """Атомарно пишет сайдкар записи. Дедуп — оптимизация, поэтому сбой не роняет загрузку."""
    payload = {
        "version": SIDECAR_VERSION,
        "digest": recording.digest,
        "filename": recording.filename,
        "created_at": recording.created_at,
        "size": os.path.getsize(recording.path) if os.path.exists(recording.path) else None,
        "meta": recording.meta,
    }
    target = sidecar_path(recording.upload_dir)
    tmp = f"{target}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            # datetime паспорта сериализуется строкой (default=str), обратно — fromisoformat
            json.dump(payload, fh, ensure_ascii=False, default=str)
        os.replace(tmp, target)
        return True
    except OSError:
        logger.warning("Не удалось записать сайдкар %s", target, exc_info=True)
        return False


def _recording_from_sidecar(
    upload_dir: str, payload: Optional[Dict[str, Any]],
) -> Optional[Recording]:
    """Собирает запись из сайдкара; None — сайдкара нет, он неполон или файл пропал."""
    if not payload:
        return None
    filename = str(payload.get("filename") or "")
    meta = payload.get("meta")
    if not filename or not isinstance(meta, dict):
        return None
    if any(key not in meta for key in _REQUIRED_META_KEYS):
        return None
    path = os.path.join(upload_dir, filename)
    if not os.path.exists(path):
        return None

    meta = dict(meta)
    recording_id = os.path.basename(os.path.normpath(upload_dir))
    meta["recording_id"] = recording_id
    raw_created = meta.get("created_at")
    if isinstance(raw_created, str):
        try:
            meta["created_at"] = datetime.fromisoformat(raw_created)
        except ValueError:
            meta["created_at"] = datetime.utcnow()
    try:
        created_at = float(payload.get("created_at"))
    except (TypeError, ValueError):
        created_at = os.path.getmtime(path)

    return Recording(
        recording_id=recording_id,
        filename=filename,
        path=path,
        upload_dir=upload_dir,
        created_at=created_at,
        meta=meta,
        digest=payload.get("digest"),
        owned=False,  # каталог найден на диске, а не создан этим процессом
    )


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

    def __init__(
        self,
        max_recordings: int,
        ttl_hours: float,
        upload_dir: Optional[str] = None,
    ) -> None:
        self._max = max(1, max_recordings)
        self._ttl_sec = ttl_hours * 3600.0
        self._upload_dir = upload_dir
        self._items: Dict[str, Recording] = {}
        self._indexed = False

    # --- индекс каталогов на диске (дедуп переживает рестарт) ---------------

    def _root(self, cfg: Settings) -> str:
        """Каталог загрузок: заданный при создании или из настроек."""
        return self._upload_dir or cfg.upload_dir

    def _scan_sidecars(self, cfg: Settings) -> Dict[str, Recording]:
        """Читает сайдкары каталогов загрузок: отпечаток + паспорт каждой записи."""
        root = self._root(cfg)
        found: Dict[str, Recording] = {}
        if not os.path.isdir(root):
            return found
        for name in sorted(os.listdir(root)):
            upload_dir = os.path.join(root, name)
            if not os.path.isdir(upload_dir):
                continue
            recording = _recording_from_sidecar(upload_dir, read_sidecar(upload_dir))
            if recording is not None:
                found[recording.recording_id] = recording
        return found

    def _ensure_index(self, cfg: Settings) -> None:
        """Однократно поднимает реестр с диска (легаси-каталоги без сайдкара не видит)."""
        if self._indexed:
            return
        self._indexed = True
        adopted = self._scan_sidecars(cfg)
        for recording_id, recording in adopted.items():
            self._items.setdefault(recording_id, recording)
        if adopted:
            logger.info("Восстановлено записей из каталога загрузок: %d", len(adopted))

    def find_by_digest(self, digest: Optional[str], cfg: Settings) -> Optional[Recording]:
        """Запись, чей файл совпадает по отпечатку sha256 (None — такой нет)."""
        if not digest:
            return None
        self._ensure_index(cfg)
        for recording in self._items.values():
            if recording.digest == digest and os.path.exists(recording.path):
                return recording
        # Память могла устареть (запись вытеснена по TTL) — сверяемся с диском
        for recording_id, recording in self._scan_sidecars(cfg).items():
            if recording.digest == digest and os.path.exists(recording.path):
                self._items.setdefault(recording_id, recording)
                return recording
        return None

    def _touch(self, recording: Recording) -> None:
        """Освежает сессию переиспользованной записи: TTL считается от обращения.

        ``deduplicated`` — факт ответа («копия не создана»), а не свойство файла;
        ``owned`` — запись снова активна, значит её каталог живёт по общим
        правилам TTL и лимита истории.
        """
        recording.created_at = time.time()
        recording.meta["created_at"] = datetime.utcnow()
        recording.deduplicated = True
        recording.owned = True
        write_sidecar(recording)

    def register(
        self,
        path: str,
        upload_dir: str,
        filename: str,
        cfg: Settings,
        digest: Optional[str] = None,
    ) -> Recording:
        """Регистрирует запись; при совпадении отпечатка — переиспользует прежнюю.

        Возвращённая запись помечена ``deduplicated=True``, если новый файл не
        понадобился: вызывающий код удаляет только что сохранённую копию и отдаёт
        клиенту существующий паспорт (см. ``POST /recordings``).
        """
        existing = self.find_by_digest(digest, cfg)
        if existing is not None:
            self._touch(existing)
            logger.info(
                "Отпечаток %s уже хранится записью %s — копия не создана",
                (digest or "")[:12], existing.recording_id,
            )
            return existing

        if digest is None:
            try:
                digest = file_digest(path)
            except OSError:  # отпечаток не обязателен для работы записи
                logger.warning("Не удалось посчитать отпечаток %s", path)

        meta = read_recording_meta(path, cfg, filename)
        recording_id = os.path.basename(upload_dir)
        meta["recording_id"] = recording_id
        recording = Recording(
            recording_id, filename, path, upload_dir, time.time(), meta, digest=digest,
        )

        self._drop_expired()
        self._items[recording_id] = recording
        self._evict()
        write_sidecar(recording)
        logger.info(
            "Запись %s зарегистрирована (%s, %d каналов, %.1f с)",
            recording_id, filename, meta["n_channels"], meta["duration_sec"],
        )
        return recording

    def prune_orphans(self, cfg: Settings) -> List[str]:
        """Удаляет каталоги без живой записи старше TTL: легаси и мусор прошлых запусков.

        Реестр — in-memory, поэтому каталоги прежних запусков процесса лимит
        истории не видит: без этой уборки они копились бы вечно. Живые записи не
        трогаются, корневые файлы каталога загрузок (например, ``test.edf`` из
        репозитория) не рассматриваются — удаляются только каталоги. Автовызова
        нет: уборку запускает ``backend/scripts/dedupe_recordings.py``.
        """
        self._ensure_index(cfg)
        if self._ttl_sec <= 0:
            return []
        root = self._root(cfg)
        if not os.path.isdir(root):
            return []
        deadline = time.time() - self._ttl_sec
        removed: List[str] = []
        for name in sorted(os.listdir(root)):
            upload_dir = os.path.join(root, name)
            if not os.path.isdir(upload_dir) or name in self._items:
                continue
            try:
                if os.path.getmtime(upload_dir) >= deadline:
                    continue
            except OSError:
                continue
            shutil.rmtree(upload_dir, ignore_errors=True)
            removed.append(name)
        if removed:
            logger.info("Удалены устаревшие каталоги записей: %s", ", ".join(removed))
        return removed

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
        """Сброс реестра (тесты): каталоги, созданные процессом, удаляются с диска."""
        for rec in self._items.values():
            # Записи, найденные на диске при восстановлении, не наши: их каталоги
            # удаляет TTL-уборка (prune_orphans), а не сброс памяти.
            if rec.owned:
                shutil.rmtree(rec.upload_dir, ignore_errors=True)
            _drop_signal_cache(rec.recording_id)
        self._items.clear()
        self._indexed = False  # следующее обращение перечитает сайдкары с диска

    def _drop(self, recording_id: str) -> None:
        rec = self._items.pop(recording_id, None)
        if rec is not None:
            if rec.owned:
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
    upload_dir=settings.upload_dir,
)
