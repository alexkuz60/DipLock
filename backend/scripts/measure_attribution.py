"""Замер атрибуции диполей (шаг 1.4, N21): расстояния, потолки, «вне мозга».

Считает по точкам уже сохранённых задач (``results_dir/jobs/*.json``) —
**без пересчёта EDF**:

* расстояние от точки до ближайшей размеченной метки ``aparc+aseg`` (структура)
  и до ближайшего узла объёмного атласа полей Бродмана (``volumes.areas``);
* попадание в маску мозга ``brainmask.mgz`` и расстояние до мозга у точек вне неё;
* таблица «потолков» радиуса атрибуции (5/10/15/25/∞ мм) — сколько точек
  получает структуру и поле на каждом потолке;
* сравнение записанной атрибуции ``brodmann_area`` из jobs.json (её считал центроидный ``_find_ba``):
  сколько точек получило бы **другое** поле и сколько получает метку, находясь
  вне мозга.

Зачем: N21 — одна и та же точка получает поле Бродмана двумя разными
способами (таблица — ближайший центр PALS, срез — объёмный атлас). Замер
определяет потолок расстояния **по данным**, а не a priori, и фиксирует ценность
признака «вне мозга» вместо прочерка/выдуманной метки.

Запуск:
    backend/venv/bin/python backend/scripts/measure_attribution.py
    backend/venv/bin/python backend/scripts/measure_attribution.py --json /tmp/measure.json
"""
import argparse
import json
import os
import sys
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

import nibabel as nib
import numpy as np
from scipy.spatial import cKDTree

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:  # запуск файлом, а не модулем
    sys.path.insert(0, _BACKEND_DIR)

from app.core.config import settings  # noqa: E402
from app.services import atlas_contours as contours  # noqa: E402
from app.services import job_store  # noqa: E402
from app.services.asset_versions import MRI_BOUNDS, MRI_STAMP_RELATIVE  # noqa: E402

# Потолки радиуса атрибуции, мм; ``None`` — без потолка (ближайший узел всегда).
CAPS_MM: tuple[float | None, ...] = (5.0, 10.0, 15.0, 25.0, None)


@dataclass
class PointRow:
    """Одна точка диполя и все измеренные по ней расстояния."""

    job_id: str
    epoch_index: int
    mni: tuple[float, float, float]
    outside_brain: bool
    brain_distance_mm: float
    structure_exact: bool
    structure_distance_mm: float
    structure_name: str | None
    area_distance_mm: float
    area_name: str | None
    recorded_area_name: str | None


def load_points() -> list[dict[str, Any]]:
    """Точки диполей с MNI из файлов задач (``kind='dipoles'``)."""
    points: list[dict[str, Any]] = []
    for record in job_store.load_records(settings):
        result = record.get("result") or {}
        job_id = str(record.get("job_id") or "")
        for point in result.get("points") or []:
            mni = point.get("mni_coords")
            if not mni or len(mni) != 3:
                continue
            points.append(
                {
                    "job_id": job_id,
                    "epoch_index": point.get("epoch_index"),
                    "mni": tuple(float(value) for value in mni),
                    "recorded_area": point.get("brodmann_area"),
                    "method": result.get("method"),
                    "grid_mm": result.get("grid_mm"),
                }
            )
    return points


def node_tree(volume: np.ndarray, spacing_mm: float) -> tuple[cKDTree, np.ndarray]:
    """KD-дерево ненулевых узлов объёма (MNI-мм) и их значений (в порядке дерева)."""
    nz = np.nonzero(volume)
    coords = np.column_stack(
        [
            MRI_BOUNDS[axis][0] + nz[position].astype(np.float64) * spacing_mm
            for position, axis in enumerate(("x", "y", "z"))
        ]
    )
    return cKDTree(coords), volume[nz]


def brain_mask_volume() -> np.ndarray:
    """Маска мозга ``brainmask.mgz`` на MNI-сетке 1 мм (та же укладка, что у срезов)."""
    path = os.path.join(str(settings.subjects_dir), MRI_STAMP_RELATIVE[1])
    image = nib.load(path)
    return contours._resample_nearest(np.asanyarray(image.dataobj) > 0, image.affine)


