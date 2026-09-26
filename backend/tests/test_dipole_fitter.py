"""Тесты dipole_fitter: подготовка Evoked, распаковка fit_dipole, кэш BEM."""
import mne
import numpy as np
import pytest

import app.services.dipole_fitter as dipole_fitter
from app.core.config import settings
from app.services.job_manager import noop_progress


class FakeDipole:
    """Двойник ``mne.Dipole``: две временные точки, разный gof.

    `gof` — в процентах, как у настоящего MNE (`dipole.py`: `* 100`): сервис
    обязан нормализовать в долю 0..1 на границе (контракт `DipoleOut`).
    """

    def __init__(self) -> None:
        self.times = np.array([0.0, 0.1])
        self.pos = np.array([[0.0, 0.0, 50.0], [1.0, 0.0, 50.0]], dtype=float)
        self.ori = np.array([[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]], dtype=float)
        self.amplitude = np.array([1e-9, 2e-9])
        self.gof = np.array([80.0, 95.0])


class FakeDipoleWithStats(FakeDipole):
    """Двойник с расширенной распаковкой `fit_dipole` (2.6/N23).

    `conf`/`khi2`/`nfree` MNE считает всегда, а `mne.fit_dipole` отдаёт ещё и
    кортеж с невязкой: всё это раньше отбрасывалось, а из него берутся RIV/CI.
    """

    def __init__(self) -> None:
        super().__init__()
        # Доверительные границы по осям диполя, метры (как у MNE `dip.conf`)
        self.conf = {
            "depth": np.array([0.0, 0.0]),
            "long": np.array([0.004, 0.002]),   # 4 мм / 2 мм
            "trans": np.array([0.006, 0.003]),  # 6 мм / 3 мм
        }
        self.khi2 = np.array([1.2, 0.7])
        self.nfree = np.array([33, 33])


class FakeResidual:
    """Двойник невязки `fit_dipole` (Evoked): только ``data`` как у настоящего."""

    def __init__(self, data: np.ndarray) -> None:
        self.data = data


def _patch_fit(monkeypatch, result_factory, calls=None, kwargs_seen=None):
    """Изолирует фитинг от FSAverage/BEM и подменяет ``mne.fit_dipole``."""

    def fake_fit_dipole(evoked, cov, bem, **kwargs):
        if calls is not None:
            calls.append(evoked)
        if kwargs_seen is not None:
            kwargs_seen.append(kwargs)
        return result_factory(evoked)

    monkeypatch.setattr(dipole_fitter, "_get_bem", lambda settings: "dummy-bem")
    monkeypatch.setattr(dipole_fitter, "_get_covariance", lambda settings: None)
    monkeypatch.setattr(dipole_fitter.mne, "fit_dipole", fake_fit_dipole)


def test_fit_dipoles_unpacks_tuple_from_mne(epochs_alpha, monkeypatch):
    """MNE 1.13 отдаёт кортеж ``(dipoles, residual)`` — траектория не пуста (F17)."""
    calls: list = []
    kwargs_seen: list = []
    _patch_fit(monkeypatch, lambda evoked: (FakeDipole(), None), calls, kwargs_seen)

    result = dipole_fitter.fit_dipoles_for_epochs(
        epochs_alpha, settings, freq_bands={},
    )

    assert len(calls) == len(epochs_alpha)
    assert all(isinstance(e, mne.Evoked) for e in calls)
    assert [r["epoch_index"] for r in result] == list(range(len(epochs_alpha)))
    for r in result:
        assert "error" not in r
        assert r["n_time_points"] == 2, "кортеж распакован: точки траектории на месте"
        # MNE прислал 95.0 (проценты) → в контракте доля 0.95
        assert r["best_fit"]["gof"] == pytest.approx(0.95)
        assert all(0.0 <= p["gof"] <= 1.0 for p in r["trajectory"])
        assert r["best_fit"]["amplitude_nam"] == pytest.approx(2.0)
    # n_jobs берётся из настроек, а не зашит единицей
    assert all(kw.get("n_jobs") == settings.dipole_fit_n_jobs for kw in kwargs_seen)
def test_fit_dipoles_accepts_bare_dipole_too(epochs_alpha, monkeypatch):
    """Старое API ``fit_dipole`` (без кортежа) продолжает работать."""
    _patch_fit(monkeypatch, lambda evoked: FakeDipole())

    result = dipole_fitter.fit_dipoles_for_epochs(epochs_alpha, settings, freq_bands={})

    assert all(r["n_time_points"] == 2 for r in result)


