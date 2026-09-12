"""fit_dipole + локализация (анатомия + Brodmann)."""
import os

import mne
import numpy as np
from functools import lru_cache
from typing import Dict, List, Optional, Tuple
from app.core.config import Settings


def fit_dipoles_for_epochs(epochs: mne.Epochs, settings: Settings, freq_bands: dict):
    bem = _get_bem(settings)
    trans = settings.fsaverage_trans
    subjects_dir = settings.subjects_dir

    # Ковариация: из файла, иначе считаем empirical прямо из эпох
    # (method='shrunk' требует scikit-learn).
    cov = _get_covariance(settings)
    if cov is None:
        cov = mne.compute_covariance(epochs, method="empirical", verbose=False)

    # Итерация по mne.Epochs даёт numpy-массивы (не .average()), а mne.fit_dipole
    # требует Evoked — поэтому собираем Evoked для каждой эпохи вручную.
    max_epochs = int(getattr(settings, "dipole_fit_max_epochs", 0) or 0)
    n_fit = len(epochs) if max_epochs <= 0 else min(len(epochs), max_epochs)
    data = epochs.get_data()[:n_fit]  # (n_fit, n_channels, n_times)
    tmin = float(epochs.times[0])
    decim = max(1, int(getattr(settings, "dipole_fit_decim", 1) or 1))

    all_dips = []
    for i in range(n_fit):
        evoked = mne.EvokedArray(
            data[i], epochs.info.copy(), tmin=tmin, nave=1, verbose=False,
        )
        # Прореживание по времени: fit_dipole на каждую точку очень дорог
        if decim > 1:
            evoked.decimate(decim, verbose=False)
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
    Центры Brodmann-меток на fsaverage (атлас PALS_B12_Brodmann).

    Строится один раз и кэшируется. Возвращает [(name, center_coords), ...],
    где name имеет вид "BA17-lh".
    """
    labels = mne.read_labels_from_annot(
        "fsaverage", parc="PALS_B12_Brodmann",
        subjects_dir=subjects_dir, verbose=False,
    )
    verts_cache: Dict[str, np.ndarray] = {}
    centers = []
    for label in labels:
        # В PALS_B12_Brodmann метки названы "Brodmann.<area>-lh/rh"
        if not label.name.startswith("Brodmann"):
            continue
        hemi = label.hemi  # 'lh' или 'rh'
        if hemi not in verts_cache:
            verts, _ = mne.read_surface(
                f"{subjects_dir}/fsaverage/surf/{hemi}.white", verbose=False,
            )
            verts_cache[hemi] = verts
        verts = verts_cache[hemi]
        if len(verts) <= max(label.vertices):
            continue
        center = verts[label.vertices].mean(axis=0)
        centers.append((label.name.replace("Brodmann.", "BA"), center))
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
    except (FileNotFoundError, OSError):
        return None


def _get_bem(settings) -> str:
    """Путь к BEM-решению fsaverage; ищем существующий файл."""
    candidates = [
        f"{settings.subjects_dir}/fsaverage/bem/fsaverage-5120-5120-5120-bem-sol.fif",
        f"{settings.subjects_dir}/fsaverage/bem/fsaverage-5120-5120-5120-bem.fif",
        f"{settings.subjects_dir}/bem/fsaverage-5120-5120-5120-bem-sol.fif",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    raise FileNotFoundError(
        "BEM-решение fsaverage не найдено. Ожидался один из файлов: "
        + ", ".join(candidates)
    )
