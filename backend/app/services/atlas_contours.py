"""Контуры анатомических структур и полей Бродмана на MNI-срезах (срез 3.9).

Что делает
----------
* читает ``fsaverage/mri/aparc+aseg.mgz`` (анатомические структуры: кора
  Desikan-Killiany, подкорка, желудочки, ствол) и строит **объём меток на
  MNI-сетке** шага 1 мм — той же, что у срезов МРТ (``services/mri_slices.py``);
* строит **производный объёмный атлас полей Бродмана**: узлы коры
  (``mri/lh.ribbon.mgz``/``rh.ribbon.mgz``) получают метку **ближайшей вершины**
  ``label/lh|rh.PALS_B12_Brodmann.annot`` (``scipy.spatial.cKDTree``). Это
  честная производная разметка, а не измеренный атлас: поверхностные метки
  PALS живут на коре, а не «в глубине среза», поэтому в срезе их приходится
  переносить на ближайшую кору. Метод отдаётся полем ``method`` и показывается
  в UI — по тому же правилу, что метка «Быстрый режим» у расчёта диполей;
* отдаёт контуры **одного среза** вектором (мм MNI по осям плоскости) — UI
  рисует их SVG-путями и по ним же считает попадание клика.

Почему по запросу, а не «всё заранее»
-------------------------------------
Объём меток кэшируется на диске (``cache_dir/contours``) — он и есть тяжёлая
часть сборки; контур одного среза считается из массива (порядок — десятки
миллисекунд) и отдаётся с ETag, поэтому кэшируется на клиенте. Хранить готовые
контуры всех срезов трёх плоскостей незачем: это единицы мегабайт JSON ради
данных, которые в одном сеансе просмотра запрашиваются десятками срезов.

Ориентация и знаки
------------------
Точки отдаются **в осях плоскости без переворотов** (горизонталь, вертикаль —
мм MNI по возрастанию). Знаки и радиологическую раскладку применяет UI
(``PLANE_HORIZONTAL_SIGN``/``mniToNormalized``): раскладка картинки и контуров
считается одной функцией, иначе контур «уехал» бы относительно среза.
"""
import hashlib
import io
import json
import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import mne
import nibabel as nib
import numpy as np
from scipy.spatial import cKDTree

from app.core.config import Settings
from app.services.cache_store import cache_path, cache_write
from app.services.mri_slices import (
    MRI_BOUNDS,
    MRI_SPACING_MM,
    PLANE_AXES,
    PLANE_AXIS,
    axis_count,
    axis_grid,
    mri_shape,
    plane_slice_range,
    slice_index,
    slice_mm,
)
from app.utils.marching_squares import polygon_area_mm2, trace_mask_contours

logger = logging.getLogger(__name__)

# Версия пайплайна построения объёмов меток (выборка узлов, метод BA-разметки).
# Меняете шаги сборки — поднимайте число, иначе на диске подхватится старый кэш.
# 2 — разметки полушарий разведены по id (в annot обоих полушарий id совпадают).
CONTOUR_VERSION = 2

# Шаг сетки контуров: тот же, что у срезов МРТ (контур обязан совпасть с картинкой).
CONTOUR_SPACING_MM = MRI_SPACING_MM

# Файлы, по «отпечатку» которых считается версия ассета (ETag и ``?v=`` в UI).
CONTOUR_STAMP_RELATIVE = (
    "fsaverage/mri/aparc+aseg.mgz",
    "fsaverage/mri/lh.ribbon.mgz",
    "fsaverage/mri/rh.ribbon.mgz",
    "fsaverage/label/lh.PALS_B12_Brodmann.annot",
    "fsaverage/label/rh.PALS_B12_Brodmann.annot",
    "fsaverage/surf/lh.white",
    "fsaverage/surf/rh.white",
)

# Метод производной BA-разметки — уходит в ответ и в ``/meta`` (честность картинки).
BRODMANN_METHOD = "nearest_cortex_vertex"

