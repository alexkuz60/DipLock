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

4. **квота по объёму** (N40/4.6, ``cache_quota_mb``): если ``data/cache`` занят
   больше лимита, в том же проходе уходят **самые старые** кэши записей (LRU по
   mtime) — не только сироты, а любой переживший TTL. Квота выключена по
   умолчанию (``0``): лимит — осознанное решение владельца, а не дефолт,
   сносящий кэш «потому что много».

Чего обход **не** делает: не трогает ассеты (``surface``/``mri``/``contours`` —
они живут по версии, а не по записи), журнал шагов и корневые файлы каталога
загрузок (``data/edf/test.edf`` из репозитория).
"""
import contextlib
import logging
import os
from dataclasses import dataclass, field
from typing import Any

from app.core.config import Settings, settings
from app.services import job_store
from app.services.cache_store import cache_clear, cache_path
from app.services.recordings import RecordingRegistry, recording_registry

logger = logging.getLogger(__name__)

# Кэши записей: ключ верхнего уровня — recording_id, поэтому сирота сносится
# обходом, а квота (N40/4.6) видит их как единицы LRU-чистки.
# ``compare`` — карты разности пар записей: верхний уровень по id_A, второй
# (``{id_A}/{signature}``) чистится вместе с A, парные файлы с мёртвым B под
# живой A уходят при удалении B (``_drop_signal_cache``).
# ``audio`` — артефакты рендера «Нейромузыки» (``{recording_id}/{sig}``):
# мастер/треки WAV + манифест, чистятся с записью и участвуют в квоте.
RECORDING_CACHE_SUBDIRS = (
    "signals", "spectra", "spectrograms", "prepared", "reports", "compare", "bundles", "audio",
)

# Подкаталоги ``reports``, ключ которых — не recording_id: HTML отчётов
# группового анализа (раздел «Итоги», ``services/group_reports.py``). Их чистка
# своя: ``compare`` привязана к файлу задачи (``_sweep_compare_reports``),
# ``group`` — к строке ``group_analyses``, а истории прогонов не удаляются,
# поэтому сирот там не бывает.
RESERVED_REPORT_SUBDIRS = ("compare", "group")


@dataclass
class SweepReport:
    """Что нашёл и убрал обход сирот (для лога, скрипта и тестов)."""

    upload_dirs: list[str] = field(default_factory=list)
    cache_dirs: list[str] = field(default_factory=list)
    job_files: list[str] = field(default_factory=list)
    # Убрано квотой (N40/4.6): это не сироты, а самые старые кэши живых записей
    quota_dirs: list[str] = field(default_factory=list)
    freed_bytes: int = 0

    @property
    def total(self) -> int:
        """Сколько объектов удалено всего."""
        return (
            len(self.upload_dirs)
            + len(self.cache_dirs)
            + len(self.job_files)
            + len(self.quota_dirs)
        )

    def as_dict(self) -> dict[str, Any]:
        """Отчёт примитивами — для лога и печати в скрипте."""
        return {
            "upload_dirs": len(self.upload_dirs),
            "cache_dirs": len(self.cache_dirs),
            "job_files": len(self.job_files),
            "quota_dirs": len(self.quota_dirs),
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
    with contextlib.suppress(OSError):
        os.remove(path)


def _sweep_cache_dirs(cfg: Settings, protected_ids: set[str]) -> tuple[list[str], int]:
    """Удаляет кэши записей вне ``protected_ids``: (имена, освобождено байт).

    Каталог сносится через ``cache_clear`` (единственный способ убрать подкаталог
    кэша, правило 9 в ``docs/rules/data-and-caches.md``), одиночный файл — с
    диска: ``shutil.rmtree`` файл не удаляет, а молча пропускает.
    """
    removed: list[str] = []
    freed = 0
    for subdir in RECORDING_CACHE_SUBDIRS:
        root = cache_path(cfg.cache_dir, subdir)
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            if name in protected_ids:
                continue
            # Свои ключи у ``reports``: HTML отчётов группового анализа — не
            # запись, их чистит ``_sweep_compare_reports`` (см. константу).
            if subdir == "reports" and name in RESERVED_REPORT_SUBDIRS:
                continue
            path = os.path.join(root, name)
            freed += _size_of(path)
            if os.path.isdir(path):
                cache_clear(cfg.cache_dir, subdir, name)
            else:
                _drop_path(path)
            removed.append(f"{subdir}/{name}")
    return removed, freed


def _sweep_compare_reports(cfg: Settings) -> tuple[list[str], int]:
    """HTML отчётов сравнений, чья задача уже вышла из истории (A8).

    Файлы задач прогона ``prune_records`` по ``jobs_history_limit``, а отчёт
    строится из результата задачи — значит, вместе с ним файл кэша сирота.
    Прогонам группы отчёт сиротой не бывает: строки ``group_analyses`` —
    история и не удаляются («история не UPSERT», §8.4.2).
    """
    root = cache_path(cfg.cache_dir, "reports", "compare")
    if not os.path.isdir(root):
        return [], 0
    removed: list[str] = []
    freed = 0
    for name in sorted(os.listdir(root)):
        try:
            known = os.path.exists(job_store.job_path(cfg, name))
        except ValueError:
            # Имя не похоже на job_id: к задаче его не привязать — сирота.
            known = False
        if known:
            continue
        path = os.path.join(root, name)
        freed += _size_of(path)
        if os.path.isdir(path):
            cache_clear(cfg.cache_dir, "reports", "compare", name)
        else:
            _drop_path(path)
        removed.append(f"reports/compare/{name}")
    return removed, freed


def _disk_recording_ids(root: str) -> set[str]:
    """Имена каталогов записей, лежащих на диске (даже без сайдкара).

    Каталог без валидного сайдкара реестр не восстанавливает, но запись
    пользователя на диске жива: её кэши и файлы задач сносить нельзя. Сирота —
    только то, у чего нет **ни** записи в реестре, **ни** каталога на диске.
    """
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


def _mtime_of(path: str) -> float:
    """mtime файла/каталога (0 — не читается: нужен только для LRU-порядка)."""
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def _quota_units(cfg: Settings) -> list[tuple[float, int, tuple[str, ...], str]]:
    """Единицы кэша «запись × подкаталог»: ``(mtime, размер, parts, метка)``.

    Части ``parts`` кладутся в ``cache_clear(cfg.cache_dir, *parts)``.
    Для ``reports`` единица — глубже на уровень (``reports/compare/{id}``): ключ
    отчёта — не recording_id верхнего уровня (см. ``RESERVED_REPORT_SUBDIRS``).
    Для ``audio`` единица — один каталог верхнего уровня внутри записи:
    рендер (``audio/{recording_id}/{sig}``) либо баки (``audio/{recording_id}/bake``):
    WAV весят сотни МБ, и LRU обязан стареть по каждому, а не по записи.
    """
    units: list[tuple[float, int, tuple[str, ...], str]] = []
    for subdir in RECORDING_CACHE_SUBDIRS:
        root = cache_path(cfg.cache_dir, subdir)
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            path = os.path.join(root, name)
            if subdir == "reports" and name in RESERVED_REPORT_SUBDIRS:
                if not os.path.isdir(path):
                    continue
                for child in sorted(os.listdir(path)):
                    child_path = os.path.join(path, child)
                    units.append((
                        _mtime_of(child_path), _size_of(child_path),
                        (subdir, name, child), f"{subdir}/{name}/{child}",
                    ))
            elif subdir == "audio" and os.path.isdir(path):
                # Рендеры: юнит = один каталог {sig} внутри записи.
                for child in sorted(os.listdir(path)):
                    child_path = os.path.join(path, child)
                    units.append((
                        _mtime_of(child_path), _size_of(child_path),
                        (subdir, name, child), f"{subdir}/{name}/{child}",
                    ))
            else:
                units.append((
                    _mtime_of(path), _size_of(path),
                    (subdir, name), f"{subdir}/{name}",
                ))
    return units


def cache_usage(cfg: Settings) -> dict[str, int]:
    """Занятость кэша записей: ``(usage_bytes, units, quota_bytes)`` примитивами.

    Для ``/init-status`` (панель «Состояние сервера») и для квоты: один листинг
    каталогов, содержимое файлов не читается. ``quota_bytes = 0`` — квота не
    задана (``cache_quota_mb = 0``).
    """
    units = _quota_units(cfg)
    return {
        "usage_bytes": sum(size for _, size, _, _ in units),
        "units": len(units),
        "quota_bytes": max(0, int(cfg.cache_quota_mb)) * 1024 * 1024,
    }


def _enforce_cache_quota(cfg: Settings) -> tuple[list[str], int]:
    """Квота N40/4.6: пока занято больше лимита, уходят самые старые кэши (LRU).

    Стирание — тем же ``cache_clear`` (правило 9 в ``docs/rules/data-and-caches.md``).
    Пустой результат — обычное состояние (квота выключена или её хватает).
    """
    if cfg.cache_quota_mb <= 0:
        return [], 0
    quota_bytes = cfg.cache_quota_mb * 1024 * 1024
    units = sorted(_quota_units(cfg), key=lambda item: item[0])  # старые первыми
    total = sum(size for _, size, _, _ in units)
    removed: list[str] = []
    freed = 0
    for _, size, parts, label in units:
        if total <= quota_bytes:
            break
        cache_clear(cfg.cache_dir, *parts)
        total -= size
        freed += size
        removed.append(label)
    if removed:
        logger.info(
            "Квота кэша %d МБ: удалено единиц %d, освобождено %.1f МБ",
            cfg.cache_quota_mb, len(removed), freed / (1024 * 1024),
        )
    return removed, freed


def sweep_orphans(
    cfg: Settings | None = None,
    *,
    registry: RecordingRegistry | None = None,
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
        # После prune_records: HTML отчёта compare живёт с файлом задачи,
        # поэтому в тот же проход убираем и его сирот (A8)
        stale_reports, report_bytes = _sweep_compare_reports(cfg)
        report.cache_dirs += stale_reports
        report.freed_bytes += report_bytes
        # Квота (N40/4.6) — последним шагом: сироты убраны, теперь у живых
        # записей по объёму и mtime уходят самые старые кэши.
        report.quota_dirs, quota_freed = _enforce_cache_quota(cfg)
        report.freed_bytes += quota_freed
    except Exception:
        logger.exception("Обход сирот прерван")

    if report.total:
        logger.info(
            "Обход сирот: каталогов записей %d, кэшей %d, файлов задач %d, освобождено %.1f КБ",
            len(report.upload_dirs), len(report.cache_dirs), len(report.job_files),
            report.freed_bytes / 1024.0,
        )
    return report