def test_fit_dipoles_unpacks_conf_khi2_and_residual(epochs_alpha, monkeypatch):
    """2.6/N23: расширенная распаковка `fit_dipole` → RIV/CI в точках траектории.

    `dip.conf`/`khi2`/`nfree` и невязка из кортежа раньше отбрасывались; теперь
    из них считаются RIV (доля отбелённой невязки) и радиус доверительной
    области позиции (максимум границ MNE по осям диполя, мм).
    """
    n_ch = len(epochs_alpha.ch_names)
    residual = FakeResidual(np.full((n_ch, 2), 1e-7))

    def factory(evoked):
        return FakeDipoleWithStats(), residual

    _patch_fit(monkeypatch, factory)
    result = dipole_fitter.fit_dipoles_for_epochs(epochs_alpha, settings, freq_bands={})

    for r in result:
        for idx, point in enumerate(r["trajectory"]):
            assert point["khi2"] is not None and point["nfree"] == 33
            # CI: max(long, trans, depth=0) в мм — 6 мм для точки 0, 3 мм для точки 1
            assert point["ci_mm"] == pytest.approx(6.0 if idx == 0 else 3.0)
        # RIV — доля отбелённой невязки: конечна и неотрицательна
        assert all(
            p["riv"] is not None and np.isfinite(p["riv"]) and p["riv"] >= 0.0
            for p in r["trajectory"]
        )
    # Лучшая точка тащит RIV/CI в `best_fit` (таблица локализации)
    assert result[0]["best_fit"]["riv"] is not None
    assert result[0]["best_fit"]["ci_mm"] == pytest.approx(3.0)


def test_fit_dipoles_reports_progress_per_epoch(epochs_alpha, monkeypatch):
    """Прогресс задачи идёт по эпохам, а не «0 → 1» в конце (F19)."""
    seen: list = []
    _patch_fit(monkeypatch, lambda evoked: (FakeDipole(), None))

    def progress(stage, value=None, message="", epochs_done=None, epochs_total=None):
        seen.append((stage, value, epochs_done, epochs_total))

    dipole_fitter.fit_dipoles_for_epochs(
        epochs_alpha, settings, freq_bands={}, progress=progress,
    )

    total = len(epochs_alpha)
    assert [item[2] for item in seen] == list(range(1, total + 1))
    assert all(item[3] == total for item in seen)
    assert seen[-1][1] == pytest.approx(1.0)
    assert all(item[0] == "dipoles" for item in seen)


def test_fit_dipoles_works_with_noop_progress(epochs_alpha, monkeypatch):
    """Синхронный ``/analyze`` передаёт заглушку прогресса — она принимает счётчики."""
    _patch_fit(monkeypatch, lambda evoked: (FakeDipole(), None))

    result = dipole_fitter.fit_dipoles_for_epochs(
        epochs_alpha, settings, freq_bands={}, progress=noop_progress,
    )

    assert len(result) == len(epochs_alpha)


def test_fit_summary_flags_total_failure():
    """Все эпохи с ошибкой → предупреждение, а не «успех с пустым списком» (F18)."""
    summary = dipole_fitter.fit_summary([
        {"epoch_index": 0, "error": "boom"},
        {"epoch_index": 1, "error": "boom"},
    ])

    assert summary["n_dipole_fit"] == 0
    assert summary["n_dipole_errors"] == 2
    assert summary["dipole_error_samples"] == ["boom", "boom"]
    assert len(summary["warnings"]) == 1
    assert "не дал диполей" in summary["warnings"][0]


def test_fit_summary_counts_partial_failure():
    """Часть эпох упала: счётчики по факту, а не «всё или ничего»."""
    summary = dipole_fitter.fit_summary([
        {"epoch_index": 0, "error": "bad channels"},
        {"epoch_index": 1, "best_fit": {"gof": 90.0}},
        {"epoch_index": 2, "best_fit": {"gof": 80.0}},
    ])

    assert (summary["n_dipole_fit"], summary["n_dipole_errors"]) == (2, 1)
    assert summary["dipole_error_samples"] == ["bad channels"]
    assert "1 из 3" in summary["warnings"][0]


def test_fit_summary_is_silent_when_all_epochs_fitted():
    """Ошибок нет — предупреждений нет: контракт не шумит зря."""
    summary = dipole_fitter.fit_summary([
        {"epoch_index": 0, "best_fit": {"gof": 90.0}},
    ])

    assert summary["warnings"] == []
    assert (summary["n_dipole_fit"], summary["n_dipole_errors"]) == (1, 0)


