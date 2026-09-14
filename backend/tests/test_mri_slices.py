"""Тесты срезов МРТ (`app/services/mri_slices.py` и роуты `/surface/mri`).

Быстрая часть не требует fsaverage: геометрия сетки проверяется чистыми
функциями, ориентация картинки — синтетическим томом (у него яркость зависит от
индексов, поэтому перевороты осей видно сразу), выборка узлов сетки — томом
«линейкой» с настоящей укладкой ``T1.mgz``, дисковый кэш — каталогом tmp, а
роуты — подменённым ``load_volume``. Реальный том (``~/mne_data``) проверяется
отдельными тестами с маркером ``integration``, включая сверку с независимым
пересчётом тома на MNI-сетку (``nibabel.resample_from_to``).
"""
import json
import os
import re
from dataclasses import replace
from pathlib import Path
from typing import Dict, Tuple

import numpy as np
import pytest

from app.core.config import settings
from app.services import mri_slices as ms

_TS_GEOMETRY = (
    Path(__file__).resolve().parents[2] / "frontend/src/shared/lib/mriProjections.ts"
)
_PREFIX = settings.api_prefix


def _ramp_volume(axis: str) -> ms.MriVolume:
    """Том-«линейка»: яркость = индекс вокселя вдоль оси MNI (значит, мм + сдвиг).

    По картинке среза однозначно читается, какая ось попала в столбцы/строки и
    куда она растёт — именно это и проверяют тесты ориентации.
    """
    shape = ms.mri_shape()
    index = np.arange(shape[ms._AXIS_POS[axis]], dtype=np.uint8)
    broadcast = index.reshape([-1 if position == ms._AXIS_POS[axis] else 1 for position in range(3)])
    gray = np.broadcast_to(broadcast, shape).copy()
    alpha = np.full(shape, 255, dtype=np.uint8)
    return ms.MriVolume(gray=gray, alpha=alpha, version="test", spacing_mm=ms.MRI_SPACING_MM)


@pytest.fixture
def fake_volume(monkeypatch) -> ms.MriVolume:
    """Подменяет сборку тома, чтобы роуты не читали fsaverage."""
    volume = _ramp_volume("x")
    monkeypatch.setattr(ms, "load_volume", lambda ctx: volume)
    return volume


def test_grid_covers_volume_bounds():
    """Сетка строится по границам включительно, шаг — 1 мм."""
    for axis in ("x", "y", "z"):
        grid = ms.axis_grid(axis)
        assert grid[0] == ms.MRI_BOUNDS[axis][0]
        assert grid[-1] == ms.MRI_BOUNDS[axis][1]
        assert len(grid) == ms.axis_count(axis)
        assert grid[1] - grid[0] == ms.MRI_SPACING_MM
    assert ms.mri_shape() == tuple(ms.axis_count(axis) for axis in ("x", "y", "z"))


@pytest.mark.parametrize(
    "plane, mm, index, actual",
    [
        ("axial", 0.0, 82, 0.0),
        ("axial", -3.5, 79, -3.0),  # половина вверх: −3.5 → −3
        ("axial", -3.6, 78, -4.0),
        ("sagittal", 79.4, 159, 79.0),
        ("coronal", -115.6, 0, -116.0),
    ],
)
def test_slice_index_rounds_half_up(plane, mm, index, actual):
    """Квантование сеткой: округление «половина вверх» и зажим в границы."""
    assert ms.slice_index(plane, mm) == index
    assert ms.slice_mm(plane, mm) == pytest.approx(actual)


def test_slice_index_clamps_out_of_range():
    """Значения вне тома зажимаются к крайним срезам (внутренняя защита)."""
    assert ms.slice_index("axial", 10_000) == ms.axis_count("z") - 1
    assert ms.slice_index("axial", -10_000) == 0
    assert ms.slice_index("axial", float("nan")) == ms.slice_index("axial", 0)


