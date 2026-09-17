"""Срезы МРТ fsaverage для проекций раздела «Диполи» (срез 3.2 UI).

Что делает
----------
* читает том ``fsaverage/mri/T1.mgz`` (1 мм) и маску мозга ``brainmask.mgz``;
* приводит их к **MNI-выровненной сетке** с шагом 1 мм: яркость 0…255 внутри
  маски, прозрачность 0 вне неё (снаружи мозга не рисуем — фон фигуры виден);
* кэширует том на диске (``settings.cache_dir/mri``) и держит в памяти, поэтому
  срез собирается из массива без повторного чтения mgz;
* отдаёт срез **PNG** (серый + альфа, ``app/utils/png.py``) с ETag: браузер
  кэширует картинку по URL, а SVG-проекция рисует её как ``<image href>``.

Ориентация
----------
Раскладка картинки совпадает с геометрией UI
(``frontend/src/shared/lib/mriProjections.ts``): столбец 0 — левый край фигуры,
строка 0 — верхний край, а знаки осей и границы продублированы здесь осознанно
(числа описывают реальный том). Совпадение TS-констант и этих — предмет теста
``tests/test_mri_slices.py::test_geometry_matches_frontend``.

Почему MNI-сетка, а не воксели тома
-----------------------------------
``fsaverage`` совмещён с MNI305 (``talairach.xfm`` — единичная матрица), поэтому
«мм MNI» и «мм RAS» — одно и то же, и сетка среза совпадает с координатами
диполей и срезов UI. На воксельной сетке каждый клик требовал бы пересчёта.
"""
import io
import json
import logging
import os
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, cast

import numpy as np

from app.core.config import Settings
from app.services import asset_versions, journal
from app.services.asset_versions import (
    MRI_BOUNDS,
    MRI_GRID_VERSION,
    MRI_SPACING_MM,
    MRI_STAMP_RELATIVE,
    MRI_WINDOW_PERCENTILES,
)
from app.services.cache_store import cache_path, cache_write
from app.utils.png import encode_png_gray8

logger = logging.getLogger(__name__)

# Входы ассета (номер сборки ``MRI_GRID_VERSION``, шаг и границы MNI-сетки, окно
# интенсивности, файлы тома) объявлены в ``services/asset_versions.py``: оттуда
# считается версия для ETag/имени файла кэша. Меняете шаги сборки — поднимайте
# номер **там**, иначе на диске подмешается старый кэш (A7, этап 6).

# Ось MNI, по которой наводится срез, и оси видимой плоскости: [горизонталь,
# вертикаль]. Порядок и знаки — как в UI, иначе картинка окажется зеркальной.

PLANE_AXIS: dict[str, str] = {"axial": "z", "sagittal": "x", "coronal": "y"}
PLANE_AXES: dict[str, tuple[str, str]] = {
    "axial": ("x", "y"),
    "sagittal": ("y", "z"),
    "coronal": ("x", "z"),
}
PLANE_HORIZONTAL_SIGN: dict[str, int] = {"axial": -1, "sagittal": 1, "coronal": -1}
PLANE_VERTICAL_SIGN: dict[str, int] = {"axial": 1, "sagittal": 1, "coronal": 1}
PLANES: tuple[str, ...] = ("axial", "sagittal", "coronal")

# Позиция оси MNI в массиве тома: том хранится в порядке x, y, z (по возрастанию
# MNI), поэтому «воксельная» раскладка fsaverage здесь уже не видна.
_AXIS_POS: dict[str, int] = {"x": 0, "y": 1, "z": 2}


def axis_count(axis: str, spacing_mm: float = MRI_SPACING_MM) -> int:
    """Число узлов сетки вдоль оси (границы включительно)."""
    low, high = MRI_BOUNDS[axis]
    return round((high - low) / spacing_mm) + 1


def axis_grid(axis: str, spacing_mm: float = MRI_SPACING_MM) -> np.ndarray:
    """Значения MNI (мм) вдоль оси: от минимума к максимуму."""
    low, _ = MRI_BOUNDS[axis]
    return low + np.arange(axis_count(axis, spacing_mm), dtype=np.float64) * spacing_mm


def mri_shape(spacing_mm: float = MRI_SPACING_MM) -> tuple[int, int, int]:
    """Форма тома на сетке: (x, y, z)."""
    counts = [axis_count(axis, spacing_mm) for axis in ("x", "y", "z")]
    return counts[0], counts[1], counts[2]


