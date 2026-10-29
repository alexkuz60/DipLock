"""Доля вращения момента (срез 2): знак тройки — взгляд снаружи сферы.

Определение (владелец, 29.10.2026): ``V = Qᵢ · (Qᵢ₊₁ × Qᵢ₊₂)``; ``V > 0`` —
поворот против часовой (CCW) при взгляде снаружи, ``V < 0`` — по часовой
(CW); вырожденные тройки (``|V| < TRIPLE_EPS``) знака не имеют и в знаменатель
не входят. Проверяется и математика, и её место в агрегате полосы.
"""
import math

from app.services.moment_rotation import moment_rotation_shares

_X = {"moment": [1.0, 0.0, 0.0]}
_Y = {"moment": [0.0, 1.0, 0.0]}
_Z = {"moment": [0.0, 0.0, 1.0]}


def _points(*moments: list[float]) -> list[dict]:
    return [{"moment": list(m)} for m in moments]


def test_ccw_triple_viewed_from_outside():
    """x→y→z: V = +1 — поворот против часовой при взгляде снаружи."""
    result = moment_rotation_shares([_X, _Y, _Z])
    assert result == {
        "rotation_ccw_share": 1.0,
        "rotation_cw_share": 0.0,
        "rotation_triples": 1,
    }


def test_cw_triple_viewed_from_outside():
    """x→z→y: V = −1 — поворот по часовой."""
    result = moment_rotation_shares(_points([1, 0, 0], [0, 0, 1], [0, 1, 0]))
    assert result == {
        "rotation_ccw_share": 0.0,
        "rotation_cw_share": 1.0,
        "rotation_triples": 1,
    }


def test_shares_of_mixed_sequence():
    """x, y, z, x, z, y: тройки +1, +1, 0 (вырождена), −1 → 2/3 и 1/3."""
    result = moment_rotation_shares(_points(
        [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1], [0, 1, 0],
    ))
    assert result["rotation_ccw_share"] == 2 / 3
    assert result["rotation_cw_share"] == 1 / 3
    assert result["rotation_triples"] == 3


def test_degenerate_triples_have_no_sense():
    """Коллинеарные и «плоские» (векторы в плоскости с началом) тройки — мимо."""
    # Коллинеарные кончики: V = 0
    assert moment_rotation_shares([_X, _X, _X])["rotation_triples"] is None
    # x, y, (x+y)/√2 — векторы лежат в плоскости z = 0 с началом координат: V = 0
    diagonal = [math.sqrt(0.5), math.sqrt(0.5), 0.0]
    assert moment_rotation_shares(_points([1, 0, 0], [0, 1, 0], diagonal))[
        "rotation_triples"
    ] is None


def test_broken_points_are_skipped_without_breaking_chain():
    """Точки без момента перепрыгиваются (как в `stabilize_moment_signs`)."""
    result = moment_rotation_shares([
        _X, {"moment": None}, _Y, {"moment": [0, 0, 0]}, _Z,
    ])
    assert result == {
        "rotation_ccw_share": 1.0,
        "rotation_cw_share": 0.0,
        "rotation_triples": 1,
    }


def test_short_or_empty_trajectory_is_honest_none():
    """Меньше одной плоской тройки — честные None, а не нули."""
    empty = {
        "rotation_ccw_share": None,
        "rotation_cw_share": None,
        "rotation_triples": None,
    }
    assert moment_rotation_shares([]) == empty
    assert moment_rotation_shares([_X]) == empty
    assert moment_rotation_shares([_X, _Y]) == empty


def test_unit_normalization_keeps_sign():
    """Масштаб момента (амплитуда) не меняет знак — только направление."""
    scaled = moment_rotation_shares(_points([5, 0, 0], [0, 3, 0], [0, 0, 2]))
    assert scaled["rotation_ccw_share"] == 1.0