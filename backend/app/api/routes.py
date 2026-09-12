"""REST API эндпоинты."""
import os
import uuid
import shutil
import json
import logging
from typing import Optional

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse
import asyncio

from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()

# Максимальный размер загружаемого EDF (200 МБ)
MAX_UPLOAD_SIZE = 200 * 1024 * 1024


def _run_analysis(
    filepath: str,
    filename: str,
    epoch_length_ms: float,
    freq_band: str,
    custom_min_freq: Optional[float],
    custom_max_freq: Optional[float],
    single_freq: Optional[float],
    z_threshold: float,
    pp_threshold_uv: float,
) -> dict:
    """Синхронный (CPU-bound) анализ EDF. Вызывается в executor-потоке, не в event-loop."""
    from app.services.edf_loader import load_edf
    from app.services.artifact_detector import detect_artifacts
    from app.services.epoch_segmenter import segment_epochs
    from app.services.bandpass_filter import apply_band_filter, compute_band_power
    from app.services.dipole_fitter import fit_dipoles_for_epochs, localize_dipoles
    from app.utils.brain_export import export_fsaverage_surface

    session_id = str(uuid.uuid4())

    raw = load_edf(filepath, settings.standard_channels)
    annotations, artifact_stats = detect_artifacts(
        raw, settings, z_threshold, pp_threshold_uv,
    )

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

    # Компактные best-fit диполи для записи в БД
    best_fit_dipoles = []
    for d in dipoles:
        bf = d.get("best_fit") or {}
        if not bf:
            continue
        mni = bf.get("mni_coords") or [0, 0, 0]
        best_fit_dipoles.append({
            "epoch_index": d.get("epoch_index"),
            "time_ms": bf.get("time_ms"),
            "mni_x": mni[0], "mni_y": mni[1], "mni_z": mni[2],
            "amplitude_nam": bf.get("amplitude_nam"),
            "gof": bf.get("gof"),
            "anatomical_roi": bf.get("anatomical_structure"),
            "brodmann_area": bf.get("brodmann_area"),
            "trajectory": d.get("trajectory"),
        })

    # JSON-фиксация результата (рядом с анализом в results_dir)
    results_path = os.path.join(settings.results_dir, f"{session_id}.json")
    os.makedirs(settings.results_dir, exist_ok=True)
    with open(results_path, "w") as f:
        json.dump({
            "session_id": session_id,
            "filename": filename,
            "frequency_powers": freq_powers,
            "dipoles": dipoles,
        }, f, indent=2, default=str)

    return {
        "session_id": session_id,
        "filename": filename,
        "n_channels": int(raw.info["nchan"]),
        "sfreq": float(raw.info["sfreq"]),
        "duration_sec": round(len(raw) / raw.info["sfreq"], 2),
        "epoch_length_ms": epoch_length_ms,
        "freq_band": freq_band,
        "n_epochs_total": int(len(epochs)),
        "n_epochs_used": int(len(epochs)),
        "n_artifacts": artifact_stats["total"],
        "artifact_types": artifact_stats["by_type"],
        "frequency_powers": freq_powers,
        "surface": surface,
        "dipoles": dipoles,
        "best_fit_dipoles": best_fit_dipoles,
        "results_file": results_path,
    }


async def _save_analysis_to_db(result: dict) -> None:
    """Сохраняет сессию и диполи в БД (async)."""
    from app.models.db import AsyncSessionLocal, init_db
    from app.models.db import Session as SessionModel
    from app.models.db import Dipole as DipoleModel

    await init_db()
    async with AsyncSessionLocal() as session:
        session.add(SessionModel(
            id=result["session_id"],
            filename=result.get("filename"),
            n_channels=result.get("n_channels"),
            sfreq=result.get("sfreq"),
            duration_sec=result.get("duration_sec"),
            epoch_length_ms=result.get("epoch_length_ms"),
            freq_band=result.get("freq_band"),
        ))
        for d in result.get("best_fit_dipoles") or []:
            session.add(DipoleModel(
                session_id=result["session_id"],
                epoch_id=d.get("epoch_index"),
                time_ms=d.get("time_ms"),
                mni_x=d.get("mni_x"),
                mni_y=d.get("mni_y"),
                mni_z=d.get("mni_z"),
                amplitude_nam=d.get("amplitude_nam"),
                gof=d.get("gof"),
                anatomical_roi=d.get("anatomical_roi"),
                brodmann_area=d.get("brodmann_area"),
                freq_band=result.get("freq_band"),
                trajectory_json=d.get("trajectory"),
            ))
        await session.commit()


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
    """Полный пайплайн: EDF → артефакты → эпохи → фильтр → диполи → локализация.

    Тяжёлый анализ выполняется в отдельном потоке (run_in_executor),
    чтобы не блокировать event-loop параллельных запросов.
    """
    # Валидация входных параметров
    if epoch_length_ms not in settings.epoch_lengths_ms:
        raise HTTPException(
            status_code=400,
            detail=f"epoch_length_ms должен быть одним из {settings.epoch_lengths_ms}",
        )
    if freq_band not in ("all", "custom", *settings.freq_bands.keys()):
        raise HTTPException(
            status_code=400,
            detail=f"freq_band должен быть 'all'/'custom' или {list(settings.freq_bands.keys())}",
        )
    if single_freq is not None and freq_band != "all":
        raise HTTPException(status_code=400, detail="single_freq ставится вместе с freq_band='all'")

    if not (file.filename or "").lower().endswith(".edf"):
        raise HTTPException(status_code=400, detail="Поддерживаются только файлы .edf")

    # Сохраняем загрузку с контролем размера
    upload_dir = os.path.join(settings.upload_dir, str(uuid.uuid4()))
    os.makedirs(upload_dir, exist_ok=True)
    tmp_path = os.path.join(upload_dir, file.filename or "recording.edf")

    size = 0
    try:
        with open(tmp_path, "wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Файл слишком большой (макс {MAX_UPLOAD_SIZE // (1024 * 1024)} МБ)",
                    )
                out.write(chunk)
    finally:
        await file.close()

    try:
        result = await asyncio.to_thread(
            _run_analysis, tmp_path, file.filename or "recording.edf",
            epoch_length_ms, freq_band,
            custom_min_freq, custom_max_freq, single_freq,
            z_threshold, pp_threshold_uv,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Анализ завершился ошибкой")
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Ошибка анализа: {e}")

    # Сохранить в БД (не падаем при сбое БД)
    try:
        await _save_analysis_to_db(result)
    except Exception:
        logger.exception("Не удалось сохранить результат в БД")

    return JSONResponse(result)


@router.get("/brain-surface")
async def get_brain_surface():
    from app.utils.brain_export import export_fsaverage_surface
    return export_fsaverage_surface(settings)


@router.get("/brodmann-labels")
async def get_brodmann_labels():
    import mne
    if not os.path.isdir(f"{settings.subjects_dir}/fsaverage"):
        mne.datasets.fsaverage.data_path()
    labels = mne.read_labels_from_parc(
        "aparc.a2009s", subjects_dir=settings.subjects_dir,
        subject="fsaverage",
    )
    ba = [l.name for l in labels if l.name.startswith("BA")]
    return {"brodmann_areas": ba}