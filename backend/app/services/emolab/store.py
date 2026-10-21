"""Дисковый кэш анализа аудиотреков «ЕмоЛаб»: источник + emo.json + манифест.

Постановка 20.10.2026 (шаг 1): анализ внешнего трека — производный артефакт,
который переживает рестарт и не пересчитывается при повторном открытии.
Каталог ``cache_dir/emolab/{track_id}/`` — по образцу
``services/audio_render/store.py``: файлы пишутся через ``cache_store``
(атомарно), ``manifest.json`` пишется **последним** и служит коммитом: нет
манифеста либо нет файлов из него → промах кэша (честный пересчёт).

``track_id`` — sha256 содержимого исходного файла (хвост
:data:`TRACK_ID_LEN`): один и тот же трек, открытый повторно, попадает в тот
же каталог. Источник ``source.{wav|mp3}`` хранится ради будущего сравнения
собранной карты с ЭЭГ-сессией прослушивания этого трека (отдельная задача).

Кэш **не привязан к записям ЭЭГ**, поэтому его нет в
``orphans.RECORDING_CACHE_SUBDIRS`` (сироты и квота записи его не трогают):
чистка своя — :func:`sweep_tracks` (TTL + лимит числа треков, LRU по mtime),
вызывается после каждого успешного анализа.
"""
import json
import logging
import os
import time
from typing import Any

from app.core.config import Settings
from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write

logger = logging.getLogger(__name__)

# Версия формата кэша анализа: меняется математика/состав файлов — поднимите,
# иначе старый кэш «повиснет» под тем же track_id (как RENDER_FORMAT_VERSION).
TRACK_FORMAT_VERSION = 1

# Каталог кэша треков (ключ верхнего уровня — track_id, не recording_id).
EMOLAB_SUBDIR = "emolab"

MANIFEST_NAME = "manifest.json"
EMO_NAME = "emo.json"
SOURCE_PREFIX = "source"

# Длина ключа в URL (sha256-хвост): 128 бит — как у рендера (SIG_LEN).
TRACK_ID_LEN = 32

# Жизненный цикл кэша: TTL каталога и лимит числа треков (LRU по mtime).
TRACK_TTL_SEC = 7 * 24 * 3600
MAX_TRACKS = 24


def source_name(filename: str) -> str:
    """Имя файла-исходника внутри каталога трека (``source.wav``/``source.mp3``)."""
    ext = ".mp3" if filename.lower().endswith(".mp3") else ".wav"
    return f"{SOURCE_PREFIX}{ext}"


def track_dir(cfg: Settings, track_id: str) -> str:
    """Каталог трека в кэше (создаётся при записи через ``cache_write``)."""
    return cache_path(cfg.cache_dir, EMOLAB_SUBDIR, track_id)


def write_track_files(cfg: Settings, track_id: str, files: dict[str, bytes]) -> bool:
    """Пишет файлы трека (без манифеста); ``True`` — всё записалось.

    Манифест не здесь: он коммитит комплект, поэтому пишется последним
    (:func:`write_manifest`) — незакоммиченный каталог промахивается как кэш.
    """
    directory = track_dir(cfg, track_id)
    ok = True
    for name, data in files.items():
        ok = cache_write(
            os.path.join(directory, name), data, label="Кэш аудиотреков «ЕмоЛаб»",
        ) and ok
    return ok


def write_manifest(cfg: Settings, track_id: str, manifest: dict[str, Any]) -> bool:
    """Коммитит анализ в кэше: манифест пишется последним и атомарно."""
    blob = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
    path = os.path.join(track_dir(cfg, track_id), MANIFEST_NAME)
    return cache_write(path, blob, label="Манифест аудиотрека «ЕмоЛаб»")


def load_manifest(cfg: Settings, track_id: str) -> dict[str, Any] | None:
    """Манифест готового анализа; ``None`` — промах (нет, битый, неполный).

    Промахом считается и отсутствие файлов из манифеста (ручная чистка,
    вытеснение) — отдавать по одному манифесту без файлов нельзя.
    """
    directory = track_dir(cfg, track_id)
    blob = cache_read(os.path.join(directory, MANIFEST_NAME))
    if blob is None:
        return None
    try:
        manifest = json.loads(blob)
    except ValueError:
        return None
    if not isinstance(manifest, dict) or manifest.get("format") != TRACK_FORMAT_VERSION:
        return None
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        return None
    if any(not os.path.isfile(os.path.join(directory, name)) for name in files):
        return None
    return manifest


def read_artifact(cfg: Settings, track_id: str, name: str) -> bytes | None:
    """Байты файла анализа из каталога трека (``None`` — нет/не читается)."""
    return cache_read(os.path.join(track_dir(cfg, track_id), name))


def clear_track(cfg: Settings, track_id: str) -> None:
    """Сносит каталог одного трека (тесты, ручная чистка)."""
    cache_clear(cfg.cache_dir, EMOLAB_SUBDIR, track_id)


def _mtime_of(path: str) -> float:
    """mtime каталога (0 — не читается: нужен только для LRU-порядка)."""
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def sweep_tracks(cfg: Settings) -> int:
    """Чистка кэша: TTL (:data:`TRACK_TTL_SEC`) + лимит :data:`MAX_TRACKS`.

    Сносятся самые старые каталоги (LRU по mtime); возвращает число удалённых.
    Вызывается после каждого успешного анализа — обход дёшев (листинг одного
    каталога), расписания в проекте нет (как у обхода сирот).
    """
    root = cache_path(cfg.cache_dir, EMOLAB_SUBDIR)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return 0
    dirs = [
        (os.path.join(root, name), name)
        for name in names
        if os.path.isdir(os.path.join(root, name))
    ]
    now = time.time()
    drop = [(path, name) for path, name in dirs if now - _mtime_of(path) > TRACK_TTL_SEC]
    keep = [(path, name) for path, name in dirs if (path, name) not in drop]
    keep.sort(key=lambda item: _mtime_of(item[0]))  # старые первыми
    while len(keep) > MAX_TRACKS:
        drop.append(keep.pop(0))
    for _path, name in drop:
        cache_clear(cfg.cache_dir, EMOLAB_SUBDIR, name)
    if drop:
        logger.info("Кэш «ЕмоЛаб»: убрано треков %d", len(drop))
    return len(drop)