def test_get_bem_returns_cached_solution(monkeypatch):
    """BEM читается из файла один раз и возвращается решением, а не путём (F19)."""
    reads: list = []
    monkeypatch.setattr(dipole_fitter, "bem_path", lambda settings: "bem.fif")
    monkeypatch.setattr(
        dipole_fitter.mne, "read_bem_solution",
        lambda path, verbose=False: reads.append(path) or "bem-solution",
    )
    dipole_fitter._read_bem.cache_clear()

    assert dipole_fitter._get_bem(settings) == "bem-solution"
    assert dipole_fitter._get_bem(settings) == "bem-solution"

    assert reads == ["bem.fif"], "BEM не перечитывается на каждую эпоху"
    dipole_fitter._read_bem.cache_clear()


def test_bem_path_reports_missing_files(monkeypatch):
    """Нет BEM-файла — понятная ошибка со списком ожидаемых путей."""
    monkeypatch.setattr(dipole_fitter.os.path, "exists", lambda path: False)

    with pytest.raises(FileNotFoundError, match="BEM-решение fsaverage"):
        dipole_fitter.bem_path(settings)


def test_localize_takes_attribution_from_shared_atlas(monkeypatch):
    """Анатомия — из ``atlas_contours.attribution_payload`` (шаг 1.4/N21).

    Единый источник с контурами среза (структура/поле + расстояния + «вне мозга»),
    чтения тома на точку нет (F19).
    """
    from app.services import atlas_contours

    seen: list = []
    payload = {
        "anatomical_structure": "Precentral Gyrus",
        "structure_distance_mm": 1.5,
        "brodmann_area": "BA4-lh",
        "brodmann_distance_mm": 3.0,
        "outside_brain": False,
    }

    def _stub(cfg, mni):
        seen.append(list(mni))
        return dict(payload)

    monkeypatch.setattr(atlas_contours, "attribution_payload", _stub)
    monkeypatch.setattr(dipole_fitter, "_get_transform", lambda subjects_dir, trans: None)
    monkeypatch.setattr(
        dipole_fitter.mne, "head_to_mni",
        lambda pos, **kwargs: np.array([[1.0, 2.0, 3.0]]),
    )
    point = {
        "time_ms": 10.0, "pos_head": [0.0, 0.0, 50.0], "ori_head": [0.0, 0.0, 1.0],
        "amplitude_nam": 12.0, "gof": 90.0,
    }

    result = dipole_fitter.localize_dipoles(
        [{"epoch_index": 0, "n_time_points": 1, "trajectory": [point], "best_fit": point}],
        settings,
    )

    localized = result[0]["trajectory"][0]
    assert seen == [[1.0, 2.0, 3.0]]
    assert localized["anatomical_structure"] == "Precentral Gyrus"
    assert localized["mni_coords"] == [1.0, 2.0, 3.0]
    assert localized["brodmann_area"] == "BA4-lh"
    assert localized["structure_distance_mm"] == 1.5
    assert localized["brodmann_distance_mm"] == 3.0
    assert localized["outside_brain"] is False
    assert result[0]["best_fit"]["anatomical_structure"] == "Precentral Gyrus"


def test_localize_keeps_none_when_atlas_is_unavailable(monkeypatch):
    """Атлас недоступен — расчёт не отменяется, структура остаётся пустой."""
    from app.services import atlas_contours

    def boom(cfg, mni):
        raise OSError("нет атласа")

    monkeypatch.setattr(atlas_contours, "attribution_payload", boom)
    monkeypatch.setattr(dipole_fitter, "_get_transform", lambda subjects_dir, trans: None)
    monkeypatch.setattr(
        dipole_fitter.mne, "head_to_mni",
        lambda pos, **kwargs: np.array([[4.0, 5.0, 6.0]]),
    )
    point = {
        "time_ms": 10.0, "pos_head": [0.0, 0.0, 50.0], "ori_head": [0.0, 0.0, 1.0],
        "amplitude_nam": 12.0, "gof": 90.0,
    }

    result = dipole_fitter.localize_dipoles(
        [{"epoch_index": 0, "trajectory": [point], "best_fit": {}}],
        settings,
    )

    localized = result[0]["trajectory"][0]
    assert localized["anatomical_structure"] is None
    assert localized["brodmann_area"] is None
    assert localized["structure_distance_mm"] is None
    assert localized["brodmann_distance_mm"] is None
    assert localized["outside_brain"] is None
    assert result[0]["best_fit"]["gof"] == pytest.approx(90.0)