def test_corners_follow_ui_signs():
    """Углы картинки соответствуют знакам осей из геометрии UI."""
    for plane in ms.PLANES:
        horizontal, vertical = ms.PLANE_AXES[plane]
        normal = ms.PLANE_AXIS[plane]
        top_left, bottom_right = ms.slice_corners_mni(plane, 0)

        low_h, high_h = ms.MRI_BOUNDS[horizontal]
        low_v, high_v = ms.MRI_BOUNDS[vertical]
        expect_left = high_h if ms.PLANE_HORIZONTAL_SIGN[plane] == -1 else low_h
        expect_top = high_v if ms.PLANE_VERTICAL_SIGN[plane] == 1 else low_v

        assert top_left[horizontal] == expect_left
        assert top_left[vertical] == expect_top
        assert bottom_right[horizontal] != expect_left
        assert top_left[normal] == 0.0


def test_slice_orientation_matches_grid_math():
    """Раскладка массива среза совпадает с чистой математикой сетки.

    Проверка ловит ошибку в знаках/порядке осей: у тома-«линейки» по оси a яркость
    равна номеру узла этой оси, поэтому верхний левый пиксель обязан нести
    координату первого столбца (если a — горизонталь), первой строки (если a —
    вертикаль) или номер самого среза (если a — нормаль плоскости).
    """
    for plane in ms.PLANES:
        horizontal, vertical = ms.PLANE_AXES[plane]
        cols, rows = ms.plane_columns_mni(plane), ms.plane_rows_mni(plane)
        index = ms.slice_index(plane, 12.0)

        for axis in ("x", "y", "z"):
            gray, alpha = _ramp_volume(axis).slice(plane, index)
            low = ms.MRI_BOUNDS[axis][0]
            assert gray.shape == (len(rows), len(cols))
            assert alpha.min() == 255

            if axis == horizontal:
                assert np.array_equal(gray[0], cols - low), f"{plane}: столбцы {axis}"
                assert np.array_equal(gray[-1], cols - low), "строки одинаковы"
            elif axis == vertical:
                assert np.array_equal(gray[:, 0], rows - low), f"{plane}: строки {axis}"
                assert np.array_equal(gray[:, -1], rows - low), "столбцы одинаковы"
            else:
                assert gray.min() == gray.max() == index, f"{plane}: постоянный срез {axis}"


def test_slice_png_quantizes_value(monkeypatch, fake_volume):
    """Сервис отдаёт PNG и фактический (квантованный) срез."""
    monkeypatch.setattr(ms, "load_volume", lambda ctx: fake_volume)

    data, version, actual = ms.slice_png(settings, "axial", 12.4)

    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert version == "test"
    assert actual == 12.0


@pytest.mark.parametrize(
    "plane, mm, message",
    [
        ("oblique", 0.0, "Неизвестная плоскость"),
        ("axial", 400.0, "вне тома"),
        ("axial", float("nan"), "вне тома"),
    ],
)
def test_slice_png_validates_request(monkeypatch, fake_volume, plane, mm, message):
    """Внеконтрактный запрос — ошибка, а не «показать ближайший срез»."""
    monkeypatch.setattr(ms, "load_volume", lambda ctx: fake_volume)

    with pytest.raises(ValueError, match=message):
        ms.slice_png(settings, plane, mm)


def test_volume_cache_roundtrip(tmp_path):
    """Кэш тома: запись на диск и чтение без потерь (включая окно яркости)."""
    volume = replace(_ramp_volume("x"), window=(22.0, 110.0))
    paths = ms._cache_paths(ms._MriCtx("subjects", str(tmp_path), _PREFIX), "abc123")

    ms._write_volume_cache(paths, volume)
    restored = ms._read_volume_cache(paths)

    assert restored is not None
    assert restored.version == "test"
    assert restored.window == (22.0, 110.0)
    assert np.array_equal(restored.gray, volume.gray)
    assert np.array_equal(restored.alpha, volume.alpha)


