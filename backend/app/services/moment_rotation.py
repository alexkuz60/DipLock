"""Доля вращения момента по тройкам траектории (срез 2 слоя «признаки»).

Определение (выбрано владельцем 29.10.2026, «взгляд снаружи», сфера):

* траектория — кончики единичных моментов Q₁..Qₙ своей полосы в порядке эпох
  (знаки уже стабилизированы цепочкой ``dot(Qᵢ, Qᵢ₋₁) ≥ 0`` —
  ``stabilize_moment_signs``; точки без момента цепочку перепрыгивают);
* **тройка** — три подряд идущие точки (Qᵢ, Qᵢ₊₁, Qᵢ₊₂); знак тройки — знак
  тройного произведения ``V = Qᵢ · (Qᵢ₊₁ × Qᵢ₊₂)``: ``V > 0`` — поворот
  **против часовой** (CCW) при взгляде **снаружи** сферы, ``V < 0`` — по
  часовой (CW). Ось наблюдения не выбирается — инвариантно к повороту головы
  (знак совпадает с ориентацией плоского треугольника тройки при взгляде
  снаружи: ``A · (Qᵢ+Qᵢ₊₁+Qᵢ₊₂) = 3V``);
* «плоские» тройки — **с определённым знаком** (``|V| ≥ TRIPLE_EPS``):
  вырожденные (коллинеарные кончики, векторы в одной плоскости с началом
  координат) знака не имеют и в знаменатель не входят;
* доли считаются **среди плоских троек**: ``rotation_ccw_share`` +
  ``rotation_cw_share`` = 1, ``rotation_triples`` — их число (знаменатель).
  Плоских троек нет — честные ``None``, а не нули.

Момент — только направление: вращение позиции диполя — другая метрика
(срез 3, ``flow_metrics``), сюда не входит.
"""
import math
from typing import Any

# |V| ниже — тройка вырождена (единичные векторы дают V ∈ [−1; 1]): знака
# вращения у неё нет, в знаменатель долей такие тройки не входят.
TRIPLE_EPS = 1e-9


def _unit_vector(moment: Any) -> tuple[float, float, float] | None:
    """Единичный вектор момента точки; ``None`` — момента нет или он нулевой.

    Нормировка не меняет знак тройного произведения, но держит ``V`` в [−1; 1],
    с чем сравнивается ``TRIPLE_EPS``.
    """
    if not isinstance(moment, (list, tuple)) or len(moment) != 3:
        return None
    try:
        x, y, z = float(moment[0]), float(moment[1]), float(moment[2])
    except (TypeError, ValueError):
        return None
    norm = math.sqrt(x * x + y * y + z * z)
    if norm <= TRIPLE_EPS:
        return None
    return x / norm, y / norm, z / norm


def _triple_product(
    a: tuple[float, float, float],
    b: tuple[float, float, float],
    c: tuple[float, float, float],
) -> float:
    """``V = a · (b × c)``: знак — ориентация тройки при взгляде снаружи сферы."""
    cross_x = b[1] * c[2] - b[2] * c[1]
    cross_y = b[2] * c[0] - b[0] * c[2]
    cross_z = b[0] * c[1] - b[1] * c[0]
    return a[0] * cross_x + a[1] * cross_y + a[2] * cross_z


def moment_rotation_shares(points: list[dict[str, Any]]) -> dict[str, Any]:
    """Доли CW/CCW по «плоским» тройкам траектории момента одной полосы.

    ``points`` — точки полосы (плоские словари ``DipoleScanPointOut``) в
    порядке эпох; момент берётся из поля ``moment`` (``[x, y, z]``, знак уже
    стабилизирован). Возвращает ``rotation_ccw_share``/``rotation_cw_share``
    (доли 0…1 среди плоских троек) и ``rotation_triples`` (знаменатель);
    меньше одной плоской тройки — все три поля ``None``.
    """
    vectors = [
        vector
        for vector in (_unit_vector(point.get("moment")) for point in points)
        if vector is not None
    ]
    n_ccw = n_cw = 0
    for index in range(len(vectors) - 2):
        v = _triple_product(vectors[index], vectors[index + 1], vectors[index + 2])
        if v > TRIPLE_EPS:
            n_ccw += 1
        elif v < -TRIPLE_EPS:
            n_cw += 1
    total = n_ccw + n_cw
    if total == 0:
        return {
            "rotation_ccw_share": None,
            "rotation_cw_share": None,
            "rotation_triples": None,
        }
    return {
        "rotation_ccw_share": n_ccw / total,
        "rotation_cw_share": n_cw / total,
        "rotation_triples": total,
    }