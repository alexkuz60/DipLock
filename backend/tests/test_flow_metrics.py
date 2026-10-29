"""Магистраль потока и упорядоченность (срез 3): R смещений и топ-переходы.

Определения (владелец, 29.10.2026): R = |Σ dᵢ| / Σ|dᵢ| по векторам смещения
траектории позиций (базис mni → head, без смешения систем); магистраль — топ
переходов «структура → структура» (только смены структуры, доли от всех
переходов). Проверяется и математика, и честность «не измерено».
"""
from app.services.flow_metrics import (
    TOP_TRANSITIONS,
    flow_orderliness,
    top_structure_transitions,
)


def _point(structure: str | None = None, mni=None, head=None) -> dict:
    return {
        "anatomical_structure": structure,
        "mni_coords": mni,
        "head_coords": head,
    }


# ---------- упорядоченность потока ----------

def test_straight_flow_is_fully_orderly():
    """Прямолинейный однонаправленный поток: R = 1."""
    points = [
        _point(mni=[0.0, 0.0, 0.0]),
        _point(mni=[1.0, 0.0, 0.0]),
        _point(mni=[3.0, 0.0, 0.0]),
    ]
    assert flow_orderliness(points) == {
        "flow_orderliness": 1.0,
        "flow_steps": 2,
        "flow_basis": "mni",
    }


def test_back_and_forth_flow_cancels_out():
    """Туда-обратно: равнодействующая нулевая — R = 0 (порядка нет)."""
    points = [
        _point(mni=[0.0, 0.0, 0.0]),
        _point(mni=[1.0, 0.0, 0.0]),
        _point(mni=[0.0, 0.0, 0.0]),
        _point(mni=[1.0, 0.0, 0.0]),
        _point(mni=[0.0, 0.0, 0.0]),
    ]
    result = flow_orderliness(points)
    assert result["flow_orderliness"] == 0.0
    assert result["flow_steps"] == 4


def test_mixed_flow_orderliness_between_zero_and_one():
    """Смешанный поток: R = |Σd| / Σ|d| учитывает масштаб шагов."""
    # d = (2,0,0), (−1,0,0): Σd = (1,0,0), Σ|d| = 3 → R = 1/3
    points = [
        _point(mni=[0.0, 0.0, 0.0]),
        _point(mni=[2.0, 0.0, 0.0]),
        _point(mni=[1.0, 0.0, 0.0]),
    ]
    result = flow_orderliness(points)
    assert result["flow_orderliness"] == 1 / 3
    assert result["flow_steps"] == 2


def test_mni_basis_preferred_and_head_fallback():
    """MNI — основной базис; без него — система головы, смешение запрещено."""
    mixed = [
        _point(mni=[0.0, 0.0, 0.0], head=[10.0, 0.0, 0.0]),
        _point(mni=[1.0, 0.0, 0.0], head=[20.0, 5.0, 0.0]),
    ]
    assert flow_orderliness(mixed)["flow_basis"] == "mni"
    head_only = [
        _point(head=[0.0, 0.0, 0.0]),
        _point(head=[0.0, 4.0, 0.0]),
    ]
    assert flow_orderliness(head_only)["flow_basis"] == "head"


def test_flow_not_measured_is_honest_none():
    """Мало точек / нулевой путь / нет координат — None, а не нули."""
    empty = {"flow_orderliness": None, "flow_steps": None, "flow_basis": None}
    assert flow_orderliness([]) == empty
    assert flow_orderliness([_point(mni=[1.0, 1.0, 1.0])]) == empty
    # Точки стоят на месте: длина пути нулевая — R не измерена
    still = [_point(mni=[1.0, 1.0, 1.0]), _point(mni=[1.0, 1.0, 1.0])]
    assert flow_orderliness(still) == empty


# ---------- магистраль потока ----------

def test_top_transitions_count_only_structure_changes():
    """Только смены структуры; доли — от всех переходов; сортировка детерминирована."""
    points = [
        _point("A"), _point("A"),  # A→A — не переход
        _point("B"), _point("C"), _point("B"), _point("C"),
        _point("B"),  # B→C дважды, C→B дважды, A→B один раз
    ]
    rows = top_structure_transitions(points)
    assert rows[0] == {"from_structure": "B", "to_structure": "C", "count": 2, "share": 0.4}
    assert rows[1] == {"from_structure": "C", "to_structure": "B", "count": 2, "share": 0.4}
    assert rows[2] == {"from_structure": "A", "to_structure": "B", "count": 1, "share": 0.2}
    assert len(rows) == 3


def test_unattributed_points_do_not_break_chain():
    """Точка без структуры пар не даёт и цепочку не рвёт (как разрывы эпох)."""
    points = [_point("A"), _point(None), _point("B")]
    assert top_structure_transitions(points) == [
        {"from_structure": "A", "to_structure": "B", "count": 1, "share": 1.0},
    ]


def test_no_transitions_is_empty_list():
    """Одна структура / нет атрибуции — магистрали нет (пустой список, не нули)."""
    assert top_structure_transitions([_point("A"), _point("A"), _point("A")]) == []
    assert top_structure_transitions([_point(None), _point(None)]) == []
    assert top_structure_transitions([]) == []


def test_top_limit_caps_the_list():
    """Топ ограничен константой TOP_TRANSITIONS (5 пар — как топы отчёта)."""
    names = [f"S{i}" for i in range(TOP_TRANSITIONS + 3)]
    points = [_point(name) for name in names for _ in range(2)]
    rows = top_structure_transitions(points)
    assert len(rows) == TOP_TRANSITIONS