# Упрощение контура, мм: сетка 1 мм даёт точку на пиксель, для отрисовки и
# хит-теста хватает десятых долей точности.
CONTOUR_SIMPLIFY_MM = 0.6

# Структура мельче этого на срез не рисуется: иначе «пыль» из обрезков коры,
# которые на 1 мм-срезе выглядят как случайные штрихи.
MIN_SHAPE_AREA_MM2 = 25.0

# Оси MNI в порядке массива томов (x, y, z) — как в ``mri_slices``.
_AXIS_POS: Dict[str, int] = {"x": 0, "y": 1, "z": 2}

# Смещение id полей Бродмана по полушариям: в annot обоих полушарий id лежат в
# одном диапазоне (2…67), и без смещения разметки lh и rh слились бы в одну.
_AREA_ID_OFFSET: Dict[str, int] = {"lh": 0, "rh": 10000}

# Метки, которые структурами не являются: «unknown» — неразмеченный обрезок коры,
# и показывать его в легенде как анатомию нельзя.
_EXCLUDED_STRUCTURE_MARKERS = ("unknown",)

# Доля коэффициента обратной матрицы, при которой ось MNI считается «своей» осью
# вокселей: 0.99 отбрасывает косо повёрнутые укладки (у поворота на 45° — 0.5).
_AXIS_ALIGNMENT = 0.99


@dataclass(frozen=True)
class _ContourCtx:
    """Хэшируемый контекст ассета (ключ кэша вместо самого Settings)."""

    subjects_dir: str
    cache_dir: str
    api_prefix: str

    @classmethod
    def from_settings(cls, settings: Settings) -> "_ContourCtx":
        return cls(
            subjects_dir=str(settings.subjects_dir),
            cache_dir=str(settings.cache_dir),
            api_prefix=str(settings.api_prefix),
        )


def contour_version(ctx: _ContourCtx) -> str:
    """Версия ассета: «отпечаток» файлов атласа + версия шагов сборки (ETag)."""
    digest = hashlib.sha256()
    digest.update(f"{ctx.subjects_dir}:{CONTOUR_VERSION}:{CONTOUR_SPACING_MM}".encode("utf-8"))
    for rel in CONTOUR_STAMP_RELATIVE:
        path = os.path.join(ctx.subjects_dir, rel)
        try:
            stat = os.stat(path)
            digest.update(f"{rel}:{stat.st_size}:{int(stat.st_mtime)}".encode("utf-8"))
        except OSError:
            digest.update(f"{rel}:missing".encode("utf-8"))
    return digest.hexdigest()[:16]


def asset_version(settings: Settings) -> str:
    """Версия ассета без сборки объёмов (O(1), для ``/meta`` и ссылок в ответах)."""
    return contour_version(_ContourCtx.from_settings(settings))


def _cache_path(ctx: _ContourCtx, version: str) -> str:
    return cache_path(ctx.cache_dir, "contours", f"labels-{version}.npz")


