"""ROI-анализ (4.5): агрегация дипольных точек по структурам и полям Бродмана.

Вход — точки пакета автоотчёта (``_package_points``, тот же контракт, что
пишется в ``dipole_points``), выход — агрегат «строка ROI × полосы» под
схему ``RoiAggregateOut``. Один источник для обоих носителей:

* HTML-отчёт («Итоги», секция «ROI-анализ») — точки в памяти ``run_report``;
* UI — поле ``roi`` результата задачи (вкладка «ROI», вид одного результата —
  запросов не делает, правило «правка не запускает расчёт»).

Правила чтения чисел (``docs/rules/dipoles.md``, принцип 3; подпись из §8.1
``docs/data-blocks.md`` «переносится в 4.5» — это она):

* **GOF и порог «надёжной точки» (``gof_threshold``) — только внутри полосы**:
  между полосами GOF не сравним (узкая полоса завышает R²), поэтому
  ``gof_pass``/``median_gof`` живут в ячейке своей полосы, а не в итоге строки.
* **Доля (``share``)** — доля точек полосы (одна точка на эпоху — пик GFP),
  чья лучшая локализация попала в ROI; знаменатель — число точек полосы,
  как в топах ``summarize_band``.
* **Полушарие** — производная от имени ROI (русские подписи ``atlas_contours``
  «(слева)»/«(справа)» и суффиксы ``BA17-lh``): асимметрия считается по
  анатомическим структурам суммой точек всех полос (числа точек сравнимы —
  это не GOF).
"""
from collections.abc import Mapping, Sequence
from statistics import median
from typing import Any

# Итоговые колонки полушарий в агрегате
HEMISPHERES: tuple[str, ...] = ("lh", "rh", "mid")


def hemisphere_of(name: str) -> str:
    """Полушарие ROI по имени: ``lh`` | ``rh`` | ``mid`` (срединная/непарная).

    Русские подписи структур оканчиваются на «(слева)»/«(справа)»
    (``atlas_contours._structure_names``, ``_ASEG_RU``), поля Бродмана — на
    ``-lh``/``-rh`` (``nearest_area``); английские фолбэки («ctx-lh-…») ловятся
    суффиксом. Всё остальное — срединная структура («ствол мозга»,
    «третий желудочек»).
    """
    if "(слева)" in name or "-lh" in name:
        return "lh"
    if "(справа)" in name or "-rh" in name:
        return "rh"
    return "mid"


def _median(values: list[float]) -> float | None:
    """Медиана списка; ``None`` — значений нет (не выдумываем ноль)."""
    return float(median(values)) if values else None


def _empty_band_cell() -> dict[str, Any]:
    return {
        "count": 0,
        "share": 0.0,
        "median_gof": None,
        "median_amplitude_nam": None,
        "gof_pass": 0,
    }


def aggregate_roi(
    points_by_band: Mapping[str, Sequence[Mapping[str, Any]]],
    band_order: Sequence[str],
    *,
    gof_threshold: float,
    top_n: int,
) -> dict[str, Any]:
    """Агрегат ROI «строка × полоса» из точек пакета (4.5).

    ``points_by_band`` — ``_package_points`` (ключ ``band_key`` → точки),
    ``band_order`` — порядок колонок (как в пакете). Строки обоих словарей
    обрезаются топ-``top_n`` по суммарному числу точек (в HTML/UI — топ, полный
    счёт остаётся в ``n_structure_names``/``n_brodmann_names``: §8.4.4 —
    «все имена» живут в БД, отображение — топ).
    """
    bands = [str(key) for key in band_order]
    # kind → имя → {полоса → точки той полосы}
    raw: dict[str, dict[str, dict[str, list[dict[str, Any]]]]] = {
        "structures": {},
        "brodmann": {},
    }
    n_points_by_band: dict[str, int] = {key: 0 for key in bands}
    n_points_total = 0
    hemisphere_counts = {key: 0 for key in HEMISPHERES}
    n_without_structure = 0

    for band_key in bands:
        for point in points_by_band.get(band_key) or ():
            n_points_by_band[band_key] += 1
            n_points_total += 1
            structure = point.get("anatomical_structure")
            area = point.get("brodmann_area")
            for kind, name in (("structures", structure), ("brodmann", area)):
                if name:
                    raw[kind].setdefault(str(name), {}).setdefault(
                        band_key, [],
                    ).append(dict(point))
            if structure:
                hemisphere_counts[hemisphere_of(str(structure))] += 1
            else:
                n_without_structure += 1

    def _rows(kind: str) -> tuple[list[dict[str, Any]], int]:
        table = raw[kind]
        totals = {
            name: sum(len(cells.get(key, ())) for key in bands)
            for name, cells in table.items()
        }
        ordered = sorted(totals, key=lambda name: (-totals[name], name))
        rows: list[dict[str, Any]] = []
        for name in ordered[:top_n]:
            cells: dict[str, Any] = {}
            for band_key in bands:
                points = table[name].get(band_key) or []
                denominator = n_points_by_band[band_key]
                gofs = [float(p["gof"]) for p in points if p.get("gof") is not None]
                amplitudes = [
                    float(p["amplitude_nam"])
                    for p in points if p.get("amplitude_nam") is not None
                ]
                cell = _empty_band_cell()
                cell["count"] = len(points)
                cell["share"] = len(points) / denominator if denominator else 0.0
                cell["median_gof"] = _median(gofs)
                cell["median_amplitude_nam"] = _median(amplitudes)
                # GOF ≥ порога — строго внутри своей полосы (принцип 3)
                cell["gof_pass"] = sum(gof >= gof_threshold for gof in gofs)
                cells[band_key] = cell
            rows.append({
                "name": name,
                "hemisphere": hemisphere_of(name),
                "count": totals[name],
                "bands": cells,
            })
        return rows, len(table)

    structures, n_structure_names = _rows("structures")
    brodmann, n_brodmann_names = _rows("brodmann")
    return {
        "gof_threshold": float(gof_threshold),
        "bands": bands,
        "n_points_total": n_points_total,
        "structures": structures,
        "brodmann": brodmann,
        "n_structure_names": n_structure_names,
        "n_brodmann_names": n_brodmann_names,
        "hemisphere_counts": hemisphere_counts,
        "n_without_structure": n_without_structure,
    }
