"""Чистка каталога загрузок EDF: дубликаты по sha256, сайдкары, устаревший мусор.

Разовая операция для каталога, накопленного **до** включения дедупа: реестр
записей — in-memory, поэтому каталоги прежних запусков процесса лимит истории не
видел, и один и тот же файл мог лежать десятками копий.

Что делает:

1. считает sha256 каждой записи (``<каталог>/<имя>.edf``);
2. в группе одинаковых отпечатков оставляет **один** каталог
   (``--keep newest|oldest``, по умолчанию newest), остальные удаляет;
3. оставленным каталогам без сайдкара пишет ``recording.json`` (отпечаток +
   паспорт) — после этого дедуп работает сразу, без повторных загрузок;
4. по флагу ``--prune`` заодно сносит устаревшие каталоги без живого владельца
   (``RecordingRegistry.prune_orphans``, TTL из настроек).

Без ``--apply`` печатает только план и итог. Корневые **файлы** каталога загрузок
(например ``data/edf/test.edf`` из репозитория) не рассматриваются: обход идёт
исключительно по каталогам записей.

Запуск:
    backend/venv/bin/python backend/scripts/dedupe_recordings.py            # план
    backend/venv/bin/python backend/scripts/dedupe_recordings.py --apply    # убрать
"""
import argparse
import logging
import os
import shutil
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:  # запуск файлом, а не модулем
    sys.path.insert(0, _BACKEND_DIR)

from app.core.config import Settings, settings  # noqa: E402
from app.services.recordings import (  # noqa: E402
    Recording,
    file_digest,
    read_recording_meta,
    read_sidecar,
    recording_registry,
    write_sidecar,
)

logger = logging.getLogger("dedupe_recordings")


@dataclass
class RecordDir:
    """Каталог записи: что лежит, чей отпечаток и когда появился."""

    upload_dir: str
    filename: str
    digest: str
    size: int
    created_at: float
    has_sidecar: bool


def _record_path(upload_dir: str) -> Optional[str]:
    """EDF внутри каталога записи: имя из сайдкара или единственный ``*.edf``."""
    payload = read_sidecar(upload_dir)
    if payload:
        candidate = os.path.join(upload_dir, str(payload.get("filename") or ""))
        if os.path.isfile(candidate):
            return candidate
    edfs = sorted(name for name in os.listdir(upload_dir) if name.lower().endswith(".edf"))
    if len(edfs) == 1:
        return os.path.join(upload_dir, edfs[0])
    return None


def scan_records(root: str) -> List[RecordDir]:
    """Каталоги записей каталога загрузок: отпечаток, размер, время создания."""
    records: List[RecordDir] = []
    if not os.path.isdir(root):
        return records
    for name in sorted(os.listdir(root)):
        upload_dir = os.path.join(root, name)
        if not os.path.isdir(upload_dir):
            continue  # корневые файлы (test.edf из репозитория) не трогаем
        path = _record_path(upload_dir)
        if path is None:
            logger.warning("Пропущен каталог без одного EDF: %s", upload_dir)
            continue
        payload = read_sidecar(upload_dir)
        digest = (payload or {}).get("digest")
        if not digest:
            digest = file_digest(path)
        try:
            created_at = float((payload or {}).get("created_at"))
        except (TypeError, ValueError):
            created_at = os.path.getmtime(upload_dir)
        records.append(
            RecordDir(
                upload_dir=upload_dir,
                filename=os.path.basename(path),
                digest=digest,
                size=os.path.getsize(path),
                created_at=created_at,
                has_sidecar=payload is not None,
            )
        )
    return records


def plan_cleanup(
    records: Sequence[RecordDir], keep: str = "newest",
) -> Tuple[List[RecordDir], List[RecordDir]]:
    """Делит записи на «оставить» и «удалить»: по одному каталогу на отпечаток."""
    groups: Dict[str, List[RecordDir]] = {}
    for record in records:
        groups.setdefault(record.digest, []).append(record)

    kept: List[RecordDir] = []
    removed: List[RecordDir] = []
    for group in groups.values():
        ordered = sorted(group, key=lambda r: r.created_at, reverse=(keep == "newest"))
        kept.append(ordered[0])
        removed.extend(ordered[1:])
    return kept, removed


def backfill_sidecars(kept: Sequence[RecordDir], cfg: Settings) -> int:
    """Пишет сайдкары оставленным каталогам (паспорт читается один раз через MNE)."""
    written = 0
    for record in kept:
        if record.has_sidecar:
            continue
        path = os.path.join(record.upload_dir, record.filename)
        try:
            meta = read_recording_meta(path, cfg, record.filename)
        except ValueError as exc:  # битый EDF: каталог оставляем как есть
            logger.warning("Сайдкар не записан (%s): %s", record.upload_dir, exc)
            continue
        write_sidecar(
            Recording(
                recording_id=os.path.basename(record.upload_dir),
                filename=record.filename,
                path=path,
                upload_dir=record.upload_dir,
                created_at=record.created_at,
                meta=meta,
                digest=record.digest,
                owned=False,
            )
        )
        written += 1
    return written


def apply_cleanup(removed: Sequence[RecordDir]) -> int:
    """Удаляет лишние каталоги записей; возвращает освобождённые байты."""
    freed = 0
    for record in removed:
        if os.path.isdir(record.upload_dir):
            for name in os.listdir(record.upload_dir):
                candidate = os.path.join(record.upload_dir, name)
                if os.path.isfile(candidate):
                    freed += os.path.getsize(candidate)
        shutil.rmtree(record.upload_dir, ignore_errors=True)
    return freed


def _mb(size: int) -> str:
    """Размер человекочитаемо (МБ)."""
    return f"{size / (1024 * 1024):.1f} МБ"


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Разбирает аргументы, печатает план и (с ``--apply``) выполняет уборку."""
    parser = argparse.ArgumentParser(description="Дедуп и уборка каталога записей EDF")
    parser.add_argument("--upload-dir", default=settings.upload_dir, help="каталог загрузок")
    parser.add_argument("--keep", choices=("newest", "oldest"), default="newest")
    parser.add_argument("--apply", action="store_true", help="выполнить уборку (иначе — план)")
    parser.add_argument("--prune", action="store_true", help="снести устаревшие каталоги (TTL)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    root = args.upload_dir
    records = scan_records(root)
    kept, removed = plan_cleanup(records, keep=args.keep)

    print(f"Каталог загрузок: {root}")
    print(f"Записей найдено: {len(records)} (уникальных отпечатков: {len(kept)})")
    for record in kept:
        print(
            f"  оставить  {os.path.basename(record.upload_dir)}  {record.filename}  "
            f"{_mb(record.size)}  отпечаток {record.digest[:12]}"
        )
    for record in removed:
        print(
            f"  удалить   {os.path.basename(record.upload_dir)}  {record.filename}  "
            f"{_mb(record.size)}  отпечаток {record.digest[:12]}"
        )
    print(f"Освободится: {_mb(sum(record.size for record in removed))}")

    if not args.apply:
        print("План. Для удаления повторите с --apply")
        return 0

    freed = apply_cleanup(removed)
    written = backfill_sidecars(kept, settings)
    print(f"Удалено каталогов: {len(removed)} (освобождено {_mb(freed)})")
    print(f"Записано сайдкаров: {written}")

    if args.prune:
        pruned = recording_registry.prune_orphans(settings)
        print(f"Убрано устаревших каталогов: {len(pruned)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