def _resample_nearest(data: np.ndarray, affine: np.ndarray) -> np.ndarray:
    """Том → MNI-сетка 1 мм: узел берёт ближайший воксель **по своей оси**.

    Тома fsaverage лежат в коронарной укладке (``L, I, A``), поэтому номер оси
    MNI и строка обратной матрицы не совпадают. Здесь это разведено честно: для
    каждой оси MNI берётся та строка матрицы, у которой коэффициент по ней
    максимален — «строка по номеру оси MNI» дала бы чужую анатомию.
    """
    inverse = np.linalg.inv(np.asarray(affine, dtype=np.float64))
    shape = data.shape
    index_by_voxel_axis: Dict[int, np.ndarray] = {}
    mni_axis_of_voxel_axis: Dict[int, str] = {}
    for position, axis in enumerate(("x", "y", "z")):
        column = np.abs(inverse[:3, position])
        total = float(column.sum())
        voxel_axis = int(np.argmax(column))
        # Осевая укладка: у оси MNI ровно одна ось вокселей, остальные —
        # пренебрежимо малы. Порог 0.99, а не 0.5: поворот на 45° даёт ровно
        # половину, и «мягкая» проверка пропустила бы косой том как осевой.
        if total <= 0 or float(column[voxel_axis]) < _AXIS_ALIGNMENT * total:
            raise ValueError(
                f"Том не выровнен по осям MNI (ось {axis}): нужна осевая укладка"
            )
        if voxel_axis in mni_axis_of_voxel_axis:
            raise ValueError(
                f"Оси MNI {mni_axis_of_voxel_axis[voxel_axis]} и {axis} ссылаются "
                "на одну ось вокселей: нужна осевая укладка"
            )
        values = axis_grid(axis, CONTOUR_SPACING_MM)
        voxels = inverse[voxel_axis, position] * values + inverse[voxel_axis, 3]
        # «Половина вверх», как в ``slice_index``: банковское округление numpy
        # дало бы другой узел на полшага и контур разъехался бы с картинкой.
        index = np.floor(voxels + 0.5).astype(np.int64)
        index_by_voxel_axis[voxel_axis] = np.clip(index, 0, shape[voxel_axis] - 1)
        mni_axis_of_voxel_axis[voxel_axis] = axis

    # Индексы применяются **к своим осям вокселей** (``np.ix_`` индексирует оси
    # массива по порядку), поэтому у коронарной укладки ``L, I, A`` результат
    # получается в порядке MNI-осей (x, z, y) — его и переставляем в (x, y, z).
    # Спутать это место легко, а выглядит «почти правильно»: структуры просто
    # меняются местами по y и z, и срез кажется правдоподобным.
    sampled = data[
        np.ix_(
            index_by_voxel_axis[0],
            index_by_voxel_axis[1],
            index_by_voxel_axis[2],
        )
    ]
    order = [mni_axis_of_voxel_axis[axis] for axis in (0, 1, 2)]
    if order == ["x", "y", "z"]:
        return sampled
    return np.transpose(sampled, [order.index(axis) for axis in ("x", "y", "z")])


@lru_cache(maxsize=1)
def _lut_names() -> Dict[int, str]:
    """``id → имя`` из FreeSurferColorLUT.txt (файл поставляется вместе с MNE)."""
    path = Path(mne.__file__).parent / "data" / "FreeSurferColorLUT.txt"
    names: Dict[int, str] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as exc:  # pragma: no cover — файл есть в любой установке MNE
        logger.warning("FreeSurferColorLUT.txt недоступен: %s", exc)
        return names
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 2:
            continue
        try:
            names[int(parts[0])] = parts[1]
        except ValueError:
            continue
    return names


# Русские подписи: UI-тексты на русском, а имена атласа — английские.
_CORTEX_RU: Dict[str, str] = {
    "superiorfrontal": "верхняя лобная извилина",
    "rostralmiddlefrontal": "ростральная средняя лобная извилина",
    "caudalmiddlefrontal": "каудальная средняя лобная извилина",
    "parsopercularis": "покрышечная часть нижней лобной извилины",
    "parstriangularis": "треугольная часть нижней лобной извилины",
    "parsorbitalis": "глазничная часть нижней лобной извилины",
    "lateralorbitofrontal": "латеральная глазничная лобная кора",
    "medialorbitofrontal": "медиальная глазничная лобная кора",
    "precentral": "прецентральная извилина",
    "paracentral": "парацентральная долька",
    "postcentral": "постцентральная извилина",
    "supramarginal": "надкраевая извилина",
    "superiorparietal": "верхняя теменная долька",
    "inferiorparietal": "нижняя теменная долька",
    "precuneus": "предклинье",
    "cuneus": "клин",
    "pericalcarine": "кора вокруг шпорной борозды",
    "lingual": "язычная извилина",
    "fusiform": "веретенообразная извилина",
    "parahippocampal": "парагиппокампальная извилина",
    "entorhinal": "энторинальная кора",
    "temporalpole": "полюс височной доли",
    "superiortemporal": "верхняя височная извилина",
    "middletemporal": "средняя височная извилина",
    "inferiortemporal": "нижняя височная извилина",
    "bankssts": "берег верхней височной борозды",
    "transversetemporal": "поперечная височная извилина",
    "insula": "островковая доля",
}

