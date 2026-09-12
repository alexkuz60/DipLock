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
        verts, faces = mne.read_surface(surf_path, verbose=False)

        # Децимация для frontend (необязательная оптимизация: не ломаем экспорт)
        if len(verts) > 10000:
            try:
                import trimesh
                mesh = trimesh.Trimesh(verts, faces)
                # trimesh 5.x: первый позиционный аргумент — percent, нужен face_count
                mesh = mesh.simplify_quadric_decimation(face_count=8000)
                verts, faces = mesh.vertices, mesh.faces
            except Exception:
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
    labels = mne.read_labels_from_annot(
        "fsaverage", parc="PALS_B12_Brodmann",
        subjects_dir=settings.subjects_dir, verbose=False,
    )
    ba_data = {}
    for label in labels:
        # В PALS_B12_Brodmann метки названы "Brodmann.<area>-lh/rh"
        if not label.name.startswith("Brodmann"):
            continue
        name = label.name.replace("Brodmann.", "BA")
        ba_data[name] = {
            "hemi": label.hemi,
            "vertices": label.vertices.tolist(),
            "n_vertices": len(label.vertices),
        }
    return ba_data
