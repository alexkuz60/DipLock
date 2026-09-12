"""Экспорт surface-мешей FSAverage в JSON."""
import mne
import os
from app.core.config import settings


def export_fsaverage_surface(settings=None):
    # Используем переданный settings ИЛИ глобальный синглтон (без повторного чтения .env)
    if settings is None:
        settings = globals()["settings"]
    subjects_dir = settings.subjects_dir

    if not os.path.isdir(f"{subjects_dir}/fsaverage"):
        mne.datasets.fsaverage.data_path()

    surfaces = {}
    for hemi in ["lh", "rh"]:
        surf_path = f"{subjects_dir}/fsaverage/surf/{hemi}.inflated"
        verts, faces = mne.surface.io.read_surface(surf_path)

        # Децимация для frontend
        if len(verts) > 10000:
            try:
                import trimesh
                mesh = trimesh.Trimesh(verts, faces)
                mesh = mesh.simplify_quadratic_decimation(8000)
                verts, faces = mesh.vertices, mesh.faces
            except ImportError:
                pass

        surfaces[hemi] = {
            "vertices": verts.tolist(),
            "faces": faces.tolist(),
            "vertex_count": len(verts),
            "face_count": len(faces),
        }

    surfaces["ba_labels"] = _export_ba_labels(settings)
    return surfaces


def _export_ba_labels(settings) -> dict:
    labels = mne.read_labels_from_parc(
        "aparc.a2009s", subjects_dir=settings.subjects_dir,
        subject="fsaverage",
    )
    ba_data = {}
    for label in labels:
        if label.name.startswith("BA"):
            ba_data[label.name] = {
                "hemi": label.hemi,
                "vertices": label.vertices.tolist(),
                "n_vertices": len(label.vertices),
            }
    return ba_data