_ASEG_RU: Dict[str, str] = {
    "Left-Cerebral-White-Matter": "белое вещество (слева)",
    "Right-Cerebral-White-Matter": "белое вещество (справа)",
    "Left-Lateral-Ventricle": "боковой желудочек (слева)",
    "Right-Lateral-Ventricle": "боковой желудочек (справа)",
    "Left-Inf-Lat-Vent": "нижний рог бокового желудочка (слева)",
    "Right-Inf-Lat-Vent": "нижний рог бокового желудочка (справа)",
    "Left-Cerebellum-White-Matter": "белое вещество мозжечка (слева)",
    "Right-Cerebellum-White-Matter": "белое вещество мозжечка (справа)",
    "Left-Cerebellum-Cortex": "кора мозжечка (слева)",
    "Right-Cerebellum-Cortex": "кора мозжечка (справа)",
    "Left-Thalamus-Proper": "таламус (слева)",
    "Right-Thalamus-Proper": "таламус (справа)",
    "Left-Caudate": "хвостатое ядро (слева)",
    "Right-Caudate": "хвостатое ядро (справа)",
    "Left-Putamen": "скорлупа (слева)",
    "Right-Putamen": "скорлупа (справа)",
    "Left-Pallidum": "бледный шар (слева)",
    "Right-Pallidum": "бледный шар (справа)",
    "Left-Hippocampus": "гиппокамп (слева)",
    "Right-Hippocampus": "гиппокамп (справа)",
    "Left-Amygdala": "амигдала (слева)",
    "Right-Amygdala": "амигдала (справа)",
    "Left-Accumbens-area": "прилежащее ядро (слева)",
    "Right-Accumbens-area": "прилежащее ядро (справа)",
    "Left-VentralDC": "вентральный DC (слева)",
    "Right-VentralDC": "вентральный DC (справа)",
    "Left-choroid-plexus": "сосудистое сплетение (слева)",
    "Right-choroid-plexus": "сосудистое сплетение (справа)",
    "3rd-Ventricle": "третий желудочек",
    "4th-Ventricle": "четвёртый желудочек",
    "Brain-Stem": "ствол мозга",
    "CSF": "ликвор",
    "CC_Anterior": "передняя часть мозолистого тела",
    "CC_Mid_Anterior": "средне-передняя часть мозолистого тела",
    "CC_Central": "центральная часть мозолистого тела",
    "CC_Mid_Posterior": "средне-задняя часть мозолистого тела",
    "CC_Posterior": "задняя часть мозолистого тела",
    "Left-vessel": "сосуд (слева)",
    "Right-vessel": "сосуд (справа)",
}


def _structure_names() -> Dict[int, Tuple[str, str]]:
    """``id → (имя атласа, русская подпись)`` для меток ``aparc+aseg``.

    Незнакомая метка отдаётся английским именем LUT (или «метка N»), а не
    выдуманным переводом: подпись должна быть проверяемой.
    """
    names: Dict[int, Tuple[str, str]] = {}
    for label_id, lut_name in _lut_names().items():
        if any(marker in lut_name for marker in _EXCLUDED_STRUCTURE_MARKERS):
            continue
        if lut_name.startswith("ctx-"):
            hemisphere = "слева" if "-lh-" in lut_name else "справа"
            parcel = lut_name.split("-", 2)[-1]
            translated = _CORTEX_RU.get(parcel)
            names[label_id] = (
                lut_name,
                f"{translated} ({hemisphere})" if translated else lut_name,
            )
        else:
            names[label_id] = (lut_name, _ASEG_RU.get(lut_name, lut_name))
    return names


