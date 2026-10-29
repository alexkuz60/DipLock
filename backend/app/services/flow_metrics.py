"""Магистраль потока и упорядоченность потока (срез 3 слоя «признаки»).

Определения (утверждены владельцем 29.10.2026):

* **магистраль потока** — топ-переходы структур по точкам траектории позиций:
  смежные точки траектории своей полосы в порядке эпох дают пары
  «структура → структура» (только **смены** структуры, ``from ≠ to``);
  неатрибутированные точки пар не дают и цепочку не рвут (как разрывы эпох —
  «Разрывы замедляют переход», 17.10.2026). Топ пар по числу переходов,
  доли — от всех переходов полосы;
* **упорядоченность потока** — ``R`` векторов смещения: ``dᵢ = pᵢ₊₁ − pᵢ``,
  ``R = |Σ dᵢ| / Σ |dᵢ|`` ∈ [0; 1] — нормированная длина равнодействующей
  (net displacement / path length): 1 — прямолинейный однонаправленный поток,
  0 — смещения гасят друг друга. Масштаб шагов учитывается (вес — длина).

Базис координат подписывается честно (``flow_basis``): ``mni`` — MNI
(``mni_coords``), ``head`` — система головы (``head_coords``, когда
MNI-наводки нет); смешивать системы в одной траектории нельзя. Не измерено
(точек мало, длина пути нулевая, переходов нет) — ``None``/пустой список,
а не нули.
"""
from collections import Counter
from typing import Any

# Топ переходов «структура → структура» в агрегате полосы (магистраль потока).
TOP_TRANSITIONS = 5

# Длина пути ниже — траектория стоит на месте: R не измерена, а не «0 порядка».
_PATH_EPS = 1e-9


def _coords(point: dict[str, Any], key: str) -> tuple[float, float, float] | None:
    """Координаты точки в одной системе; ``None`` — координат нет/они мусор."""
    raw = point.get(key)
    if not isinstance(raw, (list, tuple)) or len(raw) != 3:
        return None
    try:
        return float(raw[0]), float(raw[1]), float(raw[2])
    except (TypeError, ValueError):
        return None


def _orderliness(points: list[dict[str, Any]], key: str) -> tuple[float, int] | None:
    """R и число шагов по одной системе координат; ``None`` — не измерено.

    Вектор смещения — между **смежными** точками траектории, у которых есть
    координаты в этой системе (разрывы перепрыгиваются).
    """
    total = 0.0  # Σ |dᵢ| — полная длина пути
    sum_x = sum_y = sum_z = 0.0  # Σ dᵢ — равнодействующая
    steps = 0
    previous = None
    for point in points:
        current = _coords(point, key)
        if current is None:
            continue
        if previous is not None:
            dx, dy, dz = (
                current[0] - previous[0],
                current[1] - previous[1],
                current[2] - previous[2],
            )
            step = (dx * dx + dy * dy + dz * dz) ** 0.5
            total += step
            sum_x += dx
            sum_y += dy
            sum_z += dz
            steps += 1
        previous = current
    if steps == 0 or total <= _PATH_EPS:
        return None
    resultant = (sum_x * sum_x + sum_y * sum_y + sum_z * sum_z) ** 0.5
    return resultant / total, steps


def flow_orderliness(points: list[dict[str, Any]]) -> dict[str, Any]:
    """Упорядоченность потока (R векторов смещения) одной полосы.

    Возвращает ``flow_orderliness`` (R ∈ [0; 1]), ``flow_steps`` (число векторов
    смещения) и ``flow_basis`` (``mni`` | ``head``); не измерено — все три
    поля ``None``. Базис: MNI, если в нём посчиталось хотя бы один шаг,
    иначе система головы.
    """
    for key, basis in (("mni_coords", "mni"), ("head_coords", "head")):
        measured = _orderliness(points, key)
        if measured is not None:
            orderliness, steps = measured
            return {
                "flow_orderliness": orderliness,
                "flow_steps": steps,
                "flow_basis": basis,
            }
    return {"flow_orderliness": None, "flow_steps": None, "flow_basis": None}


def top_structure_transitions(
    points: list[dict[str, Any]], limit: int = TOP_TRANSITIONS,
) -> list[dict[str, Any]]:
    """Магистраль потока: топ переходов «структура → структура» полосы.

    Только **смены** структуры (``from ≠ to``); доли — от числа всех переходов.
    Сортировка — по числу переходов (убыв.), затем по паре — детерминированно.
    Пустой список — переходов нет (все точки в одной структуре/без атрибуции).
    """
    counts: Counter[tuple[str, str]] = Counter()
    previous: str | None = None
    for point in points:
        structure = point.get("anatomical_structure")
        if not structure:
            continue
        name = str(structure)
        if previous is not None and previous != name:
            counts[(previous, name)] += 1
        previous = name
    total = sum(counts.values())
    if total == 0:
        return []
    rows = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return [
        {
            "from_structure": from_name,
            "to_structure": to_name,
            "count": count,
            "share": count / total,
        }
        for (from_name, to_name), count in rows[: max(0, limit)]
    ]