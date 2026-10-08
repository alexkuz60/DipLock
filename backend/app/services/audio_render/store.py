"""Дисковый кэш рендера «Нейромузыки»: артефакты и манифест-журнал.

Срез 07.10.2026 (хранение аудио, `docs/rules/neuromusic.md`, §Хранение):
результат рендера (мастер, семь треков, sidecar) живёт на диске в
``cache_dir/audio/{recording_id}/{sig}/`` — это и кэш (повторный POST тех же
параметров не запускает конвейер), и источник для отдачи после рестарта
сервера. Манифест ``manifest.json`` пишется **последним** и служит коммитом:
нет манифеста либо нет файлов из него → промах кэша (честный пересчёт).

Ключ ``sig`` (он же ``render_id``) считает :func:`render_sig` из дешёвых
входов — отпечаток EDF, параметры рендера, частотные полосы, версии контракта
и библиотек — без чтения EDF и без запуска конвейера. Математика/очистка
изменились в коде — поднимите :data:`RENDER_FORMAT_VERSION`, иначе старый кэш
отдаст старые байты под тем же ключом.

Запись файлов идёт через ``cache_store`` (атомарная запись, сбой не ломает
расчёт — правило `docs/rules/data-and-caches.md` п.4): незакоммиченные файлы
(без манифеста) перезаписываются следующим прогоном того же ``sig`` и
убираются обходом сирот вместе с записью.
"""
import hashlib
import json
import logging
import os
from typing import Any

from app.core.config import Settings
from app.services.audio_render.export import SIDECAR_SCHEMA_VERSION
from app.services.cache_store import cache_clear, cache_path, cache_read, cache_write
from app.services.recordings import Recording, edf_stamp
from app.utils.versions import library_versions

logger = logging.getLogger(__name__)

# Версия формата кэша и математики рендера: меняется код конвейера
# (очистка, ядро, психоакустика) — поднимите, иначе старый кэш «повиснет».
RENDER_FORMAT_VERSION = 1

# Каталог кэша записей (ключ верхнего уровня — recording_id, как у других
# производных кэшей: чистится с записью и обходом сирот).
AUDIO_SUBDIR = "audio"

MANIFEST_NAME = "manifest.json"
MASTER_NAME = "master.wav"
SIDECAR_NAME = "sidecar.json"
# Кадры радара «Эмо» (7 лучей по кадрам спектра чистого микса): пишутся
# новыми рендерами и добиваются для старых манифестов (emo_payload_of).
EMO_NAME = "emo.json"

# Длина ключа в URL (sha256-хвост): 128 бит — коллизия практически
# невозможна, путь остаётся читаемым (предыдент: bundle_signature — [:16]).
SIG_LEN = 32


def track_name(band: str) -> str:
    """Имя файла трека полосы внутри каталога рендера."""
    return f"track_{band}.wav"


def row_track_name(row: str, band: str) -> str:
    """Имя файла рядового трека («Монтаж»: ряд × полоса) внутри каталога."""
    return f"track_{row}_{band}.wav"


def render_sig(
    recording: Recording,
    cfg: Settings,
    gains_db: dict[str, float],
    boost_db: float,
    loudness_phon: float | None,
    loudness_autobase: bool,
    octave_shift: int,
    variant: str = "express",
) -> str:
    """Ключ рендера: sha256 от дешёвых входов (без запуска конвейера).

    Входят: отпечаток EDF, нормализованные параметры (нулевые гейны отбрасываются —
    ``{}`` и ``{band: 0}`` ведут себя одинаково), **вариант рендера**
    («Экспресс»/«Монтаж» — у них разные конвейеры и файлы, ключ обязан
    различаться; добавление поля меняет все ключи — старые рендеры честно
    пересчитываются, байты «Экспресса» при этом не меняются), частотные
    полосы конфига, версии контракта (формат кэша, схема sidecar) и научных
    библиотек (детерминизм байтов зависит от numpy/scipy/mne).
    """
    payload: dict[str, Any] = {
        "v": RENDER_FORMAT_VERSION,
        "edf": edf_stamp(recording),
        "gains_db": {band: float(value) for band, value in sorted(gains_db.items()) if value},
        "boost_db": float(boost_db),
        "loudness_phon": None if loudness_phon is None else float(loudness_phon),
        "loudness_autobase": bool(loudness_autobase),
        "octave_shift": int(octave_shift),
        "variant": variant,
        "freq_bands": {
            band: [float(bounds[0]), float(bounds[1])]
            for band, bounds in sorted(cfg.freq_bands.items())
        },
        "schema": SIDECAR_SCHEMA_VERSION,
        "versions": library_versions(),
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:SIG_LEN]