@dataclass(frozen=True)
class ContourVolumes:
    """Объёмы меток на MNI-сетке: анатомические структуры и поля Бродмана."""

    structures: np.ndarray
    areas: np.ndarray
    structure_names: Dict[int, str]
    structure_labels: Dict[int, str]
    area_names: Dict[int, str]
    area_labels: Dict[int, str]
    version: str
    spacing_mm: float = CONTOUR_SPACING_MM


def _area_label(area_name: str) -> str:
    """Подпись поля: «поле 17 (слева)» из имени ``BA17-lh``."""
    body, _, hemisphere = area_name.rpartition("-")
    side = "слева" if hemisphere == "lh" else "справа"
    if body.startswith("BA"):
        return f"поле {body[2:]} ({side})"
    return area_name


def _structure_volume(ctx: _ContourCtx) -> np.ndarray:
    """Метки ``aparc+aseg`` на MNI-сетке 1 мм (ближайший воксель)."""
    path = os.path.join(ctx.subjects_dir, "fsaverage/mri/aparc+aseg.mgz")
    image = nib.load(path)
    data = np.asanyarray(image.dataobj)
    return _resample_nearest(data, image.affine).astype(np.int16)


def _brodmann_volume(ctx: _ContourCtx) -> Tuple[np.ndarray, Dict[int, str]]:
    """Производная объёмная разметка полей Бродмана: ближайшая вершина коры.

    Узлы коры (``lh/rh.ribbon.mgz``) получают метку **ближайшей вершины**
    поверхности своего полушария. Это единственный способ показать поля «пятнами
    на срезе»: метки PALS живут на коре (тонкая лента), а не заполняют объём.
    Метки не-полей (``LOBE.*``, ``VISION``, ``???``) в разметку не входят: это не
    поля Бродмана, и выдавать их за них нельзя.
    """
    areas = np.zeros(mri_shape(CONTOUR_SPACING_MM), dtype=np.int16)
    names: Dict[int, str] = {}
    for hemi in ("lh", "rh"):
        ribbon = nib.load(os.path.join(ctx.subjects_dir, f"fsaverage/mri/{hemi}.ribbon.mgz"))
        ribbon_mni = _resample_nearest(np.asanyarray(ribbon.dataobj) > 0, ribbon.affine)
        index = np.argwhere(ribbon_mni)
        if index.size == 0:
            continue
        vertices, _ = nib.freesurfer.read_geometry(
            os.path.join(ctx.subjects_dir, f"fsaverage/surf/{hemi}.white")
        )
        labels, _, raw_names = nib.freesurfer.read_annot(
            os.path.join(ctx.subjects_dir, f"fsaverage/label/{hemi}.PALS_B12_Brodmann.annot")
        )
        allowed: Dict[int, str] = {}
        for position, raw in enumerate(raw_names):
            name = raw.decode("utf-8", errors="replace")
            if name.startswith("Brodmann."):
                # id меток в annot обоих полушарий **совпадают** (2…67), поэтому
                # правому полушарию даётся смещение: иначе rh перезаписывает lh,
                # а поле «BA17-rh» оказывается суммой двух полушарий.
                allowed[position + _AREA_ID_OFFSET[hemi]] = (
                    f"BA{name[len('Brodmann.'):]}-{hemi}"
                )
        if not allowed:
            continue
        tree = cKDTree(vertices)
        coordinates = np.column_stack(
            [
                axis_grid(axis, CONTOUR_SPACING_MM)[index[:, position]]
                for position, axis in enumerate(("x", "y", "z"))
            ]
        )
        _, nearest = tree.query(coordinates, workers=-1)
        values = labels[nearest].astype(np.int32) + _AREA_ID_OFFSET[hemi]
        keys = np.array(sorted(allowed), dtype=values.dtype)
        slot = np.clip(np.searchsorted(keys, values), 0, keys.size - 1)
        inside = keys[slot] == values
        selected = index[inside]
        areas[selected[:, 0], selected[:, 1], selected[:, 2]] = values[inside]
        names.update(allowed)
        logger.info(
            "Поля Бродмана (%s): %d меток, размечено узлов %d",
            hemi,
            len(allowed),
            int(inside.sum()),
        )
    return areas, names


