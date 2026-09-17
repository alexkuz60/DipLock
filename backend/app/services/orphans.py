"""Обход сирот: каталоги, кэши и файлы задач без живой записи (A6, этап 6).

Кэши производных записи привязаны к её вытеснению: ``_drop_signal_cache``
чистит ``signals``/``spectra``/``spectrograms`` и RAM-кэш сигнала, когда запись
уходит по TTL или лимиту истории. Но у записи, которую реестр **уже не знает**
(каталог прошлой сессии без валидного сайдкара, удалённый вручную файл), кэш не
чистит никто — так и появилась сирота ``data/cache/spectrograms/edf/`` (2 файла,
записи ``edf`` в реестре нет). ``prune_orphans`` из ``recordings.py`` при этом
не вызывался автоматически: только из скрипта и тестов.

Здесь три вида сирот сводятся в один обход:

1. **каталоги загрузок** без живого владельца старше TTL —
   ``RecordingRegistry.prune_orphans``;
2. **кэши записей** под ``cache_dir`` (``signals``/``spectra``/``spectrograms``),
   у которых записи нет **ни** в реестре, **ни** в каталоге загрузок (каталог
   без сайдкара реестр не восстанавливает, но запись пользователя на диске жива —
   её кэш сносить нельзя);
3. **файлы задач** исчезнувших записей (``job_store.prune_records``, A8) — ссылка
   на их результат всё равно ответит 404.

Обход вызывается на старте приложения (``main.py``, lifespan) и из скрипта
``backend/scripts/dedupe_recordings.py``. Это не «фоновый чистильщик»: расписания
в проекте нет, а цена обхода — листинг нескольких каталогов; что именно он
удалил, видно по отчёту (``SweepReport``) в логе.

Чего обход **не** делает: не трогает ассеты (``surface``/``mri``/``contours`` —
они живут по версии, а не по записи), журнал шагов и корневые файлы каталога
загрузок (``data/edf/test.edf`` из репозитория).
"""
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from app.core.config import Settings, settings
from app.services import job_store
from app.services.cache_store import cache_clear, cache_path
from app.services.recordings import RecordingRegistry, recording_registry

logger = logging.getLogger(__name__)

# Кэши, ключ которых — recording_id: у сироты их не чистит никто (см. правило 3
# в ``docs/rules/data-and-caches.md``).
RECORDING_CACHE_SUBDIRS = ("signals", "spectra", "spectrograms")


@dataclass
class SweepReport:
    """Что нашёл и убрал обход сирот (для лога, скрипта и тестов)."""

    upload_dirs: List[str] = field(default_factory=list)
    cache_dirs: List[str] = field(default_factory=list)
    job_files: List[str] = field(default_factory=list)
    freed_bytes: int = 0

    @property
    def total(self) -> int:
        """Сколько объектов удалено всего."""
        return len(self.upload_dirs) + len(self.cache_dirs) + len(self.job_files)

    def as_dict(self) -> Dict[str, Any]:
        """Отчёт примитивами — для лога и печати в скрипте."""
        return {
            "upload_dirs": len(self.upload_dirs),
            "cache_dirs": len(self.cache_dirs),
            "job_files": len(self.job_files),
            "freed_bytes": self.freed_bytes,
        }


def _size_of(path: str) -> int:
    """Размер файла или каталога (0 — не читается: размер нужен только для лога)."""
    if os.path.isfile(path):
        try:
            return os.path.getsize(path)
        except OSError:
            return 0
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return total


def _drop_path(path: str) -> None:
    """Удаляет файл внутри каталога кэша; отсутствие и ошибки не поднимаются наружу."""
    try:
        os.remove(path)
    except OSError:
        pass


def _sweep_cache_dirs(cfg: Settings, protected_ids: Set[str]) -> Tuple[List[str], int]:
    """Удаляет кэши записей вне ``protected_ids``: (имена, освобождено байт).

    Каталог сносится через ``cache_clear`` (единственный способ убрать подкаталог
    кэша, правило 9 в ``docs/rules/data-and-caches.md``), одиночный файл — с
    диска: ``shutil.rmtree`` файл не удаляет, а молча пропускает.
    """
    removed: List[str] = []
    freed = 0
    for subdir in RECORDING_CACHE_SUBDIRS:
        root = cache_path(cfg.cache_dir, subdir)
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            if name in protected_ids:
                continue
            path = os.path.join(root, name)
            freed += _size_of(path)
            if os.path.isdir(path):
                cache_clear(cfg.cache_dir, subdir, name)
            else:
                _drop_path(path)
            removed.append(f"{subdir}/{name}")
    return removed, freed


def _disk_recording_ids(root: str) -> Set[str]:
    """Имена каталогов записей, лежащих на диске (даже без сайдкара).

    Каталог без валидного сайдкара реестр не восстанавливает, но запись
    пользователя на диске жива: её кэши и файлы задач сносить нельзя. Сирота —
    только то, у чего нет **ни** записи в реестре, **ни** каталога на диске.
    """
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


def sweep_orphans(
    cfg: Optional[Settings] = None,
    *,
    registry: Optional[RecordingRegistry] = None,
) -> SweepReport:
    """Один проход по сиротам: каталоги загрузок, кэши, файлы задач.

    ``registry`` передаётся тестами (изоляция реестра); по умолчанию — общий
    ``recording_registry``. Сбой обхода не должен мешать запуску приложения —
    исключение логируется, отчёт остаётся частичным (стиль кэшей: «служебная
    уборка не ломает работу», правило 4 в ``docs/rules/data-and-caches.md``).
    """
    cfg = cfg or settings
    active = registry if registry is not None else recording_registry
    report = SweepReport()

    try:
        report.upload_dirs = active.prune_orphans(cfg)
        protected = active.known_ids(cfg) | _disk_recording_ids(active.upload_root(cfg))
        report.cache_dirs, report.freed_bytes = _sweep_cache_dirs(cfg, protected)
        report.job_files = list(
            job_store.prune_records(
                cfg,
                known_recording_ids=protected,
                limit=cfg.jobs_history_limit,
            )
        )
    except Exception:  # noqa: BLE001 — уборка не имеет права ронять старт
        logger.exception("Обход сирот прерван")

    if report.total:
        logger.info(
            "Обход сирот: каталогов записей %d, кэшей %d, файлов задач %d, освобождено %.1f КБ",
            len(report.upload_dirs), len(report.cache_dirs), len(report.job_files),
            report.freed_bytes / 1024.0,
        )
    return report
