"""Кластеризация диполей по ROI (остаток 4.7, B8 «Кластер», concept §10/§11).

Пространственные кластеры точек **одной полосы** выборки: воксельная сетка
плотности + связные компоненты ``scipy.ndimage.label`` (26-связность) — без
новых зависимостей (выбор против scikit-learn обоснован в concept §10:
``scipy`` уже в requirements, замер качества — до смены метода).

Что считается (метрики B8 ``docs/data-blocks.md``):

* центроид (MNI), число точек и объём кластера (ячейки сетки × куб вокселя),
  плотность точек/см³, доля точек выборки;
* **устойчивость по записям**: в скольких участниках группы есть точки
  кластера (доля участников) — первый признак «общей закономерности»;
* доминирующие ROI кластера — топы структур и полей Бродмана по числу
  точек кластера (привязка к ROI, §3.5).

Параметры (``group_cluster_voxel_mm`` / ``group_cluster_min_points``) — в
``core/config.py`` и входят в паспорт (``GroupClusterParamsOut``): смена
сетки меняет кластеры — числа без базиса не подписываем.

**С2 (кластеры прогона, 15.10.2026):** тот же воксельный метод работает на
точках пакета поддиапазонов (``cluster_points`` — ядро с параметрами, а не из
конфига; ``cluster_dipoles`` — групповая обёртка). Параметры прогона задаются
в **нормированных единицах** (concept.md §6 С2): ``voxel_norm`` — доля от
диаметра области поиска (``SEARCH_DIAMETER_MM``, та же сфера, где лежат все
точки быстрого расчёта), в паспорт попадают и доля, и миллиметры с базисом.
**Устойчивость по поддиапазонам** (``cluster_stability``) — «тот же» кластер
соседней полосы = центроид в пределах диагонали вокселя; метрика — доля полос
пакета, где такой кластер найден.

Порядок следования кластеров — по убыванию числа точек (крупные первыми).
"""
import math
from collections import defaultdict
from typing import Any

import numpy as np

from app.core.config import Settings
from app.services.cluster_features import feature_profile
from app.services.dipole_scanner import GRID_RADIUS_MM

# Топ доминирующих ROI кластера (подпись «к чему относится кластер»)
TOP_ROI_IN_CLUSTER = 3

# Диаметр области поиска быстрого расчёта, мм — нормировочная база параметров
# кластеризации прогона (С2): все точки `fast_grid` лежат внутри сферы
# `GRID_RADIUS_MM`, поэтому доли от диаметра сравнимы между прогонами и
# полосами, а мм — производные (в паспорте рядом).
SEARCH_DIAMETER_MM = 2.0 * GRID_RADIUS_MM

# Базис нормировки параметров кластеризации (в паспорте каждого числа).
CLUSTER_NORM_BASIS = "share_of_search_sphere_diameter"


def cluster_params(cfg: Settings) -> dict[str, Any]:
    """Паспорт кластеризации: параметры, задающие числа (concept §11.3)."""
    return {
        "voxel_mm": float(cfg.group_cluster_voxel_mm),
        "min_points": int(cfg.group_cluster_min_points),
        "connectivity": 26,  # 8 ячеек в 2D-слое × 3 слоя (scipy label)
    }


def resolve_cluster_params(voxel_norm: float, min_points: int) -> dict[str, Any]:
    """Паспорт кластеризации прогона (С2) из нормированных единиц.

    ``voxel_norm`` — доля от диаметра области поиска (``SEARCH_DIAMETER_MM``);
    в паспорте живут и доля, и миллиметры, и базис — числа без базиса не
    подписываем (``docs/data-blocks.md`` §2.2). Проверки параметров — форма
    (``api/params.py``), здесь только честный перевод.
    """
    voxel_mm = float(voxel_norm) * SEARCH_DIAMETER_MM
    return {
        "voxel_norm": float(voxel_norm),
        "voxel_mm": round(voxel_mm, 3),
        "min_points": int(min_points),
        "connectivity": 26,
        "basis": CLUSTER_NORM_BASIS,
        "basis_mm": SEARCH_DIAMETER_MM,
    }


