"""Тесты силуэта коры (`app/services/brain_silhouette.py` и роут обводки).

Без реального fsaverage: синтетический меш-куб (его проекция — квадрат с
известным bbox) проверяет растеризацию и трассировку, подменённый загрузчик —
роут; загрузка **именно** `*.pial` (а не регистрационной сферы `*.sphere`,
чей силуэт — круг) закреплена отдельным тестом. Реальный меш — маркер
``integration``.
"""
import numpy as np
import pytest

from app.core.config import settings
from app.services import brain_silhouette as bs

_PREFIX = settings.api_prefix


def _cube_mesh() -> tuple[np.ndarray, np.ndarray]:
    """Куб 80×80×80 мм с центром в начале координат: 8 вершин, 12 треугольников."""
    vertices = np.array(
        [
            [-40.0, -40.0, -40.0], [-40.0, -40.0, 40.0],
            [-40.0, 40.0, -40.0], [-40.0, 40.0, 40.0],
            [40.0, -40.0, -40.0], [40.0, -40.0, 40.0],
            [40.0, 40.0, -40.0], [40.0, 40.0, 40.0],
        ],
        dtype=np.float64,
    )
    triangles = np.array(
        [
            [0, 1, 3], [0, 3, 2],
            [4, 6, 7], [4, 7, 5],
            [0, 5, 1], [0, 4, 5],
            [2, 3, 7], [2, 7, 6],
            [0, 2, 6], [0, 6, 4],
            [1, 5, 7], [1, 7, 3],
        ],
        dtype=np.int64,
    )
    return vertices, triangles


@pytest.mark.parametrize("plane", ["axial", "sagittal", "coronal"])
def test_silhouette_hulls_cover_projection_bbox(plane):
    """Силуэт куба — контур проекции: bbox квадрата ±40 мм на каждой плоскости."""
    vertices, triangles = _cube_mesh()

    hulls = bs.silhouette_hulls(vertices, triangles, plane)

    assert hulls, "контур силуэта обязан быть"
    points = np.asarray([point for hull in hulls for point in hull])
    # Контур идёт по границе маски (полушага сетки + замыкание 2 пикселя)
    assert points.min() <= -39
    assert points.max() >= 39
    assert points.max() <= 45


def test_load_pial_reads_cortical_surface(monkeypatch):
    """Загрузчик берёт `*.pial` (наружная кора), а не `*.sphere` (силуэт — круг)."""
    requested: list[str] = []

    def fake_read_geometry(path):
        requested.append(path)
        return _cube_mesh()

    monkeypatch.setattr(bs.nib.freesurfer, "read_geometry", fake_read_geometry)
    vertices, triangles = bs._load_pial(bs._SilhouetteCtx("subjects"))

    assert [path.rsplit("/", 1)[-1] for path in requested] == ["lh.pial", "rh.pial"]
    # Оба полушария в одном меше: индексы второго смещены на число вершин первого
    assert len(vertices) == 16 and len(triangles) == 24
    assert triangles[12:].min() >= 8


def test_outline_endpoint_serves_json_with_etag(client, monkeypatch):
    """Обводка отдаётся JSON с ETag и контурами всех трёх плоскостей."""
    vertices, triangles = _cube_mesh()
    monkeypatch.setattr(bs, "_load_pial", lambda ctx: (vertices, triangles))
    bs._build.cache_clear()
    try:
        response = client.get(f"{_PREFIX}/surface/mri/mip/outline")

        assert response.status_code == 200
        body = response.json()
        assert set(body["outlines"]) == {"axial", "sagittal", "coronal"}
        for hulls in body["outlines"].values():
            assert hulls, "на каждой плоскости силуэт обязан быть"
        assert response.headers["etag"].strip('"') == body["version"]

        cached = client.get(
            f"{_PREFIX}/surface/mri/mip/outline",
            headers={"If-None-Match": response.headers["etag"]},
        )
        assert cached.status_code == 304
    finally:
        bs._build.cache_clear()
