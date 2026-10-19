"""Силуэт коры fsaverage для обводки glass brain (срез 3.12, доводка 18.10.2026).

Источник контура — наружная корковая поверхность ``surf/lh.pial`` + ``rh.pial``,
та же, что даёт ``silhouette=True`` у MNE (``stc.plot_3d(...,
brain_kwargs=dict(silhouette=True))``): проекция меша на плоскость даёт границы
мозга с извилинами. Регистрационная сфера ``*.sphere`` сознательно **не**
используется: все её вершины лежат на радиусе 100 мм, силуэт получается кругом,
а не мозгом.

Координаты вершин fsaverage — те же, что MNI-сетка тома (как в
``atlas_contours._brodmann_volume``: вершины сопоставляются с узлами
``axis_grid`` без трансформов), поэтому проекция — выбор двух столбцов
координат по осям плоскости.

Растеризация: точки вершин и центроиды треугольников ложатся на сетку
``SILHOUETTE_SPACING_MM``, морфологическое замыкание добивает промежутки между
треугольниками, ``binary_fill_holes`` заливает внутренности — получается маска
проекции меша. Контур трассируется общим ``trace_mask_contours`` (как контуры
среза и структур). Загрузка меша ~1 с, растеризация — миллисекунды; результат
кэшируется ``lru_cache``.
"""
import logging
import os
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import nibabel as nib
import numpy as np
from scipy import ndimage

from app.core.config import Settings
from app.services import asset_versions, journal
from app.services.mri_slices import PLANE_AXES, PLANES, axis_grid
from app.utils.marching_squares import trace_mask_contours

logger = logging.getLogger(__name__)

_AXIS_POSITION: dict[str, int] = {"x": 0, "y": 1, "z": 2}


@dataclass(frozen=True)
class _SilhouetteCtx:
    """Хэшируемый контекст ассета (ключ кэша вместо самого Settings)."""

    subjects_dir: str

    @classmethod
    def from_settings(cls, settings: Settings) -> "_SilhouetteCtx":
        return cls(subjects_dir=str(settings.subjects_dir))


def _load_pial(ctx: _SilhouetteCtx) -> tuple[np.ndarray, np.ndarray]:
    """Вершины и треугольники обоих полушарий ``*.pial`` одним мешем.

    Индексы правого полушария смещаются на число вершин левого — оба полушария
    участвуют в силуэте каждой плоскости (в боковой проекции они накладываются).
    """
    vertices_parts: list[np.ndarray] = []
    triangles_parts: list[np.ndarray] = []
    offset = 0
    for hemi in ("lh", "rh"):
        vertices, triangles = nib.freesurfer.read_geometry(
            os.path.join(ctx.subjects_dir, f"fsaverage/surf/{hemi}.pial")
        )
        vertices_parts.append(np.asarray(vertices, dtype=np.float64))
        triangles_parts.append(np.asarray(triangles, dtype=np.int64) + offset)
        offset += len(vertices)
    return np.concatenate(vertices_parts), np.concatenate(triangles_parts)


def _project_mask(points: np.ndarray, plane: str) -> np.ndarray:
    """Маска проекции точек на плоскость (сетка 1 мм, замыкание + заливка)."""
    horizontal, vertical = PLANE_AXES[plane]
    grid_h = axis_grid(horizontal, asset_versions.SILHOUETTE_SPACING_MM)
    grid_v = axis_grid(vertical, asset_versions.SILHOUETTE_SPACING_MM)
    mask = np.zeros((grid_h.size, grid_v.size), dtype=bool)
    columns = []
    for axis, grid in ((horizontal, grid_h), (vertical, grid_v)):
        index = np.floor(
            (points[:, _AXIS_POSITION[axis]] - grid[0]) / asset_versions.SILHOUETTE_SPACING_MM + 0.5
        ).astype(np.int64)
        columns.append((index, grid.size))
    (ix, size_h), (iy, size_v) = columns
    inside = (ix >= 0) & (ix < size_h) & (iy >= 0) & (iy < size_v)
    mask[ix[inside], iy[inside]] = True
    # Промежутки между проекциями треугольников добиваем замыканием (страховка в
    # 2 пикселя), внутренности силуэта — заливкой: контур должен быть один.
    mask = ndimage.binary_closing(mask, structure=np.ones((3, 3), dtype=bool), iterations=2)
    return ndimage.binary_fill_holes(mask)


def silhouette_hulls(
    vertices: np.ndarray,
    triangles: np.ndarray,
    plane: str,
) -> list[list[list[float]]]:
    """Контур силуэта меша на плоскости (мм MNI по осям плоскости).

    Покрытие проекции меша = точки вершин и центроиды треугольников: этого
    достаточно для маски, из которой трассируется контур.
    """
    centroids = vertices[triangles].mean(axis=1) if len(triangles) else vertices[:0]
    mask = _project_mask(np.vstack([vertices, centroids]), plane)
    horizontal, vertical = PLANE_AXES[plane]
    loops = trace_mask_contours(
        mask,
        axis_grid(horizontal, asset_versions.SILHOUETTE_SPACING_MM),
        axis_grid(vertical, asset_versions.SILHOUETTE_SPACING_MM),
        simplify_mm=asset_versions.SILHOUETTE_SIMPLIFY_MM,
    )
    return [
        [[round(float(x), 1), round(float(y), 1)] for x, y in loop]
        for loop in loops
    ]


@lru_cache(maxsize=4)
def _build(ctx: _SilhouetteCtx) -> dict[str, Any]:
    """Силуэт всех плоскостей + версия ассета (кэшируется на весь процесс)."""
    started = time.perf_counter()
    version = asset_versions.fingerprint("silhouette", ctx.subjects_dir)
    vertices, triangles = _load_pial(ctx)
    outlines = {plane: silhouette_hulls(vertices, triangles, plane) for plane in PLANES}
    logger.info(
        "Силуэт коры построен (version=%s, вершин %d, контуров %s)",
        version,
        len(vertices),
        {plane: len(hulls) for plane, hulls in outlines.items()},
    )
    journal.record(
        "asset-silhouette", "build",
        ms=(time.perf_counter() - started) * 1000.0,
        params_key=version,
        note="pial lh+rh → проекции, lru_cache",
    )
    return {"version": version, "outlines": outlines}


def outlines(settings: Settings) -> dict[str, Any]:
    """Силуэт коры всех плоскостей (мм MNI) + версия ассета — контракт роута.

    Единственное содержимое слоя «Границы мозга» (доводка 19.10.2026: растровая
    MIP-подложка убрана из слоя): контур считается из коркового меша ``*.pial``
    и потому показывает границы **мозга**, а не тома.
    """
    return _build(_SilhouetteCtx.from_settings(settings))
