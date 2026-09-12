"""fit_dipole + локализация (анатомия + Brodmann)."""
import mne
import numpy as np
from typing import List, Dict
from app.core.config import Settings


def fit_dipoles_for_epochs(epochs: mne.Epochs, settings: Settings, freq_bands: dict):
    cov = _get_covariance(settings)
    bem = _get_bem(settings)
    trans = settings.fsaverage_trans
    subjects_dir = settings.subjects_dir

    all_dips = []
    for i, epoch in enumerate(epochs):
        evoked = epoch.average()
        try:
            dip = mne.fit_dipole(
                evoked, cov, bem, trans=trans,
                min_dist=5.0, n_jobs=1, verbose=False,
            )
            traj = []
            for idx in range(len(dip.pos)):
                traj.append({
                    "time_ms": float(dip.times[idx] * 1000),
                    "pos_head": dip.pos[idx].tolist(),
                    "ori_head": dip.ori[idx].tolist(),
                    "amplitude_nam": float(dip.amplitude[idx] * 1e9),
                    "gof": float(dip.gof[idx]),
                })
            best = max(traj, key=lambda x: x["gof"]) if traj else {}
            all_dips.append({
                "epoch_index": i,
                "n_time_points": len(traj),
                "trajectory": traj,
                "best_fit": best,
            })
        except Exception as e:
            all_dips.append({"epoch_index": i, "error": str(e), "trajectory": [], "best_fit": {}})

    return all_dips


def localize_dipoles(dipoles_result: list, settings: Settings) -> list:
    subjects_dir = settings.subjects_dir
    trans = settings.fsaverage_trans
    ba_labels = mne.read_labels_from_parc(
        "aparc.a2009s", subjects_dir=subjects_dir,
        subject="fsaverage",
    )

    for result in dipoles_result:
        if "error" in result or not result.get("trajectory"):
            continue

        traj = result["trajectory"]
        localized = []
        for dp in traj:
            pos = np.array(dp["pos_head"]).reshape(1, 3)

            # MNI
            mni = None
            try:
                mni = mne.head_to_mni(
                    pos, 1, trans, subject="fsaverage",
                    subjects_dir=subjects_dir,
                )
                dp["mni_coords"] = mni[0].tolist()
            except Exception:
                dp["mni_coords"] = [0, 0, 0]

            # Анатомия
            try:
                dp_dip = mne.Dipole(
                    times=[dp["time_ms"] / 1000],
                    pos=pos,
                    amplitude=[dp["amplitude_nam"] * 1e-9],
                    ori=np.array(dp["ori_head"]).reshape(1, 3),
                    gof=[dp["gof"]],
                )
                vol_labels = dp_dip.to_volume_labels(
                    trans, subject="fsaverage",
                    aseg="aparc.a2009s+aseg", subjects_dir=subjects_dir,
                )
                dp["anatomical_structure"] = vol_labels[0] if vol_labels else "unknown"
            except Exception:
                dp["anatomical_structure"] = "unknown"

            # Brodmann
            if mni is not None:
                dp["brodmann_area"] = _find_ba(mni[0], ba_labels, subjects_dir)
            else:
                dp["brodmann_area"] = "unknown"
            localized.append(dp)

        result["trajectory"] = localized
        if localized:
            result["best_fit"] = max(localized, key=lambda x: x["gof"])

    return dipoles_result


def _find_ba(mni_pos, ba_labels, subjects_dir) -> str:
    """Поиск Brodmann Area по MNI-координатам (через ближайшую метку)."""
    try:
        # Ищем метку BA, центр которой ближе всего к позиции диполя
        ras = mni_pos
        best_label = "unknown"
        best_dist = float("inf")
        for label in ba_labels:
            if not label.name.startswith("BA"):
                continue
            # Получаем вершины метки на поверхности
            hemi = "lh" if label.hemi == "L" else "rh"
            verts, _ = mne.surface.io.read_surface(
                f"{subjects_dir}/fsaverage/surf/{hemi}.white",
            )
            if len(verts) <= max(label.vertices):
                continue
            label_verts = verts[label.vertices]
            if len(label_verts) == 0:
                continue
            # Расстояние до центра метки (в среднем в MNI-пространстве)
            center = label_verts.mean(axis=0)
            dist = np.linalg.norm(center - ras)
            if dist < best_dist:
                best_dist = dist
                best_label = label.name
        return best_label
    except Exception:
        return "unknown"


def _get_covariance(settings) -> "mne.Covariance":
    try:
        return mne.read_cov(f"{settings.subjects_dir}/fsaverage-cov.fif")
    except FileNotFoundError:
        return None


def _get_bem(settings):
    return f"{settings.subjects_dir}/bem/fsaverage-5-embed-mri.bem"