def plane_columns_mni(plane: str, spacing_mm: float = MRI_SPACING_MM) -> np.ndarray:
    """MNI (мм) центров столбцов картинки: столбец 0 — левый край фигуры.

    Связь с UI: ``u = −1`` (левый край) даёт ``mm = center − sign·half``, поэтому
    при ``sign = −1`` (аксиальная и коронарная проекции) слева оказывается
    максимум оси x — правое полушарие, как в радиологической раскладке.
    """
    axis = PLANE_AXES[plane][0]
    low, high = MRI_BOUNDS[axis]
    center, half = (low + high) / 2, (high - low) / 2
    sign = PLANE_HORIZONTAL_SIGN[plane]
    return np.linspace(center - sign * half, center + sign * half, axis_count(axis, spacing_mm))


def plane_rows_mni(plane: str, spacing_mm: float = MRI_SPACING_MM) -> np.ndarray:
    """MNI (мм) центров строк картинки: строка 0 — верхний край фигуры.

    ``v = +1`` (верх) даёт ``mm = center + sign·half``; при ``sign = +1`` сверху
    максимум вертикальной оси (вверх зрительно = вверх MNI, вперёд для аксиальной).
    """
    axis = PLANE_AXES[plane][1]
    low, high = MRI_BOUNDS[axis]
    center, half = (low + high) / 2, (high - low) / 2
    sign = PLANE_VERTICAL_SIGN[plane]
    return np.linspace(center + sign * half, center - sign * half, axis_count(axis, spacing_mm))


def slice_index(plane: str, mm: float, spacing_mm: float = MRI_SPACING_MM) -> int:
    """Индекс среза на сетке: ближайший узел (округление «половина вверх»).

    Срезы в UI дробные (клик даёт 0.1 мм), а том — сетка 1 мм, поэтому значение
    квантуется. Округление вверх, а не «банковское»: предсказуемо для
    отрицательных значений (``−3.5 → −3``).
    """
    low, high = MRI_BOUNDS[PLANE_AXIS[plane]]
    bounded = float(mm) if np.isfinite(mm) else 0.0
    bounded = min(high, max(low, bounded))
    index = int(np.floor((bounded - low) / spacing_mm + 0.5))
    return min(axis_count(PLANE_AXIS[plane], spacing_mm) - 1, max(0, index))


def slice_mm(plane: str, mm: float, spacing_mm: float = MRI_SPACING_MM) -> float:
    """Фактическое значение среза после квантования сеткой (мм)."""
    low, _ = MRI_BOUNDS[PLANE_AXIS[plane]]
    return float(low + slice_index(plane, mm, spacing_mm) * spacing_mm)


def plane_slice_range(plane: str) -> tuple[float, float]:
    """Диапазон значений среза плоскости (границы сетки)."""
    return MRI_BOUNDS[PLANE_AXIS[plane]]


def slice_corners_mni(plane: str, mm: float) -> tuple[dict[str, float], dict[str, float]]:
    """MNI-координаты углов картинки среза: (верхний левый, нижний правый).

    Функция чистая (том не нужен) — по ней проверяется, что столбец 0 картинки
    действительно левый край фигуры, а строка 0 — верхний.
    """
    horizontal, vertical = PLANE_AXES[plane]
    cols, rows = plane_columns_mni(plane), plane_rows_mni(plane)

    def point(column: float, row: float) -> dict[str, float]:
        coords = {horizontal: float(column), vertical: float(row)}
        coords[PLANE_AXIS[plane]] = slice_mm(plane, mm)
        return {axis: coords[axis] for axis in ("x", "y", "z")}

    return point(cols[0], rows[0]), point(cols[-1], rows[-1])


@dataclass(frozen=True)
class MriVolume:
    """Том на MNI-сетке: яркость и прозрачность (uint8) + паспорт сборки.

    Массив хранится в порядке (x, y, z) по возрастанию MNI: так срез плоскости
    берётся одним ``np.take`` по оси нормали, а перевороты сведены к двум
    представлениям-срезам (см. :meth:`slice`).
    """

    gray: np.ndarray
    alpha: np.ndarray
    version: str
    spacing_mm: float = MRI_SPACING_MM
    window: tuple[float, float] = (0.0, 0.0)

    def slice(self, plane: str, index: int) -> tuple[np.ndarray, np.ndarray]:
        """Срез как (яркость, альфа) формы (строки, столбцы) в раскладке UI.

        Столбцы — горизонтальная ось плоскости, строки — вертикальная,
        ``[0, 0]`` — верхний левый угол фигуры. Переворот задан знаками
        ``PLANE_*_SIGN``: вертикальная ось в массиве растёт по MNI, а на экране
        верх — максимум, поэтому строки переворачиваются всегда; столбцы — только
        там, где горизонтальный знак отрицателен.
        """
        normal_pos = _AXIS_POS[PLANE_AXIS[plane]]
        gray = np.transpose(np.take(self.gray, index, axis=normal_pos))
        alpha = np.transpose(np.take(self.alpha, index, axis=normal_pos))
        if PLANE_VERTICAL_SIGN[plane] == 1:
            gray, alpha = gray[::-1], alpha[::-1]
        if PLANE_HORIZONTAL_SIGN[plane] == -1:
            gray, alpha = gray[:, ::-1], alpha[:, ::-1]
        return gray.copy(), alpha.copy()

    def slice_png(self, plane: str, mm: float) -> tuple[bytes, float]:
        """PNG среза + фактическое (квантованное) значение среза в мм."""
        actual_mm = slice_mm(plane, mm, self.spacing_mm)
        index = slice_index(plane, mm, self.spacing_mm)
        gray, alpha = self.slice(plane, index)
        return encode_png_gray8(gray, alpha), actual_mm