def measure(points: Sequence[dict[str, Any]]) -> list[PointRow]:
    """Считает по всем точкам расстояния до структур/полей и попадание в маску."""
    volumes = contours.load_volumes(contours._ContourCtx.from_settings(settings))
    spacing = volumes.spacing_mm
    struct_tree, struct_labels = contours._structure_tree(volumes)
    area_tree, area_ids = node_tree(volumes.areas, spacing)
    brain_tree, _ = node_tree(brain_mask_volume(), spacing)

    rows: list[PointRow] = []
    for point in points:
        mni = np.asarray(point["mni"], dtype=np.float64)
        struct_dist, struct_index = struct_tree.query(mni)
        area_dist, area_index = area_tree.query(mni)
        brain_dist, _ = brain_tree.query(mni)
        indices = [
            contours._axis_index(axis, value, spacing)
            for axis, value in zip(("x", "y", "z"), mni, strict=True)
        ]
        exact_id = 0
        if all(index is not None for index in indices):
            x, y, z = (int(index) for index in indices)  # type: ignore[arg-type]
            exact_id = int(volumes.structures[x, y, z])
        area_id = int(area_ids[area_index])
        rows.append(
            PointRow(
                job_id=str(point["job_id"]),
                epoch_index=int(point["epoch_index"] or 0),
                mni=(float(mni[0]), float(mni[1]), float(mni[2])),
                # Точка вне мозга: ближайший узел маски дальше 1 мм (диагональ
                # вокселя 0.87 мм — запас на «полувоксельное» смещение).
                outside_brain=bool(brain_dist > 1.0),
                brain_distance_mm=float(brain_dist),
                structure_exact=exact_id != 0,
                structure_distance_mm=float(struct_dist),
                structure_name=volumes.structure_names.get(int(struct_labels[struct_index])),
                area_distance_mm=float(area_dist),
                area_name=volumes.area_names.get(area_id),
                recorded_area_name=point.get("recorded_area"),
            )
        )
    return rows


def _percentiles(values: Sequence[float]) -> str:
    """Мин/медиана/p90/max одной строкой (пусто — значений нет)."""
    if not values:
        return "—"
    data = np.asarray(values, dtype=np.float64)
    return (
        f"min={data.min():.1f}  медиана={np.percentile(data, 50):.1f}  "
        f"p90={np.percentile(data, 90):.1f}  max={data.max():.1f}"
    )


def _cap_label(cap: float | None) -> str:
    return "без потолка" if cap is None else f"{cap:.0f} мм"


def _cap_table(title: str, rows: Sequence[PointRow]) -> None:
    """Таблица потолков: сколько точек получает структуру и поле на радиусе."""
    total = len(rows)
    print(f"\n{title} (точек: {total})")
    print(f"{'потолок':>12} | {'структура':>18} | {'поле Бродмана':>18}")
    for cap in CAPS_MM:
        n_struct = sum(1 for r in rows if cap is None or r.structure_distance_mm <= cap)
        n_area = sum(1 for r in rows if cap is None or r.area_distance_mm <= cap)
        print(
            f"{_cap_label(cap):>12} | "
            f"{n_struct:>5} из {total:<3} {100.0 * n_struct / total:4.1f}% | "
            f"{n_area:>5} из {total:<3} {100.0 * n_area / total:4.1f}%"
        )


