"""Тесты brain_export: поверхность fsaverage и метки Brodmann."""
import os

import pytest

from app.core.config import settings
from app.utils.brain_export import export_fsaverage_surface

_LH_INFLATED = os.path.join(
    settings.subjects_dir, "fsaverage", "surf", "lh.inflated",
)


@pytest.mark.skipif(not os.path.exists(_LH_INFLATED), reason="fsaverage surface недоступна")
def test_export_fsaverage_surface_has_both_hemispheres():
    surfaces = export_fsaverage_surface(settings)

    assert {"lh", "rh"} <= set(surfaces)
    for hemi in ("lh", "rh"):
        assert surfaces[hemi]["vertex_count"] > 0
        assert surfaces[hemi]["face_count"] > 0
        # децимация до ~8000 граней для frontend (trimesh + fast-simplification)
        assert surfaces[hemi]["vertex_count"] <= 9000
        assert len(surfaces[hemi]["vertices"]) == surfaces[hemi]["vertex_count"]


@pytest.mark.skipif(not os.path.exists(_LH_INFLATED), reason="fsaverage surface недоступна")
def test_export_ba_labels_present():
    surfaces = export_fsaverage_surface(settings)
    ba = surfaces["ba_labels"]

    assert isinstance(ba, dict) and ba
    assert all(name.startswith("BA") for name in ba)
    sample = next(iter(ba.values()))
    assert sample["hemi"] in ("lh", "rh")
    assert sample["n_vertices"] > 0
