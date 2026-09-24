"""Тесты контуров атласа: изолинии, выборка осей, подписи, кэш и роуты.

Быстрая часть не требует fsaverage: изолинии проверяются синтетическими масками
(квадрат, кольцо с дыркой), выборка узлов — синтетическим томом **с коронарной
укладкой** ``T1.mgz`` (у него номер оси MNI и ось вокселей не совпадают — самая
дорогая ошибка здесь выглядит как «структуры поменялись местами по y и z»),
подписи — таблицами LUT, кэш — каталогом tmp, роуты — подменёнными функциями
сервиса. Реальные ``aparc+aseg``/``PALS_B12_Brodmann`` проверяются тестами с
маркером ``integration``.
"""
import os
from pathlib import Path

import numpy as np
import pytest

from app.api import routes
from app.core.config import settings
from app.services import atlas_contours as ac
from app.services import mri_slices as ms
from app.services.asset_versions import CONTOUR_STAMP_RELATIVE
from app.utils.marching_squares import (
    polygon_area_mm2,
    simplify_polyline,
    trace_mask_contours,
)

_PREFIX = settings.api_prefix

# Укладка томов fsaverage (``mri/T1.mgz``, ``aparc+aseg.mgz``): коронарная, L, I, A.
_CORONAL_AFFINE = np.array(
    [
        [-1.0, 0.0, 0.0, 128.0],
        [0.0, 0.0, 1.0, -128.0],
        [0.0, -1.0, 0.0, 128.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
)


def _axis_index(axis: str, mm: float) -> int:
    """Индекс узла MNI-сетки для значения в мм (обратная к ``axis_grid``)."""
    low, _ = ms.MRI_BOUNDS[axis]
    return round((mm - low) / ms.MRI_SPACING_MM)


def _ramp_coronal_volume(scale: int = 4, shape: tuple[int, int, int] = (64, 64, 64)):
    """Том-«линейка» с укладкой fsaverage: значение кодирует номер вокселя.

    Оси вокселей и оси MNI не совпадают, а шаг крупный (``scale`` мм), поэтому
    подмена осей видна как другое число: одна и та же точка узнаётся по тройке
    (i, j, k), а не «примерно там же».
    """
    affine = np.array(
        [
            [-scale, 0.0, 0.0, 128.0],
            [0.0, 0.0, scale, -128.0],
            [0.0, -scale, 0.0, 128.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )
    voxel_i = np.arange(shape[0])[:, None, None]
    voxel_j = np.arange(shape[1])[None, :, None]
    voxel_k = np.arange(shape[2])[None, None, :]
    data = (voxel_i * 10_000 + voxel_j * 100 + voxel_k).astype(np.int32)
    return data, affine


def test_marching_squares_square_area_and_bbox():
    """Квадрат маски даёт один замкнутый контур между узлами (на полшага)."""
    mask = np.zeros((10, 10), dtype=bool)
    mask[2:6, 3:7] = True
    loops = trace_mask_contours(mask, np.arange(10.0), np.arange(10.0), simplify_mm=0.0)
    assert len(loops) == 1
    points = np.asarray(loops[0])
    # Маска занимает сэмплы 2…5 по первой оси и 3…6 по второй, контур — на полшага.
    assert (points[:, 0].min(), points[:, 0].max()) == (1.5, 5.5)
    assert (points[:, 1].min(), points[:, 1].max()) == (2.5, 6.5)
    # Углы срезаны на полклетки: площадь чуть меньше 4×4 мм².
    assert 15.0 < polygon_area_mm2(loops[0]) <= 16.0


def test_marching_squares_ring_keeps_hole_as_own_polygon():
    """Кольцо (структура с полостью) отдаёт два полигона: внешний контур и дырку."""
    ring = np.zeros((12, 12), dtype=bool)
    ring[1:11, 1:11] = True
    ring[4:8, 4:8] = False
    loops = trace_mask_contours(ring, np.arange(12.0), np.arange(12.0), simplify_mm=0.0)
    assert len(loops) == 2
    areas = sorted(polygon_area_mm2(loop) for loop in loops)
    assert areas[0] < 20.0 < 90.0 < areas[1]
    hole = min(loops, key=polygon_area_mm2)
    points = np.asarray(hole)
    assert points.min() >= 3.5 and points.max() <= 7.7


def test_marching_squares_empty_and_validation():
    """Пустая маска — пустой список; размерности маски и осей обязаны сойтись."""
    assert trace_mask_contours(np.zeros((5, 5), bool), np.arange(5.0), np.arange(5.0)) == []
    with pytest.raises(ValueError):
        trace_mask_contours(np.zeros((3, 3, 3), bool), np.arange(3.0), np.arange(3.0))
    with pytest.raises(ValueError):
        trace_mask_contours(np.zeros((3, 4), bool), np.arange(3.0), np.arange(3.0))


def test_simplify_polyline_keeps_shape_within_tolerance():
    """Упрощение убирает «дрожание» линии, но не углы."""
    smooth = [(0.0, 0.0), (1.0, 0.05), (2.0, 0.05), (3.0, 0.0), (4.0, 0.0), (4.0, 1.0), (0.0, 1.0)]
    assert simplify_polyline(smooth, 0.6) == [(0.0, 0.0), (4.0, 0.0), (4.0, 1.0), (0.0, 1.0)]
    ring = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0)]
    assert simplify_polyline(ring, 0.5) == ring


def test_resample_nearest_keeps_mni_axes():
    """Узел MNI-сетки берёт воксель **своей** оси даже при коронарной укладке.

    Точка MNI (x, y, z) в такой укладке лежит в вокселе (i, j, k) =
    ((128−x)/4, (128−z)/4, (y+128)/4) — y и z меняются местами. Если оси
    перепутать, том соберётся «почти правильно» и срезы будут выглядеть
    правдоподобно, поэтому проверяется точное значение маркера, а не «непусто».
    """
    data, affine = _ramp_coronal_volume()
    sampled = ac._resample_nearest(data, affine)
    assert sampled.shape == ms.mri_shape()

    # Точка MNI (0, 0, 0): i = 32, j = 32, k = 32.
    assert sampled[_axis_index("x", 0.0), _axis_index("y", 0.0), _axis_index("z", 0.0)] == (
        32 * 10_000 + 32 * 100 + 32
    )
    # Несимметричная точка MNI (−40, 0, 20): i = 42, j = 27, k = 32.
    # При перепутанных осях значение было бы другим (i=32, j=27, k=42).
    assert sampled[
        _axis_index("x", -40.0), _axis_index("y", 0.0), _axis_index("z", 20.0)
    ] == 42 * 10_000 + 27 * 100 + 32


def test_resample_nearest_rejects_oblique_affine():
    """Повёрнутый том не «раскладывается» по осям: ошибка вместо тихой подмены."""
    oblique = np.array(
        [
            [0.7, -0.7, 0.0, 128.0],
            [0.7, 0.7, 0.0, -128.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]
    )
    with pytest.raises(ValueError, match="не выровнен"):
        ac._resample_nearest(np.zeros((8, 8, 8), np.int16), oblique)


def test_coronal_affine_swaps_y_and_z_voxel_axes():
    """Та же укладка, что у ``T1.mgz``: x → ось 0, z → ось 1, y → ось 2.

    Тест фиксирует укладку, из-за которой появился перенос осей: если fsaverage
    перестанет быть коронарным, это увидят сразу, а не «срез не той анатомии».
    """
    inverse = np.linalg.inv(_CORONAL_AFFINE)
    axes = {
        axis: int(np.argmax(np.abs(inverse[:3, position])))
        for position, axis in enumerate(("x", "y", "z"))
    }
    assert axes == {"x": 0, "y": 2, "z": 1}


def test_structure_names_translate_cortex_and_aseg():
    """Подписи структур: русские для известных меток, имя атласа — для прочих."""
    lut = ac._lut_names()
    names = ac._structure_names()
    by_lut = {name: label for name, label in names.values()}

    assert by_lut["ctx-lh-precentral"] == "прецентральная извилина (слева)"
    assert by_lut["ctx-rh-precentral"] == "прецентральная извилина (справа)"
    assert by_lut["Left-Thalamus-Proper"] == "таламус (слева)"
    assert by_lut["Brain-Stem"] == "ствол мозга"
    # Метки без перевода отдаются английским именем LUT, а не выдумкой.
    untranslated = [name for name, label in names.values() if label == name]
    assert untranslated, "ожидались метки без перевода (fallback на имя атласа)"
    assert all(name in lut.values() for name in untranslated)
    # «unknown» — неразмеченный обрезок коры, а не структура: в атлас не входит.
    assert not any("unknown" in name for name in by_lut)


def test_area_label_reads_hemisphere_from_name():
    """Подпись поля: «поле 17 (слева)» — полушарие берётся из суффикса имени."""
    assert ac._area_label("BA17-lh") == "поле 17 (слева)"
    assert ac._area_label("BA44-rh") == "поле 44 (справа)"
    assert ac._area_label("без-суффикса") == "без-суффикса"


def test_shape_payloads_drop_small_labels_and_sort_by_area():
    """Срез: мелкие обрезки отсеиваются порогом, крупные идут первыми."""
    volume = np.zeros(ms.mri_shape(), np.int16)
    plane_index = _axis_index("z", 0.0)
    volume[
        _axis_index("x", -5.0):_axis_index("x", 5.0),
        _axis_index("y", -5.0):_axis_index("y", 5.0),
        plane_index,
    ] = 5
    volume[
        _axis_index("x", -60.0):_axis_index("x", -56.0),
        _axis_index("y", 60.0):_axis_index("y", 64.0),
        plane_index,
    ] = 6

    payloads = ac._shape_payloads(
        volume, "axial", plane_index, {5: "big", 6: "small"}, {5: "большая", 6: "мелкая"}
    )
    assert [item["id"] for item in payloads] == ["big"], "мелкая метка должна быть отсеяна"
    assert payloads[0]["label"] == "большая"
    assert payloads[0]["area_mm2"] >= ac.MIN_SHAPE_AREA_MM2
    # Точки округлены до десятых: JSON среза не должен нести дробную пыль.
    for hull in payloads[0]["hulls"]:
        for x, y in hull:
            assert round(x, 1) == x and round(y, 1) == y


def test_slice_of_takes_plane_axes_without_flips():
    """Срез — [горизонталь, вертикаль] плоскости, без переворотов и знаков.

    Раскладку (радиологические знаки осей) задаёт UI: если сервер начнёт сам
    переворачивать оси, контур разойдётся с картинкой среза — тест это ловит.
    """
    volume = np.zeros(ms.mri_shape(), np.int16)
    volume[_axis_index("x", 20.0), _axis_index("y", -40.0), _axis_index("z", 30.0)] = 7

    axial = ac._slice_of(volume, "axial", _axis_index("z", 30.0))
    assert axial[_axis_index("x", 20.0), _axis_index("y", -40.0)] == 7
    sagittal = ac._slice_of(volume, "sagittal", _axis_index("x", 20.0))
    assert sagittal[_axis_index("y", -40.0), _axis_index("z", 30.0)] == 7
    coronal = ac._slice_of(volume, "coronal", _axis_index("y", -40.0))
    assert coronal[_axis_index("x", 20.0), _axis_index("z", 30.0)] == 7


def test_slice_contours_validates_before_building():
    """Плоскость и диапазон среза проверяются до сборки объёмов (fsaverage не нужен)."""
    with pytest.raises(ValueError, match="Неизвестная плоскость"):
        ac.slice_contours(settings, "oblique", 0.0)
    with pytest.raises(ValueError, match="вне сетки"):
        ac.slice_contours(settings, "axial", 999.0)
    with pytest.raises(ValueError, match="вне сетки"):
        ac.slice_contours(settings, "axial", float("nan"))


def test_cache_roundtrip_and_broken_file(tmp_path):
    """Кэш объёмов переживает запись/чтение, а битый файл — не исключение, а ``None``."""
    ctx = ac._ContourCtx(subjects_dir="/нет", cache_dir=str(tmp_path), api_prefix=_PREFIX)
    path = ac._cache_path(ctx, "testver")
    assert ac._read_cache(path) is None

    structures = np.zeros((4, 5, 6), np.int16)
    structures[1, 2, 3] = 7
    areas = np.zeros((4, 5, 6), np.int16)
    areas[0, 0, 0] = 10001
    ac._write_cache(path, structures, areas, {10001: "BA1-lh"})

    cached = ac._read_cache(path)
    assert cached is not None
    assert np.array_equal(cached[0], structures)
    assert np.array_equal(cached[1], areas)
    assert cached[2] == {10001: "BA1-lh"}

    broken = ac._cache_path(ctx, "broken")
    Path(broken).parent.mkdir(parents=True, exist_ok=True)
    Path(broken).write_bytes(b"not-an-npz-file")
    assert ac._read_cache(broken) is None


def test_cache_file_carries_asset_version():
    """Путь кэша привязан к версии ассета: старые объёмы не подмешиваются."""
    assert ac.cache_file(settings).endswith(f"labels-{ac.asset_version(settings)}.npz")
    assert ac.CONTOUR_SPACING_MM == ms.MRI_SPACING_MM


@pytest.fixture
def fake_contours(monkeypatch) -> dict:
    """Подменяет сборку контуров: роуты проверяются без fsaverage."""
    payload = {
        "version": "testver",
        "plane": "axial",
        "axis": "z",
        "mm": 0.0,
        "spacing_mm": ac.CONTOUR_SPACING_MM,
        "method": ac.BRODMANN_METHOD,
        "structures": [
            {
                "id": "Left-Thalamus-Proper",
                "name": "Left-Thalamus-Proper",
                "label": "таламус (слева)",
                "hulls": [[[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]]],
                "area_mm2": 9.0,
            }
        ],
        "areas": [],
    }
    monkeypatch.setattr(
        routes, "slice_contours", lambda settings, plane, mm: {**payload, "plane": plane}
    )
    return payload


def test_contour_slice_route_returns_payload_with_etag(client, fake_contours):
    """Срез контуров: JSON меток, фактический мм в заголовке и 304 на повтор."""
    response = client.get(f"{_PREFIX}/surface/contours/axial/0")
    assert response.status_code == 200
    body = response.json()
    assert body["structures"][0]["label"] == "таламус (слева)"
    assert body["method"] == ac.BRODMANN_METHOD
    assert response.headers["X-Contour-Mm"] == "0"

    etag = response.headers["ETag"]
    assert etag.startswith('"testver-axial-0')
    again = client.get(f"{_PREFIX}/surface/contours/axial/0", headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_contour_slice_route_rejects_bad_plane_and_range(client):
    """Неизвестная плоскость и срез вне сетки — 404 (проверка до сборки объёмов)."""
    assert client.get(f"{_PREFIX}/surface/contours/oblique/0").status_code == 404
    assert client.get(f"{_PREFIX}/surface/contours/axial/999").status_code == 404


def test_contour_slice_route_reports_missing_atlas(client, monkeypatch):
    """Без файлов атласа срез — 503 с понятным текстом, а не 500."""

    def broken(settings, plane, mm):
        raise FileNotFoundError("нет fsaverage")

    monkeypatch.setattr(routes, "slice_contours", broken)
    response = client.get(f"{_PREFIX}/surface/contours/axial/0")
    assert response.status_code == 503
    assert "fsaverage" in response.json()["detail"]


def test_meta_exposes_contours_ref(client):
    """``/meta`` объявляет ссылку на контуры (версия, URL, шаг, метод) без сборки."""
    body = client.get(f"{_PREFIX}/meta").json()
    contours = body["contours"]
    assert contours["url"] == f"{_PREFIX}/surface/contours"
    assert contours["method"] == ac.BRODMANN_METHOD
    assert contours["spacing_mm"] == ac.CONTOUR_SPACING_MM
    assert contours["version"] == ac.asset_version(settings)


# --- Интеграция: реальные атласы fsaverage (~/mne_data) ---

_HAS_ATLAS = os.path.exists(os.path.join(settings.subjects_dir, CONTOUR_STAMP_RELATIVE[0]))
_skip_no_atlas = pytest.mark.skipif(
    not _HAS_ATLAS, reason="нет атласов fsaverage (~/mne_data): интеграционный тест пропущен"
)


def _area_id(volumes, name: str) -> int:
    """id метки поля по имени (``BA17-lh``) — обратный поиск к ``area_names``."""
    for label_id, area_name in volumes.area_names.items():
        if area_name == name:
            return label_id
    raise AssertionError(f"в разметке нет поля {name}")


@pytest.mark.integration
@_skip_no_atlas
def test_real_structure_centroids_match_affine():
    """Метки на MNI-сетке стоят там же, где воксели тома (сверка через ``affine``).

    Эталон считается независимо: центроид метки в raw-томе переводится в MNI
    матрицей ``aparc+aseg``. Совпадение до миллиметра означает, что выборка узлов
    не перепутала оси — при перепутанных (y ↔ z) срез выглядит правдоподобно, а
    расхождение здесь сразу в десятки миллиметров.
    """
    import nibabel as nib

    image = nib.load(os.path.join(settings.subjects_dir, "fsaverage/mri/aparc+aseg.mgz"))
    raw = np.asanyarray(image.dataobj)
    affine = np.asarray(image.affine, dtype=float)

    ac.clear_contour_cache()
    volumes = ac.load_volumes(ac._ContourCtx.from_settings(settings))
    offset = np.array([ms.MRI_BOUNDS["x"][0], ms.MRI_BOUNDS["y"][0], ms.MRI_BOUNDS["z"][0]])

    # Таламус, боковой желудочек, ствол, гиппокамп слева (id из FreeSurferColorLUT).
    for label_id in (10, 4, 16, 17):
        voxels = np.argwhere(raw == label_id)
        assert voxels.size, f"метка {label_id} не найдена в томе"
        expected = affine[:3, :3] @ voxels.mean(axis=0) + affine[:3, 3]
        actual = offset + np.argwhere(volumes.structures == label_id).mean(axis=0)
        assert np.allclose(actual, expected, atol=1.0), (
            f"метка {label_id}: сетка {np.round(actual, 1)} против тома {np.round(expected, 1)}"
        )


@pytest.mark.integration
@_skip_no_atlas
def test_real_slice_contours_lie_inside_brain_mask(client):
    """Контуры коры и белого вещества не выходят за маску мозга на срезе МРТ."""
    from app.services.mri_slices import _MriCtx, load_volume

    ac.clear_contour_cache()
    payload = ac.slice_contours(settings, "axial", 0.0)
    assert payload["structures"] and payload["areas"], "срез через AC–PC должен быть не пуст"

    volume = load_volume(_MriCtx.from_settings(settings))
    _, alpha = volume.slice("axial", ms.slice_index("axial", 0.0))
    rows, cols = np.nonzero(alpha)
    columns_mm, rows_mm = ms.plane_columns_mni("axial"), ms.plane_rows_mni("axial")
    bounds = (
        columns_mm[cols].min(),
        columns_mm[cols].max(),
        rows_mm[rows].min(),
        rows_mm[rows].max(),
    )

    cortical = [
        shape
        for shape in payload["structures"]
        if shape["id"].startswith("ctx-") or "Cerebral-White-Matter" in shape["id"]
    ]
    assert cortical, "на срезе не оказалось коры и белого вещества"
    points = np.asarray([point for shape in cortical for hull in shape["hulls"] for point in hull])
    assert points[:, 0].min() >= bounds[0] - 1.0 and points[:, 0].max() <= bounds[1] + 1.0
    assert points[:, 1].min() >= bounds[2] - 1.0 and points[:, 1].max() <= bounds[3] + 1.0

    response = client.get(f"{_PREFIX}/surface/contours/axial/0")
    assert response.status_code == 200
    assert response.headers["X-Contour-Mm"] == "0"
    assert len(response.content) > 5_000, "JSON среза подозрительно мал"


@pytest.mark.integration
@_skip_no_atlas
def test_real_brodmann_fields_are_in_known_hemispheres():
    """Производная BA-разметка анатомически правдоподобна (центроиды полей).

    Координаты сверяются с известными MNI-положениями: ``BA17`` — зрительная кора
    затылка, ``BA41`` — слуховая кора височной доли. Проверка держит и полушарие
    (x > 0 — правое, RAS), и отсутствие перестановки осей y/z в разметке.
    """
    ac.clear_contour_cache()
    volumes = ac.load_volumes(ac._ContourCtx.from_settings(settings))
    offset = np.array([ms.MRI_BOUNDS["x"][0], ms.MRI_BOUNDS["y"][0], ms.MRI_BOUNDS["z"][0]])

    left = offset + np.argwhere(volumes.areas == _area_id(volumes, "BA17-lh")).mean(axis=0)
    right = offset + np.argwhere(volumes.areas == _area_id(volumes, "BA17-rh")).mean(axis=0)
    auditory = offset + np.argwhere(volumes.areas == _area_id(volumes, "BA41-lh")).mean(axis=0)

    assert -25.0 < left[0] < 0.0 < right[0] < 25.0, "полушария BA17 перепутаны"
    for point in (left, right):
        assert -100.0 < point[1] < -68.0, "BA17 должна быть в затылочной доле"
        assert -12.0 < point[2] < 25.0
    assert np.allclose(auditory, (-42.0, -25.0, 16.0), atol=12.0), (
        f"BA41-lh оказалась в {np.round(auditory, 1)}"
    )


# --- Структура по MNI-координате точки (подпись для таблицы локализации) ---

_STRUCTURE_BOUNDS = {"x": (-10.0, 10.0), "y": (-10.0, 10.0), "z": (-10.0, 10.0)}


def _synthetic_volumes(marked: dict, marked_areas: dict | None = None) -> ac.ContourVolumes:
    """Синтетические объёмы 21³ на сетке 1 мм с метками по индексам узлов."""
    structures = np.zeros((21, 21, 21), dtype=np.int16)
    for index, label_id in marked.items():
        structures[index] = label_id
    areas = np.zeros_like(structures)
    for index, label_id in (marked_areas or {}).items():
        areas[index] = label_id
    return ac.ContourVolumes(
        structures=structures,
        areas=areas,
        structure_names={7: "Left-Thalamus-Proper", 9: "Right-Thalamus-Proper"},
        structure_labels={7: "таламус (слева)", 9: "таламус (справа)"},
        area_names={3: "BA1-lh", 5: "BA2-rh"},
        area_labels={3: "поле 1 (слева)", 5: "поле 2 (справа)"},
        version="test",
    )


def test_structure_id_at_reads_nearest_mni_node(monkeypatch):
    """Мм MNI → узел сетки: «половина вверх», как у срезов МРТ, и границы тома.

    Подпись структуры обязана читать **тот же** узел, что нарисован на срезе:
    если бы округление расходилось со ``slice_index`` МРТ, подпись под курсором и
    структура в таблице расходились бы на миллиметр — на границе двух ядер это
    разные структуры.
    """
    monkeypatch.setattr(ac, "MRI_BOUNDS", _STRUCTURE_BOUNDS)
    monkeypatch.setattr(ac, "axis_count", lambda axis, spacing=1.0: 21)
    # Узлы: индекс 10 — это мм 0, индекс 11 — мм 1, индекс 5 — мм −5.
    volumes = _synthetic_volumes({(10, 10, 10): 7, (11, 10, 10): 9, (5, 10, 10): 9})

    assert ac.structure_id_at(volumes, [0.0, 0.0, 0.0]) == 7
    # 0.5 равноудалено от узлов 0 и 1: «половина вверх» берёт верхний
    assert ac.structure_id_at(volumes, [0.5, 0.0, 0.0]) == 9
    assert ac.structure_id_at(volumes, [1.4, 0.0, 0.0]) == 9
    # −5.5 равноудалено от −6 и −5: округление вверх, а не «к нулю»
    assert ac.structure_id_at(volumes, [-5.5, 0.0, 0.0]) == 9
    assert ac.structure_id_at(volumes, [-4.0, -4.0, -4.0]) == 0  # метки нет
    assert ac.structure_id_at(volumes, [40.0, 0.0, 0.0]) == 0  # точка вне тома
    assert ac.structure_id_at(volumes, [0.0, 0.0, float("nan")]) == 0
    assert ac.structure_id_at(volumes, [0.0, 0.0]) == 0  # не тройка координат


def test_nearest_structure_returns_name_and_distance(monkeypatch):
    """Ближайшая структура + расстояние, без потолка радиуса (шаг 1.4).

    Сферическая сетка быстрого расчёта ставит узлы и между вокселями атласа, и за
    край мозга: «вне мозга ~N мм до X» с честным расстоянием заменяет прочёрк
    (замер 23.09.2026 — `docs/history.md`).
    """
    monkeypatch.setattr(ac, "MRI_BOUNDS", _STRUCTURE_BOUNDS)
    monkeypatch.setattr(ac, "axis_count", lambda axis, spacing=1.0: 21)
    # Кэш деревьев ключован версией объёмов (у синтетики она одна) — чистим
    ac._structure_trees.clear()
    volumes = _synthetic_volumes({(10, 10, 10): 7})

    # Точно в узле метки — расстояние 0
    assert ac.nearest_structure(volumes, [0.0, 0.0, 0.0]) == ("таламус (слева)", 0.0)
    # 3 мм от метки — та же метка и честные 3 мм
    assert ac.nearest_structure(volumes, [3.0, 0.0, 0.0]) == ("таламус (слева)", 3.0)
    # Дальше любого радиуса метка не исчезает: показывается с расстоянием
    name, distance = ac.nearest_structure(volumes, [9.0, 0.0, 0.0])
    assert name == "таламус (слева)" and distance == 9.0
    # Мусор на входе и пустой объём — (None, None), а не падение KD-дерева
    assert ac.nearest_structure(volumes, [0.0, float("nan"), 0.0]) == (None, None)
    assert ac.nearest_structure(volumes, [0.0, 0.0]) == (None, None)
    ac._structure_trees.clear()
    assert ac.nearest_structure(_synthetic_volumes({}), [0.0, 0.0, 0.0]) == (None, None)


def test_nearest_area_returns_area_and_distance(monkeypatch):
    """Ближайшее поле Бродмана читается из объёма ``volumes.areas`` (шаг 1.4/N21).

    Это **тот же** объём, что рисует контуры среза и отвечает на клик: одна точка
    не может получить разные поля в таблице и на срезе.
    """
    monkeypatch.setattr(ac, "MRI_BOUNDS", _STRUCTURE_BOUNDS)
    monkeypatch.setattr(ac, "axis_count", lambda axis, spacing=1.0: 21)
    ac._area_trees.clear()
    volumes = _synthetic_volumes({}, marked_areas={(10, 10, 10): 3, (11, 10, 10): 5})

    assert ac.nearest_area(volumes, [0.0, 0.0, 0.0]) == ("BA1-lh", 0.0)
    assert ac.nearest_area(volumes, [1.0, 0.0, 0.0]) == ("BA2-rh", 0.0)
    name, distance = ac.nearest_area(volumes, [4.0, 0.0, 0.0])
    assert name == "BA2-rh" and distance == 3.0
    assert ac.nearest_area(volumes, [0.0, float("nan"), 0.0]) == (None, None)
    ac._area_trees.clear()
    assert ac.nearest_area(_synthetic_volumes({}), [0.0, 0.0, 0.0]) == (None, None)


def test_outside_brainmask_uses_voxel_tolerance():
    """«Вне мозга» — дальше допуска в воксель; мусор — None, а не True."""
    from scipy.spatial import cKDTree

    tree = cKDTree(np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]))
    assert ac.outside_brainmask(tree, [0.5, 0.0, 0.0]) is False
    # Полувоксельное смещение у границы маски не превращается в «вне мозга»
    assert ac.outside_brainmask(tree, [1.8, 0.0, 0.0]) is False
    assert ac.outside_brainmask(tree, [5.0, 0.0, 0.0]) is True
    assert ac.outside_brainmask(tree, [0.0, float("nan"), 0.0]) is None


def test_attribution_at_returns_fields_and_none_without_atlas(monkeypatch):
    """Атрибуция одной функцией: структура + поле + расстояния + «вне мозга»."""
    from scipy.spatial import cKDTree

    monkeypatch.setattr(ac, "MRI_BOUNDS", _STRUCTURE_BOUNDS)
    monkeypatch.setattr(ac, "axis_count", lambda axis, spacing=1.0: 21)
    ac._structure_trees.clear()
    ac._area_trees.clear()
    volumes = _synthetic_volumes({(10, 10, 10): 7}, marked_areas={(10, 10, 10): 3})
    monkeypatch.setattr(ac, "load_volumes", lambda ctx: volumes)
    monkeypatch.setattr(
        ac, "brain_mask_tree", lambda ctx: cKDTree(np.array([[0.0, 0.0, 0.0]]))
    )

    attribution = ac.attribution_at(settings, [0.0, 0.0, 0.0])
    assert attribution is not None
    assert attribution.structure_name == "таламус (слева)"
    assert attribution.structure_distance_mm == 0.0
    assert attribution.area_name == "BA1-lh"
    assert attribution.area_distance_mm == 0.0
    assert attribution.outside_brain is False
    # Дальше маски — «вне мозга», но метки остаются с расстояниями (не прочёрк)
    far = ac.attribution_at(settings, [8.0, 0.0, 0.0])
    assert far is not None
    assert far.outside_brain is True
    assert far.structure_name == "таламус (слева)" and far.structure_distance_mm == 8.0
    # Мусор на входе — None, без выдуманных меток
    assert ac.attribution_at(settings, None) is None
    assert ac.attribution_at(settings, [0.0, float("nan"), 0.0]) is None

    def _boom(ctx):
        raise RuntimeError("нет атласа")

    monkeypatch.setattr(ac, "load_volumes", _boom)
    assert ac.attribution_at(settings, [0.0, 0.0, 0.0]) is None
    # Контракт точки без атласа — пустые поля, а не ошибка и не «unknown»
    assert ac.attribution_payload(settings, [0.0, 0.0, 0.0]) == {
        "anatomical_structure": None,
        "structure_distance_mm": None,
        "brodmann_area": None,
        "brodmann_distance_mm": None,
        "outside_brain": None,
    }


@pytest.mark.integration
@_skip_no_atlas
def test_real_attribution_structure_matches_volume():
    """Реальный атлас: ближайшая структура по MNI совпадает с меткой объёма.

    Узловая точка берётся **внутри** структуры (медианный воксель метки),
    координата — её MNI через ``affine`` тома: это тот же путь, которым приходят
    точки расчёта диполей (``head_to_mni`` → атрибуция), и он должен давать
    анатомию той структуры, а не соседней.
    """
    import nibabel as nib

    image = nib.load(os.path.join(settings.subjects_dir, "fsaverage/mri/aparc+aseg.mgz"))
    raw = np.asanyarray(image.dataobj)
    affine = np.asarray(image.affine, dtype=float)

    ac.clear_contour_cache()
    volumes = ac.load_volumes(ac._ContourCtx.from_settings(settings))

    for label_id, fragment in ((10, "таламус"), (4, "желудочек"), (17, "гиппокамп")):
        voxels = np.argwhere(raw == label_id)
        assert voxels.size, f"метка {label_id} не найдена в томе"
        index = np.array(voxels[len(voxels) // 2], dtype=float)
        mni = affine[:3, :3] @ index + affine[:3, 3]
        name, distance = ac.nearest_structure(volumes, mni)
        assert name is not None, f"метка {label_id}: структура не определена (MNI {np.round(mni, 1)})"
        assert fragment in name.lower(), f"метка {label_id}: получено {name!r}"
        assert distance is not None and distance <= 1.0, f"метка {label_id}: расстояние {distance}"
        assert ac.structure_id_at(volumes, mni) == label_id


@pytest.mark.integration
@_skip_no_atlas
def test_one_point_one_ba_in_table_and_slice():
    """Тест 1.4/N21: одна точка → одинаковый BA в таблице и на срезе.

    Атрибуция точки и контуры среза читают **один** объём ``volumes.areas``:
    поле из таблицы локализации обязано быть среди меток среза через ту же точку
    (раньше таблица шла по центроидам PALS и расходилась с объёмом в ~70 %).
    """
    ac.clear_contour_cache()
    volumes = ac.load_volumes(ac._ContourCtx.from_settings(settings))
    offset = np.array([ms.MRI_BOUNDS["x"][0], ms.MRI_BOUNDS["y"][0], ms.MRI_BOUNDS["z"][0]])
    nodes = np.argwhere(volumes.areas == _area_id(volumes, "BA17-lh"))
    # Узел внутри поля, а не центроид: центроид метки лежит между узлами сетки 1 мм
    index = nodes[len(nodes) // 2]
    mni = (offset + index.astype(float)).tolist()

    attribution = ac.attribution_at(settings, mni)
    assert attribution is not None
    assert attribution.area_name == "BA17-lh"
    assert attribution.area_distance_mm == 0.0

    slice_shapes = ac.slice_contours(settings, "sagittal", float(mni[0]))
    assert "BA17-lh" in {shape["id"] for shape in slice_shapes["areas"]}, (
        "поле из таблицы отсутствует на срезе через ту же точку — два источника BA"
    )


@pytest.mark.integration
@_skip_no_atlas
def test_real_volumes_are_cached_on_disk():
    """Объёмы собираются один раз: кэш версии читается без повторного построения."""
    path = ac.cache_file(settings)
    if os.path.exists(path):
        os.remove(path)
    ac.clear_contour_cache()
    meta = ac.contours_meta(settings)
    assert os.path.exists(path)
    assert meta["n_structures"] > 50 and meta["n_areas"] > 20

    ac.clear_contour_cache()
    volumes = ac.load_volumes(ac._ContourCtx.from_settings(settings))
    assert volumes.version == meta["version"]
    assert np.count_nonzero(volumes.areas) > 100_000, "производная разметка полей пуста"