@dataclass(frozen=True)
class _MriCtx:
    """Хэшируемый контекст ассета (ключ кэша вместо самого Settings)."""

    subjects_dir: str
    cache_dir: str
    api_prefix: str

    @classmethod
    def from_settings(cls, settings: Settings) -> "_MriCtx":
        return cls(
            subjects_dir=str(settings.subjects_dir),
            cache_dir=str(settings.cache_dir),
            api_prefix=str(settings.api_prefix),
        )


def mri_version(ctx: _MriCtx) -> str:
    """Версия ассета по «отпечатку» входов (ETag/имя файла кэша, A7)."""
    return asset_versions.fingerprint("mri", ctx.subjects_dir)



def _cache_paths(ctx: _MriCtx, version: str) -> tuple[str, str]:
    """Пути кэша тома: (массив npz, паспорт сборки json)."""
    return (
        cache_path(ctx.cache_dir, "mri", f"volume-{version}.npz"),
        cache_path(ctx.cache_dir, "mri", f"volume-{version}.json"),
    )


def _read_volume_cache(paths: tuple[str, str]) -> MriVolume | None:
    """Том из дискового кэша; ``None`` — если кэша нет или он от другой сборки."""
    npz_path, meta_path = paths
    try:
        with open(meta_path, encoding="utf-8") as fh:
            meta: dict[str, Any] = json.load(fh)
        with np.load(npz_path) as data:
            gray, alpha = data["gray"], data["alpha"]
    except (OSError, KeyError, ValueError, EOFError):
        return None
    if meta.get("grid_version") != MRI_GRID_VERSION or tuple(gray.shape) != mri_shape():
        logger.warning("Кэш тома МРТ не совпал по версии сетки или форме — пересобираю")
        return None
    window = [float(value) for value in meta.get("intensity_window", [0.0, 0.0])]
    return MriVolume(
        gray=gray,
        alpha=alpha,
        version=str(meta.get("version", "")),
        spacing_mm=float(meta.get("spacing_mm", MRI_SPACING_MM)),
        window=(window[0], window[1]),
    )


def _write_volume_cache(paths: tuple[str, str], volume: MriVolume) -> None:
    """Атомарная запись кэша; сбой не критичен (кэш — только оптимизация).

    Архив собирается в память: ``np.savez_compressed`` дописывает ``.npz`` к
    имени файла, если его там нет, поэтому временный файл ``*.tmp`` превратился
    бы в ``*.tmp.npz`` и ``os.replace`` не нашёл бы источник.
    """
    npz_path, meta_path = paths
    meta = {
        "version": volume.version,
        "grid_version": MRI_GRID_VERSION,
        "spacing_mm": volume.spacing_mm,
        "shape": list(volume.gray.shape),
        "bounds": {axis: list(value) for axis, value in MRI_BOUNDS.items()},
        "intensity_window": [volume.window[0], volume.window[1]],
    }
    buffer = io.BytesIO()
    np.savez_compressed(buffer, gray=volume.gray, alpha=volume.alpha)
    cache_write(npz_path, buffer.getvalue(), label="Кэш тома МРТ")
    cache_write(meta_path, json.dumps(meta).encode("utf-8"), label="Кэш тома МРТ (паспорт)")