def _read_cache(path: str) -> Optional[Tuple[np.ndarray, np.ndarray, Dict[int, str]]]:
    """Объёмы из дискового кэша (или ``None``, если кэша нет/он нечитаем)."""
    if not os.path.exists(path):
        return None
    try:
        with np.load(path, allow_pickle=False) as data:
            structures = data["structures"].astype(np.int16)
            areas = data["areas"].astype(np.int16)
            names = {
                int(key): str(name)
                for key, name in json.loads(str(data["area_names"])).items()
            }
    except (OSError, KeyError, ValueError) as exc:
        logger.warning("Кэш контуров не прочитан (%s): %s", path, exc)
        return None
    return structures, areas, names


def _write_cache(
    path: str, structures: np.ndarray, areas: np.ndarray, area_names: Dict[int, str]
) -> None:
    """Атомарная запись кэша; сбой не критичен (кэш — только оптимизация).

    Архив собирается в память: ``np.savez_compressed`` дописывает ``.npz`` к имени
    файла, если его там нет, поэтому временный файл ``*.tmp`` превратился бы в
    ``*.tmp.npz`` и ``os.replace`` не нашёл бы источник.
    """
    buffer = io.BytesIO()
    np.savez_compressed(
        buffer, structures=structures, areas=areas, area_names=json.dumps(area_names)
    )
    cache_write(path, buffer.getvalue(), label="Кэш контуров")


@lru_cache(maxsize=2)
def load_volumes(ctx: _ContourCtx) -> ContourVolumes:
    """Объёмы меток на MNI-сетке: с дискового кэша или собранные заново (лениво)."""
    version = contour_version(ctx)
    path = _cache_path(ctx, version)
    cached = _read_cache(path)
    if cached is None:
        structures = _structure_volume(ctx)
        areas, area_names = _brodmann_volume(ctx)
        _write_cache(path, structures, areas, area_names)
        logger.info(
            "Объёмы контуров построены (version=%s, структуры=dims %s)", version, structures.shape
        )
    else:
        structures, areas, area_names = cached
        logger.info("Объёмы контуров взяты из кэша (version=%s)", version)

    names = _structure_names()
    present_structures = {
        int(value) for value in np.unique(structures) if int(value) in names
    }
    return ContourVolumes(
        structures=structures,
        areas=areas,
        structure_names={key: names[key][0] for key in present_structures},
        structure_labels={key: names[key][1] for key in present_structures},
        area_names=area_names,
        area_labels={key: _area_label(name) for key, name in area_names.items()},
        version=version,
    )


def _axis_index(axis: str, mm: float, spacing_mm: float) -> Optional[int]:
    """Индекс узла сетки вдоль оси MNI: ближайший узел или ``None`` (точка вне тома).

    Округление — «половина вверх», как у ``slice_index`` срезов МРТ
    (``−3.5 → −3``): подпись структуры обязана совпадать с той анатомией, что
    нарисована на срезе, а не округляться «банковски».
    """
    value = float(mm)
    if not np.isfinite(value):
        return None
    low, _ = MRI_BOUNDS[axis]
    index = int(np.floor((value - low) / spacing_mm + 0.5))
    if index < 0 or index >= axis_count(axis, spacing_mm):
        return None
    return index