def render_dir(cfg: Settings, recording_id: str, sig: str) -> str:
    """Каталог одного рендера на диске (корень — только из ``settings``)."""
    return cache_path(cfg.cache_dir, AUDIO_SUBDIR, recording_id, sig)


def write_artifacts(
    cfg: Settings, recording_id: str, sig: str, files: dict[str, bytes],
) -> bool:
    """Пишет файлы рендера (без манифеста); ``True`` — всё записалось.

    Манифест не здесь: он коммитит комплект, поэтому пишется последним
    (:func:`write_manifest`) — незакоммиченный каталог промахивается как кэш.
    """
    directory = render_dir(cfg, recording_id, sig)
    ok = True
    for name, data in files.items():
        ok = cache_write(os.path.join(directory, name), data, label="Кэш рендеров «Нейромузыки»") and ok
    return ok


def write_manifest(
    cfg: Settings, recording_id: str, sig: str, manifest: dict[str, Any],
) -> bool:
    """Коммитит рендер в кэше: манифест пишется последним и атомарно."""
    blob = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8")
    path = os.path.join(render_dir(cfg, recording_id, sig), MANIFEST_NAME)
    return cache_write(path, blob, label="Манифест рендера «Нейромузыки»")


def load_manifest(cfg: Settings, recording_id: str, sig: str) -> dict[str, Any] | None:
    """Манифест готового рендера; ``None`` — промах (нет, битый, неполный).

    Промахом считается и отсутствие файлов из манифеста (квота/ручная чистка):
    отдавать по одному манифесту без файлов нельзя.
    """
    directory = render_dir(cfg, recording_id, sig)
    blob = cache_read(os.path.join(directory, MANIFEST_NAME))
    if blob is None:
        return None
    try:
        manifest = json.loads(blob)
    except ValueError:
        return None
    if not isinstance(manifest, dict) or manifest.get("format") != RENDER_FORMAT_VERSION:
        return None
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        return None
    if any(not os.path.isfile(os.path.join(directory, name)) for name in files):
        return None
    return manifest


def find_manifest(cfg: Settings, sig: str) -> tuple[str, dict[str, Any]] | None:
    """Ищет манифест ``sig`` среди записей (восстановление после рестарта).

    Записей немного (реестр ≤ 10), поэтому перебор каталогов дешевле, чем
    отдельный индекс: ``audio/{recording_id}/{sig}/manifest.json``.
    """
    root = cache_path(cfg.cache_dir, AUDIO_SUBDIR)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return None
    for recording_id in names:
        manifest = load_manifest(cfg, recording_id, sig)
        if manifest is not None:
            return recording_id, manifest
    return None


def list_manifests(cfg: Settings, recording_id: str) -> list[tuple[str, dict[str, Any]]]:
    """Готовые рендеры записи: ``(sig, манифест)``, свежие вперёд."""
    root = cache_path(cfg.cache_dir, AUDIO_SUBDIR, recording_id)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    found: list[tuple[str, dict[str, Any]]] = []
    for sig in names:
        manifest = load_manifest(cfg, recording_id, sig)
        if manifest is not None:
            found.append((sig, manifest))
    found.sort(key=lambda item: float(item[1].get("created_at") or 0.0), reverse=True)
    return found


def read_artifact(directory: str, name: str) -> bytes | None:
    """Байты файла рендера из каталога (``None`` — нет/не читается)."""
    return cache_read(os.path.join(directory, name))


def clear_audio_cache(cfg: Settings, recording_id: str) -> None:
    """Сносит все рендеры записи (вызывается вместе с её кэшами)."""
    cache_clear(cfg.cache_dir, AUDIO_SUBDIR, recording_id)

