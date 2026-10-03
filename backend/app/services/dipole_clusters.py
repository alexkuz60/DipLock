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

Порядок следования кластеров — по убыванию числа точек (крупные первыми).
"""
import math
from collections import defaultdict
from typing import Any

import numpy as np

from app.core.config import Settings

# Топ доминирующих ROI кластера (подпись «к чему относится кластер»)
TOP_ROI_IN_CLUSTER = 3


def cluster_params(cfg: Settings) -> dict[str, Any]:
    """Паспорт кластеризации: параметры, задающие числа (concept §11.3)."""
    return {
        "voxel_mm": float(cfg.group_cluster_voxel_mm),
        "min_points": int(cfg.group_cluster_min_points),
        "connectivity": 26,  # 8 ячеек в 2D-слое × 3 слоя (scipy label)
    }


def cluster_dipoles(
    points: list[dict[str, Any]], cfg: Settings,
) -> list[dict[str, Any]]:
    """Кластеризует точки одной полосы; ``points`` — flat-словари с MNI.

    Каждая точка: ``{recording_id, mni: [x, y, z] | None, structure, area}``.
    Точки без MNI не участвуют (честный пропуск). Кластер меньше
    ``min_points`` отбрасывается — случайные скопления не показываем.
    """
    usable = [point for point in points if point.get("mni")]
    if len(usable) < int(cfg.group_cluster_min_points):
        return []
    voxel = float(cfg.group_cluster_voxel_mm)
    min_points = int(cfg.group_cluster_min_points)

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
        })
    results.sort(key=lambda item: (-item["n_points"], item["centroid_mni"]))
    return results
