"""Кластеризация диполей по ROI (остаток 4.7, B8): воксель + связные компоненты.

Синтетические облака с известной геометрией: два скопления (левое/правое
полушарие) + разрозненные точки — проверяем разделение кластеров, отсев
«шума» меньше ``min_points``, метрики B8 (центроид, объём/плотность,
устойчивость по записям, доминирующие ROI) и паспорт параметров.
"""
import pytest

from app.core.config import settings
from app.services.dipole_clusters import cluster_dipoles, cluster_params


def _point(x: float, y: float, z: float, rid: str, structure: str, area: str) -> dict:
    return {
        "recording_id": rid,
        "mni": [x, y, z],
        "structure": structure,
        "area": area,
    }


@pytest.fixture
def clouds() -> list[dict]:
    """Левое облако (5 точек, 2 записи) + правое (4 точки, 1 запись) + одиночки."""
    left = [
        _point(0, 0, 50, "rec-a", "таламус (слева)", "BA7-lh"),
        _point(5, 3, 52, "rec-a", "таламус (слева)", "BA7-lh"),
        _point(-4, 2, 48, "rec-b", "таламус (слева)", "BA7-lh"),
        _point(3, -2, 55, "rec-a", "таламус (слева)", "BA7-lh"),
        _point(6, 1, 47, "rec-b", "таламус (слева)", "BA7-lh"),
    ]
    right = [
        _point(60, 0, 30, "rec-a", "зрительная кора (справа)", "BA17-rh"),
        _point(63, 2, 32, "rec-a", "зрительная кора (справа)", "BA17-rh"),
        _point(58, -3, 33, "rec-a", "зрительная кора (справа)", "BA17-rh"),
        _point(61, 4, 28, "rec-a", "зрительная кора (справа)", "BA17-rh"),
    ]
    noise = [_point(-80, -60, -40, "rec-a", None, None)]
    return left + right + noise


def test_two_clouds_split_and_noise_rejected(clouds):
    """Два скопления — два кластера; одиночная точка отсеяна min_points."""
    clusters = cluster_dipoles(clouds, settings)
    assert len(clusters) == 2
    # Крупный первым (сортировка по убыванию числа точек)
    big, small = clusters[0], clusters[1]
    assert big["n_points"] == 5
    assert small["n_points"] == 4
    # Центроиды — в своих полушариях
    assert big["centroid_mni"][0] < 20
    assert small["centroid_mni"][0] > 40
    # Шум отброшен: точек в кластерах 9 из 10
    assert big["share"] + small["share"] == pytest.approx(9 / 10)


def test_session_share_and_roi_tops(clouds):
    """Устойчивость: левое облако из двух записей, правое — одной; ROI-топы."""
    clusters = cluster_dipoles(clouds, settings)
    big, small = clusters[0], clusters[1]
    # Левое: rec-a и rec-b → обе записи группы (шумовая точка тоже rec-a)
    assert big["n_sessions"] == 2
    assert big["session_share"] == pytest.approx(1.0)
    # Правое: одна запись из двух — «особенность записи», не группа
    assert small["n_sessions"] == 1
    assert small["session_share"] == pytest.approx(0.5)
    # Доминирующие ROI — из точек кластера
    assert big["top_structures"] == ["таламус (слева)"]
    assert big["top_brodmann"] == ["BA7-lh"]
    assert small["top_brodmann"] == ["BA17-rh"]


def test_metrics_volume_density_and_extent(clouds):
    """Метрики B8: объём по ячейкам, плотность точек/см³, протяжённость ббокса."""
    clusters = cluster_dipoles(clouds, settings)
    big = clusters[0]
    voxel_cm3 = (settings.group_cluster_voxel_mm / 10) ** 3
    # Объём кратен кубу вокселя (ячейки сетки, занятые точками облака)
    assert big["volume_cm3"] == pytest.approx(
        round(big["volume_cm3"] / voxel_cm3) * voxel_cm3, rel=0.01,
    )
    assert big["volume_cm3"] >= voxel_cm3
    # Плотность — число точек на объём (B8 «плотность»), округление до 0.1
    assert big["density_per_cm3"] == pytest.approx(
        big["n_points"] / big["volume_cm3"], abs=0.05,
    )
    # Протяжённость левого облака: x от -4 до 6 → 10 мм
    assert big["extent_mm"][0] == pytest.approx(10.0)


def test_too_few_points_return_empty():
    """Меньше min_points — кластеров нет (пустой список, не ошибка)."""
    few = [_point(i * 3.0, 0, 40, "rec-a", "x", "BA1") for i in range(3)]
    assert cluster_dipoles(few, settings) == []
    # И вообще без MNI
    assert cluster_dipoles([{"recording_id": "r", "mni": None}], settings) == []


def test_cluster_params_passport():
    """Паспорт: параметры, задающие числа (конфиг + связность 26)."""
    params = cluster_params(settings)
    assert params["voxel_mm"] == settings.group_cluster_voxel_mm
    assert params["min_points"] == settings.group_cluster_min_points
    assert params["connectivity"] == 26