def report(rows: Sequence[PointRow]) -> None:
    """Печатает сводку: расстояния, маска мозга, потолки, сравнение с ``_find_ba``."""
    total = len(rows)
    outside = [r for r in rows if r.outside_brain]
    inside = [r for r in rows if not r.outside_brain]
    misses = [r for r in rows if not r.structure_exact]

    print("=" * 72)
    print(f"Точек с MNI: {total}   (внутри brainmask: {len(inside)}, вне мозга: {len(outside)})")
    if outside:
        zs = [r.mni[2] for r in outside]
        print(
            f"  вне мозга: z ∈ [{min(zs):.0f}…{max(zs):.0f}] мм, "
            f"расстояние до мозга: {_percentiles([r.brain_distance_mm for r in outside])}"
        )

    print("\n-- Расстояние до структуры (aparc+aseg), мм --")
    print(f"  точная ячейка размечена: {sum(1 for r in rows if r.structure_exact)} из {total}")
    print(f"  все точки:             {_percentiles([r.structure_distance_mm for r in rows])}")
    print(f"  промахи точной ячейки: {_percentiles([r.structure_distance_mm for r in misses])}")
    print(f"  вне мозга:             {_percentiles([r.structure_distance_mm for r in outside])}")

    print("\n-- Расстояние до узла поля Бродмана (объём volumes.areas), мм --")
    print(f"  все точки: {_percentiles([r.area_distance_mm for r in rows])}")
    print(f"  вне мозга: {_percentiles([r.area_distance_mm for r in outside])}")

    _cap_table("Потолок радиуса — все точки", rows)
    _cap_table("Потолок радиуса — только вне мозга", outside)

    print("\n-- Сравнение с центроидным _find_ba (ближайший центр PALS) --")
    full = same_number = 0
    disagreements: dict[tuple[str, str], int] = {}
    for r in rows:
        volume_name = r.area_name  # ближайший узел объёма, без потолка
        if r.recorded_area_name == volume_name:
            full += 1
            same_number += 1
        elif (
            r.recorded_area_name
            and volume_name
            and r.recorded_area_name.split("-")[0] == volume_name.split("-")[0]
        ):
            same_number += 1
        else:
            key = (r.recorded_area_name or "—", volume_name or "—")
            disagreements[key] = disagreements.get(key, 0) + 1
    print(f"  поле совпало (номер + полушарие): {full} из {total} ({100.0 * full / total:.1f}%)")
    print(
        f"  совпало по номеру поля:          {same_number} из {total} "
        f"({100.0 * same_number / total:.1f}%)"
    )
    print("  частые расхождения (_find_ba → объём):")
    for (old, new), count in sorted(disagreements.items(), key=lambda item: -item[1])[:10]:
        print(f"    {count:>4}×  {old} → {new}")

    print("\n-- Ценность признака «вне мозга» --")
    tagged_outside = sum(1 for r in outside if r.recorded_area_name)
    print(f"  _find_ba ставит метку у точек вне мозга: {tagged_outside} из {len(outside)}")
    print(
        f"  объёмный ближайший узел:                 "
        f"{sum(1 for r in outside if r.area_name)} из {len(outside)}"
    )
    print("  (метка у точки вне мозга — выдуманная атрибуция; честный ответ —")
    print("   «вне мозга, ~N мм до <структура>» с расстоянием из таблицы выше)")
    print("=" * 72)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Замер атрибуции диполей: расстояния до структур/полей, потолки, «вне мозга»"
        )
    )
    parser.add_argument(
        "--json",
        dest="json_path",
        metavar="ПУТЬ",
        help="дополнительно сохранить построчные измерения в JSON",
    )
    args = parser.parse_args(argv)

    points = load_points()
    if not points:
        print("Нет точек с MNI в файлах задач (results_dir/jobs) — замерять нечего.")
        return 1
    jobs = sorted({(p["job_id"], p["method"], p["grid_mm"]) for p in points})
    print("Источники (файлы задач kind='dipoles'):")
    for job_id, method, grid in jobs:
        n = sum(1 for p in points if p["job_id"] == job_id)
        print(f"  {job_id}  method={method} grid_mm={grid}  точек: {n}")

    rows = measure(points)
    report(rows)

    if args.json_path:
        with open(args.json_path, "w", encoding="utf-8") as fh:
            json.dump([asdict(row) for row in rows], fh, ensure_ascii=False, indent=1)
        print(f"\nПострочные измерения: {args.json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