def _voxel_axis_of(affine: np.ndarray) -> dict[str, int]:
    """Ось MNI → ось вокселей тома. Косые матрицы не поддерживаем осознанно.

    Строка обратной матрицы — это **ось вокселей** (её уравнение даёт индекс), а
    столбец с наибольшим весом в строке — ось MNI, от которой этот индекс зависит.
    Совпадают они только у диагональной матрицы (``orig.mgz``, укладка RAS); у
    ``T1.mgz`` fsaverage укладка **коронарная** (``L, I, A``), поэтому строки
    переставлены: брать «строку по номеру оси MNI» нельзя — оси y и z обменяются
    местами, и срез покажет не ту анатомию (см. ``voxel_indices``).
    """
    linear = np.linalg.inv(affine)[:3, :3]
    result: dict[str, int] = {}
    for voxel_axis in range(3):
        weights = np.abs(linear[voxel_axis])
        mni_axis = int(np.argmax(weights))
        rest = float(np.max(np.delete(weights, mni_axis)))
        if weights[mni_axis] <= 0 or rest > 1e-3 * float(weights[mni_axis]):
            raise ValueError(
                "Том МРТ не выровнен по осям MNI: срезы в осях координат диполей "
                "требуют аксиальной матрицы (fsaverage подходит)"
            )
        axis = ("x", "y", "z")[mni_axis]
        if axis in result:
            raise ValueError(
                f"Две оси вокселей зависят от одной оси MNI ({axis}): матрица тома вырождена"
            )
        result[axis] = voxel_axis
    return result


def voxel_indices(affine: np.ndarray, shape: tuple[int, ...]) -> list[np.ndarray]:
    """Индексы вокселей тома для узлов MNI-сетки — списком **по осям вокселей**.

    Каждая ось вокселей берёт уравнение (строку обратной матрицы) именно у своей
    оси MNI из ``_voxel_axis_of``: у коронарно уложенного ``T1.mgz`` номер строки
    и номер оси MNI не совпадают, и подстановка «по номеру» отдаёт вместо среза
    анатомически бессмысленную картинку. Узел сетки берётся ближайшим вокселем и
    зажимается в границы тома — результат готов для ``np.ix_``.
    """
    inverse = np.linalg.inv(affine)
    axis_of_voxel = {voxel_axis: axis for axis, voxel_axis in _voxel_axis_of(affine).items()}
    indices: list[np.ndarray] = []
    for voxel_axis in range(3):
        axis = axis_of_voxel[voxel_axis]
        mni_index = ("x", "y", "z").index(axis)
        voxels = np.rint(
            inverse[voxel_axis, mni_index] * axis_grid(axis) + inverse[voxel_axis, 3]
        )
        indices.append(np.clip(voxels.astype(int), 0, int(shape[voxel_axis]) - 1))
    return indices


def _mni_order(voxel_axis_of: dict[str, int]) -> tuple[int, int, int]:
    """Перестановка осей сэмплированного массива (воксельные) в порядок MNI."""
    order = [0, 0, 0]
    for index, axis in enumerate(("x", "y", "z")):
        order[voxel_axis_of[axis]] = index
    return order[0], order[1], order[2]


def _build_volume(ctx: _MriCtx, version: str) -> MriVolume:
    """Собирает том на MNI-сетке из ``T1.mgz`` + ``brainmask.mgz`` (nibabel)."""
    import nibabel as nib  # локальный импорт: нужен только этому сервису

    t1_path = os.path.join(ctx.subjects_dir, MRI_STAMP_RELATIVE[0])
    mask_path = os.path.join(ctx.subjects_dir, MRI_STAMP_RELATIVE[1])
    if not (os.path.exists(t1_path) and os.path.exists(mask_path)):
        raise FileNotFoundError(f"Нет тома МРТ fsaverage: {t1_path}")
    # ``nib.load`` возвращает базовый ``FileBasedImage``: у mgz-томов fsaverage
    # (T1/brainmask/aparc+aseg) это ``MGHImage`` с shape/affine/dataobj —
    # сужаем тип явно, чтобы проверка типов видела реальные атрибуты.
    t1_image = cast("nib.MGHImage", nib.load(t1_path))
    mask_image = cast("nib.MGHImage", nib.load(mask_path))
    if tuple(mask_image.shape) != tuple(t1_image.shape):
        raise ValueError("T1 и brainmask разошлись по форме — данные fsaverage повреждены")

    affine = np.asarray(t1_image.affine, dtype=float)
    voxel_axis_of = _voxel_axis_of(affine)

    # Сетка MNI → индексы вокселей по каждой оси вокселей (узел берётся ближайшим)
    sampling = np.ix_(*voxel_indices(affine, t1_image.shape))
    order = _mni_order(voxel_axis_of)

    values = np.asarray(np.asanyarray(t1_image.dataobj)[sampling], dtype=np.float32).transpose(order)
    inside = np.asanyarray(mask_image.dataobj)[sampling].transpose(order) > 0
    if not bool(inside.any()):
        raise ValueError("Маска мозга fsaverage пуста — срезы МРТ построить нельзя")

    low, high = (float(value) for value in np.percentile(values[inside], MRI_WINDOW_PERCENTILES))
    span = (high - low) or 1.0
    gray = np.where(inside, np.clip((values - low) / span, 0.0, 1.0) * 255.0, 0.0)
    alpha = np.where(inside, 255, 0)
    logger.info(
        "Том МРТ построен (version=%s, %dx%dx%d, окно %.1f…%.1f)",
        version, gray.shape[0], gray.shape[1], gray.shape[2], low, high,
    )
    return MriVolume(
        gray=gray.astype(np.uint8),
        alpha=alpha.astype(np.uint8),
        version=version,
        spacing_mm=MRI_SPACING_MM,
        window=(low, high),
    )