def test_volume_cache_rejects_other_grid_version(tmp_path):
    """Кэш другой версии сборки не подхватывается: геометрия могла измениться."""
    paths = ms._cache_paths(ms._MriCtx("subjects", str(tmp_path), _PREFIX), "abc123")
    ms._write_volume_cache(paths, _ramp_volume("x"))

    with open(paths[1], "r", encoding="utf-8") as fh:
        meta = json.load(fh)
    meta["grid_version"] = ms.MRI_GRID_VERSION + 1
    with open(paths[1], "w", encoding="utf-8") as fh:
        json.dump(meta, fh)

    assert ms._read_volume_cache(paths) is None


def test_volume_cache_missing_files(tmp_path):
    """Без файлов кэша сервис честно сообщает «нет кэша», а не падает."""
    paths = ms._cache_paths(ms._MriCtx("subjects", str(tmp_path), _PREFIX), "nope")

    assert ms._read_volume_cache(paths) is None


def test_surface_meta_endpoint(client, fake_volume):
    """`/surface/mri` отдаёт границы, шаг и плоскости срезов."""
    response = client.get(f"{_PREFIX}/surface/mri")

    assert response.status_code == 200
    body = response.json()
    assert body["bounds"] == {
        axis: [value[0], value[1]] for axis, value in ms.MRI_BOUNDS.items()
    }
    assert body["spacing_mm"] == ms.MRI_SPACING_MM
    assert body["encoding"] == "png-gray8-alpha"
    assert set(body["planes"]) == set(ms.PLANES)
    for plane, info in body["planes"].items():
        axis = ms.PLANE_AXIS[plane]
        assert info["axis"] == axis
        assert info["count"] == ms.axis_count(axis)
        assert info["range_mm"] == [ms.MRI_BOUNDS[axis][0], ms.MRI_BOUNDS[axis][1]]


def test_slice_endpoint_serves_png_with_etag(client, fake_volume):
    """Срез отдаётся PNG, ETag кэширует его, фактический срез — в заголовке."""
    response = client.get(f"{_PREFIX}/surface/mri/slice/axial/12.4.png")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG\r\n\x1a\n")
    assert response.headers["x-mri-slice-mm"] == "12"
    assert "max-age" in response.headers["cache-control"]

    cached = client.get(
        f"{_PREFIX}/surface/mri/slice/axial/12.4.png",
        headers={"If-None-Match": response.headers["etag"]},
    )
    assert cached.status_code == 304

    same_slice = client.get(f"{_PREFIX}/surface/mri/slice/axial/12.png")
    assert same_slice.headers["etag"] == response.headers["etag"], "тот же срез — тот же ETag"


@pytest.mark.parametrize("path", ["axial/400.png", "oblique/0.png"])
def test_slice_endpoint_rejects_bad_request(client, fake_volume, path):
    """Плоскость вне контракта и срез вне тома — 404 с пояснением."""
    response = client.get(f"{_PREFIX}/surface/mri/slice/{path}")

    assert response.status_code == 404
    assert "detail" in response.json()


def test_meta_exposes_mri_slice_ref(client):
    """`/meta` даёт версию и базовый URL срезов — UI строит ссылки на картинки сам."""
    body = client.get(f"{_PREFIX}/meta").json()

    ref = body["mri_slices"]
    assert ref["slice_url"] == f"{_PREFIX}/surface/mri/slice"
    assert ref["spacing_mm"] == ms.MRI_SPACING_MM
    assert ref["version"] == ms.asset_version(settings)


