"""fit_dipole + локализация (анатомия + Brodmann)."""
import mne
import numpy as np
from functools import lru_cache
from typing import List, Optional, Tuple
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
    trans_path = settings.fsaverage_trans
    # Кэшированный один раз (module-level lru_cache)
    transform = _get_transform(subjects_dir, trans_path)
    ba_centers = _get_ba_centers(subjects_dir)

    for result in dipoles_result:
        if "error" in result or not result.get("trajectory"):
            continue

        traj = result["trajectory"]
        localized = []
        for dp in traj:
            pos = np.array(dp["pos_head"]).reshape(1, 3)

            # MNI — корректная сигнатура в MNE 1.13: (pos, subject, mri_head_t, ...)
            mni = None
            try:
                mni = mne.head_to_mni(
                    pos, subject="fsaverage",
                    mri_head_t=transform,
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
                    transform, subject="fsaverage",
                    aseg="aparc.a2009s+aseg", subjects_dir=subjects_dir,
                )
                dp["anatomical_structure"] = vol_labels[0] if vol_labels else "unknown"
            except Exception:
                dp["anatomical_structure"] = "unknown"

            # Brodmann — через кэшированные центры меток (без повторов read_surface)
            if mni is not None:
                dp["brodmann_area"] = _find_ba(mni[0], ba_centers)
            else:
                dp["brodmann_area"] = "unknown"
            localized.append(dp)

        result["trajectory"] = localized
        if localized:
            result["best_fit"] = max(localized, key=lambda x: x["gof"])

    return dipoles_result


@lru_cache(maxsize=1)
def _get_transform(subjects_dir: str, trans_path: str) -> "mne.Transform":
    """Закэшированный Transform (mri_head_t). Принимает путь к .fif, возвращает mne.Transform."""
    return mne.read_trans(trans_path, verbose=False)


@lru_cache(maxsize=1)
def _get_ba_centers(subjects_dir: str) -> List[Tuple[str, np.ndarray]]:
    """
    Центры Brodmann-меток на fsaverage. Строится один раз и кэшируется.

    Возвращает список [(ba_name, center_coords), ...].
    """
    labels = mne.read_labels_from_parc(
        "aparc.a2009s", subjects_dir=subjects_dir,
        subject="fsaverage",
    )
    verts_cache = {}
    centers = []
    for label in labels:
        if not label.name.startswith("BA"):
            continue
        hemi = "lh" if label.hemi == "L" else "rh"
        if hemi not in verts_cache:
            verts, _ = mne.surface.io.read_surface(
                f"{subjects_dir}/fsaverage/surf/{hemi}.white",
            )
            verts_cache[hemi] = verts
        verts = verts_cache[hemi]
        if len(verts) <= max(label.vertices):
            continue
        center = verts[label.vertices].mean(axis=0)
        centers.append((label.name, center))
    return centers


def _find_ba(mni_pos, ba_centers) -> str:
    """Поиск Brodmann Area по ближайшему центру метки (из кэша)."""
    best_label = "unknown"
    best_dist = float("inf")
    for name, center in ba_centers:
        dist = np.linalg.norm(center - mni_pos)
        if dist < best_dist:
            best_dist = dist
            best_label = name
    return best_label


def _get_covariance(settings) -> Optional["mne.Covariance"]:
    try:
        return mne.read_cov(f"{settings.subjects_dir}/fsaverage-cov.fif")
    except FileNotFoundError:
        return None


def _get_bem(settings):
    return f"{settings.subjects_dir}/bem/fsaverage-5-embed-mri.bem"
