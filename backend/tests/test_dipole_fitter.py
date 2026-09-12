"""Тесты dipole_fitter: подготовка Evoked для каждой эпохи."""
import mne

import app.services.dipole_fitter as dipole_fitter
from app.core.config import settings


def test_fit_dipoles_builds_evoked_per_epoch(epochs_alpha, monkeypatch):
    """fit_dipole вызывается с Evoked для каждой эпохи (а не с numpy-массивом)."""
    calls = []

    def fake_fit_dipole(evoked, cov, bem, **kwargs):
        calls.append(evoked)
        raise RuntimeError("stop")  # не выполняем тяжёлый реальный фитинг

    # Изолируем тест от наличия FSAverage/BEM на машине
    monkeypatch.setattr(dipole_fitter, "_get_bem", lambda settings: "dummy-bem.fif")
    monkeypatch.setattr(dipole_fitter, "_get_covariance", lambda settings: None)
    monkeypatch.setattr(dipole_fitter.mne, "fit_dipole", fake_fit_dipole)

    result = dipole_fitter.fit_dipoles_for_epochs(
        epochs_alpha, settings, freq_bands={},
    )

    assert len(calls) == len(epochs_alpha)
    assert all(isinstance(e, mne.Evoked) for e in calls)
    assert [r["epoch_index"] for r in result] == list(range(len(epochs_alpha)))
    for r in result:
        assert "trajectory" in r and "best_fit" in r


def test_find_ba_returns_nearest():
    import numpy as np

    centers = [("BA_1", np.array([0.0, 0.0, 0.0])), ("BA_2", np.array([10.0, 0.0, 0.0]))]
    assert dipole_fitter._find_ba(np.array([0.5, 0.0, 0.0]), centers) == "BA_1"
    assert dipole_fitter._find_ba(np.array([9.0, 0.0, 0.0]), centers) == "BA_2"


def test_find_ba_empty_centers():
    import numpy as np

    assert dipole_fitter._find_ba(np.array([1.0, 2.0, 3.0]), []) == "unknown"


def test_get_ba_centers_from_fsaverage():
    """BA-центры читаются из атласа PALS_B12_Brodmann (nibabel + fsaverage)."""
    import os

    annot = os.path.join(
        settings.subjects_dir, "fsaverage", "label", "lh.PALS_B12_Brodmann.annot",
    )
    if not os.path.exists(annot):
        import pytest

        pytest.skip("PALS_B12_Brodmann.annot недоступен")

    dipole_fitter._get_ba_centers.cache_clear()
    centers = dipole_fitter._get_ba_centers(settings.subjects_dir)

    assert centers, "BA-центры не найдены"
    names = [name for name, _ in centers]
    assert any(name.startswith("BA") for name in names)
    # имена вида BA17-lh / BA4p-rh
    assert all(name.startswith("BA") for name in names)