def test_geometry_matches_frontend():
    """Границы и знаки осей в TS совпадают с бэкендом: иначе срез «уедет».

    Константы живут в двух языках (JSON-контракт их не переносит), поэтому
    расхождение ловим чтением TS-таблиц: это дешевле, чем искать зеркальную
    картинку глазами в браузере.
    """
    if not _TS_GEOMETRY.exists():  # pragma: no cover - бэкенд без фронтенда
        pytest.skip("нет исходников фронтенда")

    text = _TS_GEOMETRY.read_text(encoding="utf-8")

    bounds_block = re.search(r"MNI_BRAIN_BOUNDS[^=]*=\s*\{(.*?)\n\}", text, re.S)
    assert bounds_block, "в mriProjections.ts не найдены границы MNI"
    ts_bounds: Dict[str, Tuple[float, float]] = {
        axis: (float(low), float(high))
        for axis, low, high in re.findall(
            r"(\w+):\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]", bounds_block.group(1)
        )
    }
    assert ts_bounds == {
        axis: (float(value[0]), float(value[1])) for axis, value in ms.MRI_BOUNDS.items()
    }

    for name, backend in (
        ("PLANE_HORIZONTAL_SIGN", ms.PLANE_HORIZONTAL_SIGN),
        ("PLANE_VERTICAL_SIGN", ms.PLANE_VERTICAL_SIGN),
    ):
        block = re.search(rf"{name}[^=]*=\s*\{{(.*?)\}}", text, re.S)
        assert block, f"в mriProjections.ts не найдена таблица {name}"
        parsed = {
            plane: int(sign) for plane, sign in re.findall(r"(\w+):\s*(-?1)\b", block.group(1))
        }
        assert parsed == {plane: int(sign) for plane, sign in backend.items()}