def structure_id_at(volumes: ContourVolumes, mni_mm: Sequence[float]) -> int:
    """Метка ``aparc+aseg`` в точке MNI (``0`` — метки нет или точка вне тома).

    Функция чистая: объёмы приходят аргументом, поэтому её можно проверять на
    синтетических метках (тесты) без чтения fsaverage.
    """
    if len(mni_mm) != 3:
        return 0
    indices = [
        _axis_index(axis, value, volumes.spacing_mm)
        for axis, value in zip(("x", "y", "z"), mni_mm)
    ]
    if any(index is None for index in indices):
        return 0
    x, y, z = (int(index) for index in indices)  # type: ignore[arg-type]
    return int(volumes.structures[x, y, z])


def structure_at(settings: Settings, mni_mm: Sequence[float]) -> Optional[str]:
    """Анатомическая структура по MNI-координате точки — подпись для результата.

    Тем же атласом (``aparc+aseg``), что и контуры срезов: подпись структуры в
    таблице локализации и подпись под курсором на проекциях не должны
    расходиться — это одна и та же метка объёма, прочитанная в двух местах.

    ``None`` — координат нет, метки в узле нет или атлас недоступен: отсутствие
    анатомии не должно отменять сам расчёт (в таблице будет «—»). Первое
    обращение собирает объёмы (как и первый запрос контуров), дальше они
    берутся из кэша процесса/диска.
    """
    try:
        volumes = load_volumes(_ContourCtx.from_settings(settings))
    except Exception as exc:  # noqa: BLE001 — атлас не обязателен для расчёта
        logger.info("Структура по MNI недоступна: %s", exc)
        return None

    label_id = structure_id_at(volumes, mni_mm)
    if label_id == 0:
        return None
    return volumes.structure_labels.get(label_id) or volumes.structure_names.get(label_id)


def _slice_of(volume: np.ndarray, plane: str, index: int) -> np.ndarray:
    """Срез объёма как [горизонталь, вертикаль]: нормаль — ось наведения.

    Массив хранится в порядке (x, y, z), поэтому после ``np.take`` по оси нормали
    оставшиеся оси идут по возрастанию MNI и **совпадают** с осями плоскости
    (аксиальная: x,y; сагиттальная: y,z; коронарная: x,z). Переворотов здесь нет —
    раскладку задаёт UI знаками (`PLANE_HORIZONTAL_SIGN`), иначе контур разошёлся
    бы с картинкой среза.
    """
    return np.take(volume, index, axis=_AXIS_POS[PLANE_AXIS[plane]])


def _shape_payloads(
    volume: np.ndarray,
    plane: str,
    index: int,
    names: Dict[int, str],
    labels: Dict[int, str],
) -> List[Dict[str, Any]]:
    """Контуры всех меток среза: полигоны в мм MNI + подписи, крупные — первыми."""
    values = _slice_of(volume, plane, index)
    horizontal, vertical = PLANE_AXES[plane]
    x_mm = axis_grid(horizontal, CONTOUR_SPACING_MM)
    y_mm = axis_grid(vertical, CONTOUR_SPACING_MM)

    payloads: List[Dict[str, Any]] = []
    for raw_label in np.unique(values):
        label_id = int(raw_label)
        if label_id == 0 or label_id not in names:
            continue
        loops = trace_mask_contours(
            values == raw_label, x_mm, y_mm, simplify_mm=CONTOUR_SIMPLIFY_MM
        )
        if not loops:
            continue
        areas = [polygon_area_mm2(loop) for loop in loops]
        # Порог — по главному контуру: обрезки мельче него на 1 мм-срезе выглядят
        # «пылью», а не структурой (дырки при этом остаются: они часть формы).
        if max(areas) < MIN_SHAPE_AREA_MM2:
            continue
        payloads.append(
            {
                "id": names[label_id],
                "name": names[label_id],
                "label": labels.get(label_id, names[label_id]),
                "hulls": [
                    [[round(float(x), 1), round(float(y), 1)] for x, y in loop]
                    for loop in loops
                ],
                "area_mm2": round(float(max(areas)), 1),
            }
        )
    payloads.sort(key=lambda item: item["area_mm2"], reverse=True)
    return payloads


