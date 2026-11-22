"""Файлы библиотеки знаний: каталог, квоты, дедуп по sha256.

Файлы лежат вне git (``data/knowledge``), по одному каталогу на документ:
``<id>/<исходное имя>``. Квоты проверяются **до** записи на диск, чтобы
отказ не оставлял мусор.
"""
from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path

from app.core.config import settings


class KnowledgeLimitError(Exception):
    """Файл или библиотека превышают квоту: текст для UI, без путей сервера."""


@dataclass(frozen=True)
class StoredFile:
    """Сохранённый файл: путь, хеш и размер."""

    path: Path
    sha256: str
    size_bytes: int


def knowledge_root() -> Path:
    """Корень библиотеки (создаётся при первом обращении)."""
    root = Path(settings.knowledge_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def document_dir(document_id: str) -> Path:
    """Каталог документа: ``<корень>/<id>``."""
    return knowledge_root() / document_id


def total_bytes() -> int:
    """Занятый объём библиотеки в байтах (обход каталога, без кэша)."""
    root = knowledge_root()
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def check_limits(size_bytes: int) -> None:
    """Проверяет лимит файла и остаток квоты библиотеки.

    ``KnowledgeLimitError`` — честный отказ с числами в мегабайтах: UI
    показывает его как есть, без серверных путей.
    """
    limit = settings.knowledge_max_file_mb * 1024 * 1024
    if size_bytes > limit:
        raise KnowledgeLimitError(
            f"Файл больше лимита {settings.knowledge_max_file_mb} МБ "
            f"({size_bytes / 1024 / 1024:.1f} МБ)",
        )
    total_limit = settings.knowledge_max_total_mb * 1024 * 1024
    if total_bytes() + size_bytes > total_limit:
        raise KnowledgeLimitError(
            f"Библиотека превысит лимит {settings.knowledge_max_total_mb} МБ — "
            "удалите часть документов",
        )


def sha256_of(data: bytes) -> str:
    """SHA-256 содержимого: ключ дедупа повторных загрузок."""
    return hashlib.sha256(data).hexdigest()


def save_bytes(document_id: str, filename: str, data: bytes) -> StoredFile:
    """Пишет файл документа, проверяя квоты; возвращает путь, хеш и размер."""
    check_limits(len(data))
    target_dir = document_dir(document_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(filename).name or "document"
    path = target_dir / safe_name
    path.write_bytes(data)
    return StoredFile(path=path, sha256=sha256_of(data), size_bytes=len(data))


def delete_document_files(document_id: str) -> None:
    """Удаляет каталог документа; отсутствие — не ошибка."""
    shutil.rmtree(document_dir(document_id), ignore_errors=True)
