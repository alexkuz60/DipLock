"""Тома fsaverage «как есть» для 3D-вида Niivue (3.5, N33).

Сервер отдаёт **файлы FreeSurfer без перекодирования** (сервер = файлы + ETag,
N33): Niivue читает ``.mgz`` (FreeSurfer MGH) и FreeSurfer-поверхности сам, а
наш пайплайн срезов ему не нужен. Единственная забота сервера — безопасность и
кэш:

* **белый словарь имён** (``VOLUME_FILES``): имя из URL сопоставляется с
  фиксированным относительным путём, поэтому path traversal невозможен —
  чужое имя не «падает» в файловую систему, а получает 404 до чтения;
* **отпечаток версии** (``asset_versions``, kind ``volumes``): ETag и ``?v=``
  считаются по size/mtime файлов, как у остальных ассетов;
* **affine тома** (``t1_affine``) — для ``/meta``: Niivue и диполи живут в
  разных координатах (воксели тома против мм MNI), и конвертация идёт по
  матрице из одного источника. ``None`` — файла нет (UI не получает выдуманных
  чисел).
"""
import os
from functools import lru_cache
from typing import Any, cast

import nibabel as nib

from app.core.config import Settings
from app.services import asset_versions

# Белый словарь имён: имя в URL → путь относительно ``subjects_dir``.
# Добавляя файл, объявляйте его и в ``asset_versions.MRI_VOLUMES_STAMP_RELATIVE``
# (отпечаток версии) — иначе замена файла не инвалидирует кэш браузера.
VOLUME_FILES: dict[str, str] = {
    "T1.mgz": "fsaverage/mri/T1.mgz",
    "seghead.mgz": "fsaverage/mri/seghead.mgz",
    "lh.white": "fsaverage/surf/lh.white",
    "rh.white": "fsaverage/surf/rh.white",
}

# Файл, чей affine нужен ``/meta`` для конвертации мм MNI → координаты тома.
_T1_NAME = "T1.mgz"


def volume_names() -> list[str]:
    """Имена из белого списка (для ``/meta`` и подсказок UI)."""
    return list(VOLUME_FILES)


def volume_version(settings: Settings) -> str:
    """Отпечаток версии томов (ETag/``?v=``, O(1) — только stat файлов)."""
    return asset_versions.fingerprint("volumes", str(settings.subjects_dir))


def volume_bytes(settings: Settings, name: str) -> tuple[bytes, str]:
    """Байты тома/поверхности + версия ассета.

    Неизвестное имя — ``KeyError`` (роут отвечает 404, чужое имя не читается),
    отсутствующий файл — ``FileNotFoundError`` (503: данные не скачаны).
    """
    relative = VOLUME_FILES[name]  # KeyError = имя вне белого списка
    path = os.path.join(str(settings.subjects_dir), relative)
    with open(path, "rb") as handle:
        return handle.read(), volume_version(settings)


@lru_cache(maxsize=2)
def _t1_affine(subjects_dir: str) -> tuple[tuple[float, ...], ...] | None:
    """Affine ``T1.mgz`` (воксель → мировые координаты тома) или ``None``.

    Читается один раз на процесс (заголовок mgz, не весь том); любой сбой
    чтения — ``None``, а не исключение: ссылка в ``/meta`` не должна ронять
    ответ из-за отсутствующего научного ассета.
    """
    relative = VOLUME_FILES[_T1_NAME]
    try:
        image = cast("nib.MGHImage", nib.load(os.path.join(subjects_dir, relative)))
        affine = image.affine
    except Exception:
        return None
    return tuple(tuple(float(value) for value in row) for row in affine)


def t1_affine(settings: Settings) -> list[list[float]] | None:
    """Affine ``T1.mgz`` списком списков для ``/meta`` (``None`` — файла нет)."""
    affine = _t1_affine(str(settings.subjects_dir))
    if affine is None:
        return None
    return [list(row) for row in affine]


def volumes_ref(settings: Settings) -> dict[str, Any]:
    """Ссылка на тома для ``/meta``: версия, URL, имена, affine (без чтения байтов)."""
    return {
        "version": volume_version(settings),
        "url": f"{settings.api_prefix}/surface/mri/volume",
        "names": volume_names(),
        "affine": t1_affine(settings),
    }


def clear_volume_cache() -> None:
    """Сбрасывает in-memory кэш affine (используется в тестах)."""
    _t1_affine.cache_clear()