@lru_cache(maxsize=2)
def load_volume(ctx: _MriCtx) -> MriVolume:
    """Том на MNI-сетке: с дискового кэша или собранный заново (лениво, один раз)."""
    started = time.perf_counter()
    version = mri_version(ctx)
    paths = _cache_paths(ctx, version)
    cached = _read_volume_cache(paths)
    if cached is not None:
        logger.info("Том МРТ взят из кэша (version=%s)", version)
        journal.record(
            "asset-mri", "cache_read",
            ms=(time.perf_counter() - started) * 1000.0,
            params_key=version, cache_hit=True,
            bytes_out=int(cached.gray.nbytes + cached.alpha.nbytes), note="том на MNI-сетке",
        )
        return cached
    volume = _build_volume(ctx, version)
    _write_volume_cache(paths, volume)
    journal.record(
        "asset-mri", "build",
        ms=(time.perf_counter() - started) * 1000.0,
        params_key=version, cache_hit=False,
        bytes_out=int(volume.gray.nbytes + volume.alpha.nbytes), note="source=T1.mgz",
    )
    return volume


def asset_version(settings: Settings) -> str:
    """Версия ассета без построения тома (O(1), для ``/meta`` и ссылок в ответах)."""
    return mri_version(_MriCtx.from_settings(settings))


def slice_png(settings: Settings, plane: str, mm: float) -> tuple[bytes, str, float]:
    """PNG среза + версия ассета + фактическое (квантованное сеткой) значение среза.

    Срез вне диапазона плоскости — ошибка (``ValueError``): UI зажимает значение
    сам, поэтому выход за границы означает расхождение контракта, а не «показать
    крайний срез». Внутри диапазона значение квантуется сеткой тома.
    """
    if plane not in PLANES:
        raise ValueError(f"Неизвестная плоскость среза: {plane!r} (есть {', '.join(PLANES)})")
    low, high = plane_slice_range(plane)
    if not (float(mm) == float(mm) and low <= float(mm) <= high):
        axis = PLANE_AXIS[plane]
        raise ValueError(f"Срез {axis} = {mm} мм вне тома (доступно {low:g}…{high:g} мм)")
    volume = load_volume(_MriCtx.from_settings(settings))
    data, actual_mm = volume.slice_png(plane, mm)
    return data, volume.version, actual_mm


def slice_ref(settings: Settings) -> dict[str, Any]:
    """Ссылка на срезы для ``/meta``: версия, базовый URL, шаг сетки (без тома)."""
    return {
        "version": asset_version(settings),
        "slice_url": f"{settings.api_prefix}/surface/mri/slice",
        "spacing_mm": MRI_SPACING_MM,
    }


def mri_meta(settings: Settings) -> dict[str, Any]:
    """Метаданные срезов: границы, шаг сетки, плоскости и окно интенсивности.

    Требует том (собирает кэш при первом обращении) — это отдельный тяжёлый
    эндпоинт; ``/meta`` отдаёт только лёгкий ``slice_ref``.
    """
    ctx = _MriCtx.from_settings(settings)
    volume = load_volume(ctx)
    return {
        "version": volume.version,
        "encoding": "png-gray8-alpha",
        "spacing_mm": volume.spacing_mm,
        "bounds": {
            axis: [float(low), float(high)] for axis, (low, high) in MRI_BOUNDS.items()
        },
        "intensity_window": [float(volume.window[0]), float(volume.window[1])],
        "planes": {
            plane: {
                "axis": PLANE_AXIS[plane],
                "range_mm": [float(value) for value in plane_slice_range(plane)],
                "count": axis_count(PLANE_AXIS[plane], volume.spacing_mm),
            }
            for plane in PLANES
        },
        "slice_url": f"{ctx.api_prefix}/surface/mri/slice",
    }


def clear_slice_cache() -> None:
    """Сбрасывает in-memory кэш тома (используется в тестах)."""
    load_volume.cache_clear()