def cluster_points(
    points: list[dict[str, Any]], voxel_mm: float, min_points: int,
) -> list[dict[str, Any]]:
    """Кластеризует точки одной полосы; ``points`` — flat-словари с MNI.

    Каждая точка: ``{recording_id, mni: [x, y, z] | None, structure, area}``.
    Точки без MNI не участвуют (честный пропуск). Кластер меньше
    ``min_points`` отбрасывается — случайные скопления не показываем.
    """
    usable = [point for point in points if point.get("mni")]
    if len(usable) < int(min_points):
        return []
    voxel = float(voxel_mm)
    min_points = int(min_points)

    # Индексы ячеек сетки (без сдвига в начало: важны только различия)
    cells: dict[tuple[int, int, int], list[dict[str, Any]]] = defaultdict(list)
    for point in usable:
        x, y, z = point["mni"]
        key = (
            math.floor(float(x) / voxel),
            math.floor(float(y) / voxel),
            math.floor(float(z) / voxel),
        )
        cells[key].append(point)

    # Связные компоненты по занятым ячейкам (26-связность, как DBSCAN-объединение)
    from scipy import ndimage  # лениво: тяжёлый импорт не мешает читке БД

    keys = list(cells)
    mins = [min(key[axis] for key in keys) for axis in range(3)]
    shape = [max(key[axis] for key in keys) - mins[axis] + 1 for axis in range(3)]
    mask = np.zeros(shape, dtype=bool)
    for key in keys:
        index = tuple(key[axis] - mins[axis] for axis in range(3))
        mask[index] = True
    structure = np.ones((3, 3, 3), dtype=bool)  # 26-связность
    labels, _total = ndimage.label(mask, structure=structure)

    # Сборка кластеров из ячеек одной метки
    clusters: dict[int, dict[str, Any]] = {}
    for key in keys:
        index = tuple(key[axis] - mins[axis] for axis in range(3))
        label = int(labels[index])
        if label == 0:
            continue  # не занято (не бывает, но безопасно)
        cluster = clusters.setdefault(label, {"points": [], "cells": 0})
        cluster["cells"] += 1
        cluster["points"].extend(cells[key])

    voxel_cm3 = (voxel / 10.0) ** 3
    total = len(usable)
    results: list[dict[str, Any]] = []
    for cluster in clusters.values():
        cluster_points = cluster["points"]
        if len(cluster_points) < min_points:
            continue  # случайное скопление — не кластер
        xs = [float(point["mni"][0]) for point in cluster_points]
        ys = [float(point["mni"][1]) for point in cluster_points]
        zs = [float(point["mni"][2]) for point in cluster_points]
        sessions = {
            str(point.get("recording_id") or "")
            for point in cluster_points
            if point.get("recording_id")
        }
        structures: dict[str, int] = defaultdict(int)
        areas: dict[str, int] = defaultdict(int)
        for point in cluster_points:
            if point.get("structure"):
                structures[str(point["structure"])] += 1
            if point.get("area"):
                areas[str(point["area"])] += 1

        def _top(table: dict[str, int]) -> list[str]:
            ordered = sorted(table, key=lambda name: (-table[name], name))
            return ordered[:TOP_ROI_IN_CLUSTER]

        volume = cluster["cells"] * voxel_cm3
        results.append({
            "centroid_mni": [
                round(sum(xs) / len(xs), 1),
                round(sum(ys) / len(ys), 1),
                round(sum(zs) / len(zs), 1),
            ],
            "n_points": len(cluster_points),
            "n_sessions": len(sessions),
            "session_share": (len(sessions) / len({
                str(point.get("recording_id") or "")
                for point in usable if point.get("recording_id")
            })) if usable else 0.0,
            "volume_cm3": round(volume, 2),
            "density_per_cm3": round(len(cluster_points) / volume, 1) if volume else None,
            "share": len(cluster_points) / total if total else 0.0,
            "extent_mm": [
                round(max(xs) - min(xs), 1),
                round(max(ys) - min(ys), 1),
                round(max(zs) - min(zs), 1),
            ],
            "top_structures": _top(structures),
            "top_brodmann": _top(areas),
            # Профиль признаков (исследовательский слой): характерные черты
            # кластера — состав/сила/качество/КД/компактность того, что измерено
            # в точках (cluster_features.py; не измерено — None).
            "features": feature_profile(cluster_points, total=total),
        })
    results.sort(key=lambda item: (-item["n_points"], item["centroid_mni"]))
    return results


def cluster_dipoles(
    points: list[dict[str, Any]], cfg: Settings,
) -> list[dict[str, Any]]:
    """Групповая кластеризация (остаток 4.7): параметры из конфига группы.

    Обёртка над ``cluster_points`` — прежний контракт ``POST /group/aggregate``
    сохранён, а ядро теперь общее с прогоном пакета (С2).
    """
    return cluster_points(
        points, float(cfg.group_cluster_voxel_mm), int(cfg.group_cluster_min_points),
    )


def cluster_stability(
    clusters_by_band: dict[str, list[dict[str, Any]]], voxel_mm: float,
) -> dict[str, dict[str, Any]]:
    """Устойчивость кластеров по поддиапазонам (С2, B8).

    «Тот же» кластер соседней полосы — центроид в пределах **диагонали вокселя**
    (единственная производная от параметров кластеризации, без новых порогов).
    Для каждого кластера ``(band_key, cluster_index)`` возвращается метрика:

    * ``n_bands_matched`` — в скольких полосах пакета найден кластер той же
      области (включая свою полосу);
    * ``band_share`` — доля этих полос от числа полос пакета (нормированная
      величина — единственная сравнимая между пакетами разного состава);
    * ``matched_band_keys`` — какие именно полосы.

    GOF между полосами не сравним (принцип 3 ``docs/rules/dipoles.md``), поэтому
    устойчивость считается **только по геометрии** (совпадение областей), без
    взвешивания по GOF.
    """
    band_keys = list(clusters_by_band)
    radius_mm = float(voxel_mm) * math.sqrt(3.0)
    matched: dict[tuple[str, int], list[str]] = {
        (band_key, index): []
        for band_key, clusters in clusters_by_band.items()
        for index in range(len(clusters))
    }
    for band_key, clusters in clusters_by_band.items():
        for index, cluster in enumerate(clusters):
            centroid = np.asarray(cluster.get("centroid_mni") or [], dtype=float)
            if centroid.size != 3:
                continue
            hits: list[str] = []
            for other_key, other_clusters in clusters_by_band.items():
                for other in other_clusters:
                    other_centroid = np.asarray(
                        other.get("centroid_mni") or [], dtype=float,
                    )
                    if other_centroid.size != 3:
                        continue
                    if float(np.linalg.norm(centroid - other_centroid)) <= radius_mm:
                        hits.append(other_key)
                        break
            matched[(band_key, index)] = sorted(set(hits))

    total_bands = max(1, len(band_keys))
    return {
        f"{band_key}:{index}": {
            "band_key": band_key,
            "cluster_index": index,
            "n_bands_matched": len(keys),
            "band_share": len(keys) / total_bands,
            "matched_band_keys": keys,
        }
        for (band_key, index), keys in matched.items()
    }