# Укладка fsaverage/mri/T1.mgz — коронарная (L, I, A), а не аксиальная: строки
# воксельных осей идут в порядке x, z, y.
_CORONAL_AFFINE = np.array(
    [
        [-1.0, 0.0, 0.0, 128.0],
        [0.0, 0.0, 1.0, -128.0],
        [0.0, -1.0, 0.0, 128.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
)


def test_voxel_axis_of_handles_coronal_packing():
    """Оси MNI и вокселей у T1 fsaverage переставлены: y и z идут третьей и второй.

    Диагональная матрица (аксиальная укладка) даёт совпадение номеров — на ней
    путаница не видна, поэтому проверяются обе укладки.
    """
    assert ms._voxel_axis_of(_CORONAL_AFFINE) == {"x": 0, "y": 2, "z": 1}
    assert ms._voxel_axis_of(np.diag([-1.0, 1.0, 1.0, 1.0])) == {"x": 0, "y": 1, "z": 2}


def test_voxel_indices_take_own_row_per_axis():
    """Узел сетки берётся строкой обратной матрицы **своей оси вокселей**.

    Том-«линейка» с настоящей укладкой ``T1.mgz``: значение в вокселе равно
    MNI-координате по его оси. Если взять строку «по номеру оси MNI» (прежняя
    ошибка), выходные y и z окажутся чужими — на срезе видна не та анатомия,
    которую не исправляет никакой переворот картинки.
    """
    shape = (256, 256, 256)
    axes = np.arange(256, dtype=np.int16)
    volumes = {
        # воксель (i, j, k) → MNI (128 − i, k − 128, 128 − j)
        "x": np.broadcast_to((128 - axes)[:, None, None], shape).copy(),
        "y": np.broadcast_to((axes - 128)[None, None, :], shape).copy(),
        "z": np.broadcast_to((128 - axes)[None, :, None], shape).copy(),
    }

    order = ms._mni_order(ms._voxel_axis_of(_CORONAL_AFFINE))
    sampling = np.ix_(*ms.voxel_indices(_CORONAL_AFFINE, shape))
    for index, axis in enumerate(("x", "y", "z")):
        sampled = np.asarray(volumes[axis][sampling]).transpose(order)
        along = np.moveaxis(sampled, index, 0)
        expected = np.broadcast_to(ms.axis_grid(axis).reshape(-1, 1, 1), along.shape)
        assert np.array_equal(along, expected), f"ось {axis} пришла не со своей осью вокселей"


@pytest.mark.integration

@pytest.mark.integration
@pytest.mark.skipif(
    not os.path.exists(os.path.join(settings.subjects_dir, ms.MRI_STAMP_RELATIVE[0])),
    reason="нет тома fsaverage (~/mne_data): интеграционный тест пропущен",
)
def test_real_volume_fits_bounds_and_has_brain(client):
    """Реальный том: маска мозга внутри границ сетки, срез через AC не пуст.

    Границы сетки — константа, а маска приходит из данных: тест следит, чтобы
    условные числа не «отрезали» мозжечок или ствол при обновлении fsaverage.
    """
    import nibabel as nib

    mask_path = os.path.join(settings.subjects_dir, ms.MRI_STAMP_RELATIVE[1])
    affine = np.asarray(nib.load(mask_path).affine, dtype=float)
    voxels = np.argwhere(np.asanyarray(nib.load(mask_path).dataobj) > 0)
    xyz = (affine @ np.c_[voxels, np.ones(len(voxels))].T)[:3].T
    for index, axis in enumerate(("x", "y", "z")):
        low, high = ms.MRI_BOUNDS[axis]
        assert xyz[:, index].min() >= low, f"маска выходит за сетку по {axis}"
        assert xyz[:, index].max() <= high, f"маска выходит за сетку по {axis}"

    ms.load_volume.cache_clear()
    volume = ms.load_volume(ms._MriCtx.from_settings(settings))
    assert volume.gray.shape == ms.mri_shape()
    assert volume.window[1] > volume.window[0]

    for plane in ms.PLANES:
        gray, alpha = volume.slice(plane, ms.slice_index(plane, 0))
        assert (alpha > 0).sum() > 10_000, f"срез {plane} через AC пуст"
        assert gray[alpha > 0].max() > 0

    response = client.get(f"{_PREFIX}/surface/mri/slice/sagittal/0.png")
    assert response.status_code == 200
    assert len(response.content) > 5_000, "картинка реального среза подозрительно мала"


@pytest.mark.integration
@pytest.mark.skipif(
    not os.path.exists(os.path.join(settings.subjects_dir, ms.MRI_STAMP_RELATIVE[0])),
    reason="нет тома fsaverage (~/mne_data): интеграционный тест пропущен",
)
def test_real_volume_matches_independent_resample():
    """Собранный том совпадает с независимым пересчётом тома на MNI-сетку.

    Эталон — ``nibabel.processing.resample_from_to`` ближайшим вокселем на ту же
    сетку и ту же матрицу (fsaverage совмещён с MNI305: ``talairach.xfm`` —
    единичная матрица), поэтому значения обязаны совпасть пиксель в пиксель.
    Тест ловит ошибки выборки осей, которые на одной картинке среза выглядят как
    «мозг не так повёрнут» и не отделяются от ошибок раскладки в UI.
    """
    import nibabel as nib
    from nibabel.processing import resample_from_to

    t1 = nib.load(os.path.join(settings.subjects_dir, ms.MRI_STAMP_RELATIVE[0]))
    mask = nib.load(os.path.join(settings.subjects_dir, ms.MRI_STAMP_RELATIVE[1]))
    assert np.allclose(t1.affine, mask.affine), "T1 и brainmask разной укладки"

    shape = ms.mri_shape()
    grid_affine = np.diag([ms.MRI_SPACING_MM] * 3 + [1.0])
    for index, axis in enumerate(("x", "y", "z")):
        grid_affine[index, 3] = float(ms.axis_grid(axis)[0])

    ms.load_volume.cache_clear()
    volume = ms.load_volume(ms._MriCtx.from_settings(settings))

    low, high = volume.window
    span = (high - low) or 1.0
    reference = np.asarray(
        np.asanyarray(resample_from_to(t1, (shape, grid_affine), order=0).dataobj),
        dtype=np.float32,
    )
    inside = np.asanyarray(resample_from_to(mask, (shape, grid_affine), order=0).dataobj) > 0

    expected_gray = np.where(inside, np.clip((reference - low) / span, 0.0, 1.0) * 255.0, 0.0)
    assert np.array_equal(volume.gray, expected_gray.astype(np.uint8))
    assert np.array_equal(volume.alpha > 0, inside)
    assert int(volume.alpha[inside].min()) == 255
