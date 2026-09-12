"""REST API эндпоинты."""
import os
from fastapi import APIRouter, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List

router = APIRouter()


@router.post("/analyze")
async def analyze_eeg(
    file: UploadFile = File(...),
    epoch_length_ms: float = Form(2000.0),
    freq_band: str = Form("all"),
    custom_min_freq: Optional[float] = Form(None),
    custom_max_freq: Optional[float] = Form(None),
    single_freq: Optional[float] = Form(None),
    run_ica: bool = Form(True),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
):
    """Полный пайплайн: EDF → артефакты → эпохи → фильтр → диполи → локализация."""
    from app.services.edf_loader import load_edf
    from app.services.artifact_detector import detect_artifacts
    from app.services.epoch_segmenter import segment_epochs
    from app.services.bandpass_filter import apply_band_filter, compute_band_power
    from app.services.dipole_fitter import fit_dipoles_for_epochs, localize_dipoles
    from app.utils.brain_export import export_fsaverage_surface
    from app.core.config import settings
    import uuid, shutil, json

    session_id = str(uuid.uuid4())
    upload_dir = os.path.join(settings.upload_dir, session_id)
    os.makedirs(upload_dir, exist_ok=True)
    tmp_path = os.path.join(upload_dir, file.filename)
    shutil.copyfileobj(file.file, open(tmp_path, "wb"))

    raw = load_edf(tmp_path, settings.standard_channels)
    annotations, artifact_stats = detect_artifacts(raw, settings, z_threshold, pp_threshold_uv)

    epochs = segment_epochs(raw, annotations, epoch_length_ms=epoch_length_ms)

    if freq_band != "all" or single_freq is not None:
        epochs = apply_band_filter(
            epochs, freq_band,
            custom_min=custom_min_freq,
            custom_max=custom_max_freq,
            single_freq=single_freq,
            bandwidth_hz=settings.default_single_freq_bandwidth_hz,
        )

    freq_powers = compute_band_power(epochs, settings.freq_bands)
    dipoles = fit_dipoles_for_epochs(epochs, settings, freq_bands=freq_powers)
    dipoles = localize_dipoles(dipoles, settings)
    surface = export_fsaverage_surface(settings)

    results_path = os.path.join(settings.results_dir, f"{session_id}.json")
    os.makedirs(settings.results_dir, exist_ok=True)
    with open(results_path, "w") as f:
        json.dump({
            "session_id": session_id,
            "filename": file.filename,
            "frequency_powers": freq_powers,
            "dipoles": dipoles,
        }, f, indent=2, default=str)

    return JSONResponse({
        "session_id": session_id,
        "filename": file.filename,
        "n_channels": raw.info["nchan"],
        "sfreq": raw.info["sfreq"],
        "duration_sec": round(len(raw) / raw.info["sfreq"], 2),
        "epoch_length_ms": epoch_length_ms,
        "freq_band": freq_band,
        "n_epochs_total": len(epochs),
        "n_epochs_used": len(epochs),
        "n_artifacts": artifact_stats["total"],
        "artifact_types": artifact_stats["by_type"],
        "frequency_powers": freq_powers,
        "surface": surface,
        "dipoles": dipoles,
        "results_file": results_path,
    })


@router.get("/brain-surface")
async def get_brain_surface():
    from app.utils.brain_export import export_fsaverage_surface
    from app.core.config import settings
    return export_fsaverage_surface(settings)


@router.get("/brodmann-labels")
async def get_brodmann_labels():
    from app.core.config import settings
    import mne
    if not os.path.isdir(f"{settings.subjects_dir}/fsaverage"):
        mne.datasets.fsaverage.data_path()
    labels = mne.read_labels_from_parc(
        "aparc.a2009s", subjects_dir=settings.subjects_dir,
        subject="fsaverage",
    )
    ba = [l.name for l in labels if l.name.startswith("BA")]
    return {"brodmann_areas": ba}
