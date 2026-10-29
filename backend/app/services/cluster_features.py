"""Профиль признаков кластера — исследовательский слой (29.10.2026).

Признаки кластеров **ищем сами** (Принцип 2.2 ``concept.md``: «collect and
interpret data; identify patterns»): это не входные пороги от эксперта, а
описательная статистика того, что **измерено** в точках кластера. Задача
профиля — показать характерные черты любого скопления данных на старте
исследования, чтобы паттерны были видны и превращались в проверяемые
гипотезы («N из M», ``hypothesis_check``).

Универсальность: ``feature_profile`` работает на **любых** строках данных
(словарь «ключ → значение»): диполи — сейчас; кластеры эпох, событий, проб —
когда появятся их данные. Считается только измеренное; неизмерённое —
``None`` («не измерено»), никогда 0 (``docs/rules/results-db.md`` §8.4 п.5).

Признаки профиля:

* ``n_points`` / ``share`` — размер кластера и доля выборки (``total``);
* **анатомия**: ``structure_share`` — топ-3 структур **с долями** («монокультурность»
  состава; доли — среди точек с определённой структурой), ``structure_entropy`` —
  нормированная энтропия 0…1 (0 — одна структура, 1 — много равных),
  ``hemisphere_share`` — левое/правое по **знаку** x MNI (x = 0 — срединная
  линия; пороги не изобретаются);
* **сила**: ``moment_sum_nam`` / ``moment_mean_nam`` / ``moment_max_nam`` из
  ``amplitude_nam`` точек;
* **качество**: ``gof_median`` / ``gof_min`` из ``gof`` — внутри своего набора
  (принцип 3 ``docs/rules/dipoles.md``: GOF между полосами не сравниваем);
* **КД**: ``n_kd_evaluated`` / ``n_kd_passed`` / ``kd_pass_share`` — доля
  прошедших **среди оценённых**; вердиктов нет у всех — честный ``None``;
* **геометрия**: ``radius_rms_mm`` — RMS-радиус точек от центроида
  (компактность скопления).
"""
from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping, Sequence
from statistics import median
from typing import Any

# Топ структур в профиле состава (доминирующие + «хвост» виден по энтропии)
TOP_STRUCTURES_IN_PROFILE = 3


def _round(value: float | None, digits: int) -> float | None:
    """Округление измеренного; ``None`` проходит как «не измерено»."""
    return None if value is None else round(float(value), digits)


def feature_profile(
    points: Sequence[Mapping[str, Any]],
    *,
    total: int | None = None,
) -> dict[str, Any] | None:
    """Профиль признаков кластера; ``None`` — кластер пуст (считать нечего).

    ``total`` — размер выборки, из которой сложился кластер (для ``share``);
    не задан — ``share`` честно ``None``. Строки данных произвольны: ключи
    ``structure``/``mni``/``amplitude_nam``/``gof``/``kd_passed`` читаются,
    если есть, иначе соответствующие признаки — ``None``.
    """
    rows = list(points)
    if not rows:
        return None

    # --- анатомия состава ---
    structures = Counter(
        str(row["structure"]) for row in rows if row.get("structure")
    )
    n_structured = sum(structures.values())
    structure_share: list[dict[str, Any]] | None = None
    structure_entropy: float | None = None
    if n_structured:
        structure_share = [
            {"name": name, "share": round(count / n_structured, 3)}
            for name, count in sorted(
                structures.items(), key=lambda item: (-item[1], item[0]),
            )[:TOP_STRUCTURES_IN_PROFILE]
        ]
        k = len(structures)
        if k > 1:
            entropy = -sum(
                (count / n_structured) * math.log(count / n_structured)
                for count in structures.values()
            )
            structure_entropy = round(entropy / math.log(k), 3)
        else:
            structure_entropy = 0.0

    # --- полушария: только знак x MNI (x = 0 — срединная линия) ---
    hemisphere_share: dict[str, float] | None = None
    xs = [
        float(row["mni"][0])
        for row in rows
        if isinstance(row.get("mni"), (list, tuple)) and len(row["mni"]) == 3
    ]
    if xs:
        counts = {"left": 0, "midline": 0, "right": 0}
        for x in xs:
            counts["left" if x < 0 else "right" if x > 0 else "midline"] += 1
        hemisphere_share = {
            name: round(count / len(xs), 3) for name, count in counts.items()
        }

    # --- сила момента (нАм) ---
    amplitudes = [
        float(row["amplitude_nam"])
        for row in rows
        if isinstance(row.get("amplitude_nam"), (int, float))
    ]

    # --- качество GOF (внутри набора) ---
    gofs = sorted(
        float(row["gof"]) for row in rows
        if isinstance(row.get("gof"), (int, float))
    )

    # --- КД: доля прошедших среди оценённых (не измерено ≠ 0) ---
    evaluated = [row for row in rows if row.get("kd_passed") is not None]
    n_kd_passed = sum(1 for row in evaluated if row.get("kd_passed"))

    # --- компактность: RMS-радиус от центроида, мм ---
    radius_rms_mm: float | None = None
    if len(xs) == len(rows) and xs:
        coords = [tuple(float(v) for v in row["mni"]) for row in rows]
        centroid = [
            sum(coord[axis] for coord in coords) / len(coords) for axis in range(3)
        ]
        radius_rms_mm = _round(math.sqrt(sum(
            sum((coord[axis] - centroid[axis]) ** 2 for axis in range(3))
            for coord in coords
        ) / len(coords)), 1)

    return {
        "n_points": len(rows),
        "share": (
            round(len(rows) / total, 3)
            if isinstance(total, int) and total > 0 else None
        ),
        "structure_share": structure_share,
        "structure_entropy": structure_entropy,
        "hemisphere_share": hemisphere_share,
        "moment_sum_nam": _round(sum(amplitudes), 1) if amplitudes else None,
        "moment_mean_nam": _round(sum(amplitudes) / len(amplitudes), 1)
        if amplitudes else None,
        "moment_max_nam": _round(max(amplitudes), 1) if amplitudes else None,
        "gof_median": _round(median(gofs), 3) if gofs else None,
        "gof_min": _round(gofs[0], 3) if gofs else None,
        "n_kd_evaluated": len(evaluated),
        "n_kd_passed": n_kd_passed,
        "kd_pass_share": (
            round(n_kd_passed / len(evaluated), 3) if evaluated else None
        ),
        "radius_rms_mm": radius_rms_mm,
    }