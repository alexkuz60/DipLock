"""Профиль признаков кластера (cluster_features, 29.10.2026): ищем характерное сами.

Признаки — описательная статистика измеренного: неизмерённое — ``None``
(«не измерено»), никогда 0; никаких порогов «значимости» извне нет —
значимость устанавливают данные и проверка гипотез.
"""
from app.services.cluster_features import feature_profile


def _row(**kwargs):
    row = {"mni": None, "structure": None, "amplitude_nam": None,
           "gof": None, "kd_passed": None}
    row.update(kwargs)
    return row


def test_profile_measures_what_is_measured():
    """Измеренное считается целиком: состав, сила, качество, КД, геометрия."""
    points = [
        _row(mni=[-20.0, 0.0, 0.0], structure="A", amplitude_nam=100.0,
             gof=0.9, kd_passed=1),
        _row(mni=[-10.0, 0.0, 0.0], structure="A", amplitude_nam=300.0,
             gof=0.8, kd_passed=0),
        _row(mni=[0.0, 0.0, 0.0], structure="B", amplitude_nam=200.0,
             gof=0.85, kd_passed=1),
    ]
    profile = feature_profile(points, total=10)
    assert profile is not None
    assert profile["n_points"] == 3
    assert profile["share"] == 0.3
    assert profile["structure_share"] == [
        {"name": "A", "share": 0.667}, {"name": "B", "share": 0.333},
    ]
    assert profile["moment_sum_nam"] == 600.0
    assert profile["moment_mean_nam"] == 200.0
    assert profile["moment_max_nam"] == 300.0
    assert profile["gof_median"] == 0.85
    assert profile["gof_min"] == 0.8
    assert profile["n_kd_evaluated"] == 3
    assert profile["n_kd_passed"] == 2
    assert profile["kd_pass_share"] == 0.667
    assert profile["radius_rms_mm"] is not None


def test_profile_never_fabricates_unmeasured():
    """Не измерено — None, а не 0: строки без амплитуд/GOF/вердиктов."""
    points = [_row(mni=[10.0, 0.0, 0.0], structure="A"),
              _row(mni=[20.0, 0.0, 0.0], structure="A")]
    profile = feature_profile(points)
    assert profile["moment_sum_nam"] is None
    assert profile["moment_mean_nam"] is None
    assert profile["moment_max_nam"] is None
    assert profile["gof_median"] is None
    assert profile["gof_min"] is None
    assert profile["n_kd_evaluated"] == 0
    assert profile["kd_pass_share"] is None  # не измерено ≠ 0
    assert profile["share"] is None  # выборка (total) не задана
    # Без структур и координат — честные None
    bare = feature_profile([_row(), _row()])
    assert bare["structure_share"] is None
    assert bare["structure_entropy"] is None
    assert bare["hemisphere_share"] is None
    assert bare["radius_rms_mm"] is None


def test_kd_pass_share_counts_only_evaluated():
    """Доля КД — среди оценённых; «не оценено» не тянет ни вверх, ни вниз."""
    points = [_row(kd_passed=1), _row(kd_passed=0), _row(kd_passed=None)]
    profile = feature_profile(points)
    assert profile["n_kd_evaluated"] == 2
    assert profile["n_kd_passed"] == 1
    assert profile["kd_pass_share"] == 0.5


def test_structure_entropy_from_monoculture_to_uniform():
    """Энтропия состава: 0 — одна структура, 1 — две равные, между — смесь."""
    mono = feature_profile([_row(structure="A") for _ in range(4)])
    assert mono["structure_entropy"] == 0.0
    uni = feature_profile([_row(structure="A"), _row(structure="B")])
    assert uni["structure_entropy"] == 1.0
    mixed = feature_profile(
        [_row(structure="A")] * 3 + [_row(structure="B")],
    )
    # H = −0.75·ln0.75 − 0.25·ln0.25 ≈ 0.5623; ln2 ≈ 0.6931 → ≈ 0.811
    assert abs(mixed["structure_entropy"] - 0.811) < 0.01


def test_hemisphere_share_by_sign_only():
    """Полушария — только знак x MNI (x = 0 — срединная линия), без порогов."""
    points = [_row(mni=[-20.0, 0.0, 0.0]), _row(mni=[0.0, 0.0, 0.0]),
              _row(mni=[30.0, 0.0, 0.0])]
    profile = feature_profile(points)
    assert profile["hemisphere_share"] == {
        "left": 0.333, "midline": 0.333, "right": 0.333,
    }


def test_radius_rms_is_compactness():
    """RMS-радиус двух точек (0,0,0) и (10,0,0) — ровно 5 мм."""
    profile = feature_profile([_row(mni=[0.0, 0.0, 0.0]),
                              _row(mni=[10.0, 0.0, 0.0])])
    assert profile["radius_rms_mm"] == 5.0


def test_empty_cluster_has_no_profile():
    """Пустой кластер — профиля нет (None), считать нечего."""
    assert feature_profile([]) is None