def slice_contours(settings: Settings, plane: str, mm: float) -> Dict[str, Any]:
    """Контуры одного среза: анатомические структуры и поля Бродмана (мм MNI).

    Срез вне диапазона плоскости — ошибка (``ValueError``): UI зажимает значение
    сам, поэтому выход за границы означает расхождение контракта, а не «показать
    крайний срез».
    """
    if plane not in PLANE_AXES:
        raise ValueError(f"Неизвестная плоскость среза: {plane!r} (есть {', '.join(PLANE_AXES)})")
    low, high = plane_slice_range(plane)
    if not (float(mm) == float(mm) and low <= float(mm) <= high):
        axis = PLANE_AXIS[plane]
        raise ValueError(f"Срез {axis} = {mm} мм вне сетки (доступно {low:g}…{high:g} мм)")

    volumes = load_volumes(_ContourCtx.from_settings(settings))
    index = slice_index(plane, mm, volumes.spacing_mm)
    return {
        "version": volumes.version,
        "plane": plane,
        "axis": PLANE_AXIS[plane],
        "mm": slice_mm(plane, mm, volumes.spacing_mm),
        "spacing_mm": volumes.spacing_mm,
        "method": BRODMANN_METHOD,
        "structures": _shape_payloads(
            volumes.structures, plane, index, volumes.structure_names, volumes.structure_labels
        ),
        "areas": _shape_payloads(
            volumes.areas, plane, index, volumes.area_names, volumes.area_labels
        ),
    }


def contours_ref(settings: Settings) -> Dict[str, Any]:
    """Ссылка на контуры для ``/meta``: версия, базовый URL, шаг, метод (без сборки)."""
    return {
        "version": asset_version(settings),
        "url": f"{settings.api_prefix}/surface/contours",
        "spacing_mm": CONTOUR_SPACING_MM,
        "method": BRODMANN_METHOD,
    }


def contours_meta(settings: Settings) -> Dict[str, Any]:
    """Метаданные контуров: плоскости, шаг, метод и число доступных меток.

    Требует объёмы (собирает кэш при первом обращении) — это отдельный тяжёлый
    эндпоинт; ``/meta`` отдаёт только лёгкий ``contours_ref``.
    """
    volumes = load_volumes(_ContourCtx.from_settings(settings))
    return {
        "version": volumes.version,
        "encoding": "json-paths",
        "spacing_mm": volumes.spacing_mm,
        "simplify_mm": CONTOUR_SIMPLIFY_MM,
        "min_area_mm2": MIN_SHAPE_AREA_MM2,
        "method": BRODMANN_METHOD,
        "bounds": {
            axis: [float(low), float(high)] for axis, (low, high) in MRI_BOUNDS.items()
        },
        "planes": {
            plane: {
                "axis": PLANE_AXIS[plane],
                "range_mm": [float(value) for value in plane_slice_range(plane)],
                "count": axis_count(PLANE_AXIS[plane], volumes.spacing_mm),
            }
            for plane in PLANE_AXES
        },
        "n_structures": len(volumes.structure_names),
        "n_areas": len(volumes.area_names),
        "url": f"{settings.api_prefix}/surface/contours",
    }


def clear_contour_cache() -> None:
    """Сбрасывает in-memory кэш объёмов (используется в тестах)."""
    load_volumes.cache_clear()


def cache_file(settings: Settings) -> str:
    """Путь дискового кэша объёмов для текущей версии ассета (скрипты и тесты)."""
    ctx = _ContourCtx.from_settings(settings)
    return _cache_path(ctx, contour_version(ctx))
