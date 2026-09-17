"""Пайплайн файлового анализа: ``POST /analyze`` и ``POST /jobs`` (A1, этап 3).

Точный фитинг диполей по загруженному файлу («медленный» профиль: EDF → артефакты
→ эпохи → фильтр → диполи → локализация). Это CPU-bound код: он всегда
исполняется в потоке задачи (`job_manager`) или через ``asyncio.to_thread``, а не
в event-loop.

Здесь же результат задачи доезжает до БД: ``persist_job_result`` — колбэк
успеха, который не должен отменять удачный расчёт, если БД недоступна.

Легаси-ветка: разделы UI работают с записью (``/recordings/{id}/…``), этот
пайплайн остаётся для ``curl``/скриптов и истории задач; находки F17–F19
(``audit.md`` §7.7) относятся именно к нему.
"""
import json
import logging
import os
import sys
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.core.config import settings
from app.services import journal
from app.services.job_manager import Job, ProgressCallback, job_manager
from app.services.surface_cache import surface_ref
from app.utils.versions import library_versions

logger = logging.getLogger(__name__)


def _file_size(path: str) -> Optional[int]:
    """Размер файла записи в байтах (``None`` — файл недоступен: не ошибка шага)."""
    try:
        return os.path.getsize(path)
    except OSError:
        return None


def run_analysis(
    progress: ProgressCallback,
    filepath: str,
    filename: str,
    epoch_length_ms: float,
    freq_band: str,
    custom_min_freq: Optional[float],
    custom_max_freq: Optional[float],
    single_freq: Optional[float],
    run_ica: bool = True,
    z_threshold: float = 5.0,
    pp_threshold_uv: float = 100.0,
) -> Dict[str, Any]:
    """Синхронный (CPU-bound) анализ EDF: вызывается в потоке, не в event-loop.

    ``progress`` — колбэк этапов (``job_manager``); в синхронном ``/analyze``
    передаётся заглушка (``job_manager.noop_progress``). Меш fsaverage здесь НЕ
    строится: клиент получает ссылку на кэшируемый ассет (F6).
    """
    from app.services.artifact_detector import detect_artifacts
    from app.services.bandpass_filter import apply_band_filter, compute_band_power
    from app.services.dipole_fitter import fit_dipoles_for_epochs, localize_dipoles
    from app.services.edf_loader import load_edf
    from app.services.epoch_segmenter import segment_epochs

    started = time.perf_counter()
    session_id = str(uuid.uuid4())

    progress("load_edf", message="Чтение EDF, монтаж 10-20, average reference")
    with journal.step(
        "analyze", "load_edf", bytes_in=_file_size(filepath), note=filename,
    ) as entry:
        raw = load_edf(filepath, settings.standard_channels, units=settings.edf_units)
        entry.bytes_out = int(raw.info["nchan"]) * int(raw.n_times) * 8

    progress("artifacts", message="Детекция артефактов")
    with journal.step(
        "analyze", "artifacts",
        note=f"z={z_threshold:g}, pp={pp_threshold_uv:g}, ica={int(run_ica)}",
    ) as entry:
        annotations, artifact_stats = detect_artifacts(
            raw, settings, z_threshold, pp_threshold_uv, run_ica=run_ica,
        )
        entry.note = f"{entry.note}, found={artifact_stats['total']}"

    # Band-specific фильтр применяем к continuous raw ДО нарезки: короткие
    # эпохи (250–1000 мс) короче FIR-фильтра и дают сильные искажения.
    if freq_band != "all" or single_freq is not None:
        progress("filter", message=f"Частотная фильтрация: {freq_band}")
        with journal.step(
            "analyze", "filter",
            note=f"band={freq_band}, single={single_freq}, custom={custom_min_freq}-{custom_max_freq}",
        ):
            raw = apply_band_filter(
                raw, freq_band,
                custom_min=custom_min_freq,
                custom_max=custom_max_freq,
                single_freq=single_freq,
                bandwidth_hz=settings.default_single_freq_bandwidth_hz,
            )

    progress("epochs", message=f"Нарезка эпох по {epoch_length_ms:.0f} мс")
    with journal.step(
        "analyze", "epochs",
        note=f"epoch={epoch_length_ms:g}ms, reject={settings.reject_threshold_uv:g}",
    ) as entry:
        epochs = segment_epochs(
            raw, annotations,
            epoch_length_ms=epoch_length_ms,
            reject_threshold_uv=settings.reject_threshold_uv,
        )
        entry.epochs = int(len(epochs.drop_log) if hasattr(epochs, "drop_log") else len(epochs))
    # len(epochs.events) — все созданные эпохи, len(epochs) — прошедшие reject
    n_epochs_total = int(len(epochs.events))
    n_epochs_used = int(len(epochs))

    progress("band_power", message="Спектральная мощность по диапазонам")
    with journal.step("analyze", "band_power", epochs=n_epochs_used):
        freq_powers = compute_band_power(epochs, settings.freq_bands)

    progress("dipoles", message="Фитинг диполей по эпохам")
    with journal.step(
        "analyze", "dipoles", epochs=n_epochs_used,
        note=f"decim={settings.dipole_fit_decim}, max_epochs={settings.dipole_fit_max_epochs}",
    ):
        dipoles = fit_dipoles_for_epochs(epochs, settings, freq_bands=freq_powers)

    progress("localize", message="Локализация: анатомия + поля Бродмана")
    with journal.step("analyze", "localize", epochs=n_epochs_used):
        dipoles = localize_dipoles(dipoles, settings)

    # Компактные best-fit диполи (таблица локализации + БД). Траектория сюда не
    # дублируется — она уже есть в dipoles[].trajectory.
    best_fit_dipoles: List[Dict[str, Any]] = []
    for d in dipoles:
        best = d.get("best_fit") or {}
        if not best:
            continue
        mni = best.get("mni_coords") or [0, 0, 0]
        best_fit_dipoles.append({
            "epoch_index": d.get("epoch_index"),
            "time_ms": best.get("time_ms"),
            "mni_x": mni[0], "mni_y": mni[1], "mni_z": mni[2],
            "amplitude_nam": best.get("amplitude_nam"),
            "gof": best.get("gof"),
            "anatomical_roi": best.get("anatomical_structure"),
            "brodmann_area": best.get("brodmann_area"),
        })

    versions = library_versions()
    pipeline = {
        "app_version": settings.app_version,
        "mne_version": versions["mne"],
        "numpy_version": versions["numpy"],
        "python_version": sys.version.split()[0],
        "epoch_length_ms": epoch_length_ms,
        "freq_band": freq_band,
        "single_freq": single_freq,
        "dipole_fit_decim": settings.dipole_fit_decim,
        "dipole_fit_max_epochs": settings.dipole_fit_max_epochs,
        "z_threshold": z_threshold,
        "pp_threshold_uv": pp_threshold_uv,
        "reject_threshold_uv": settings.reject_threshold_uv,
        "ica_requested": run_ica,
        "ica_applied": bool(artifact_stats.get("ica_applied")),
        "edf_units": settings.edf_units,
        "duration_sec": round(time.perf_counter() - started, 3),
        "created_at": datetime.utcnow(),
    }

    results_path = os.path.join(settings.results_dir, f"{session_id}.json")
    os.makedirs(settings.results_dir, exist_ok=True)
    result: Dict[str, Any] = {
        "session_id": session_id,
        "filename": filename,
        "n_channels": int(raw.info["nchan"]),
        "sfreq": float(raw.info["sfreq"]),
        "duration_sec": round(len(raw) / raw.info["sfreq"], 2),
        "epoch_length_ms": epoch_length_ms,
        "freq_band": freq_band,
        "n_epochs_total": n_epochs_total,
        "n_epochs_used": n_epochs_used,
        "n_epochs_dropped": n_epochs_total - n_epochs_used,
        "n_artifacts": artifact_stats["total"],
        "artifact_types": artifact_stats["by_type"],
        "frequency_powers": freq_powers,
        "surface": surface_ref(settings),
        # {} -> None: пустая траектория не должна ломать валидацию best_fit
        "dipoles": [{**d, "best_fit": d.get("best_fit") or None} for d in dipoles],
        "best_fit_dipoles": best_fit_dipoles,
        "results_file": results_path,
        "pipeline": pipeline,
    }

    # JSON-дамп результата: debug-артефакт и источник для повторного просмотра
    with open(results_path, "w") as f:
        json.dump(
            {
                "session_id": session_id,
                "filename": filename,
                "pipeline": pipeline,
                "frequency_powers": freq_powers,
                "dipoles": dipoles,
            },
            f, indent=2, default=str,
        )

    progress("done", 1.0, message="Готово")
    return result


async def save_analysis_to_db(result: Dict[str, Any]) -> None:
    """Сохраняет сессию и best-fit диполи в БД (async, вызывается в event-loop)."""
    from app.models.db import AsyncSessionLocal, init_db
    from app.models.db import Dipole as DipoleModel
    from app.models.db import Session as SessionModel

    # Траектория берётся из dipoles по epoch_index: в best_fit_dipoles её больше
    # нет (раньше дублировалась в обоих списках — лишний мегабайт в ответе).
    trajectories = {
        d.get("epoch_index"): d.get("trajectory")
        for d in result.get("dipoles") or []
    }

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
                trajectory_json=trajectories.get(d.get("epoch_index")),
            ))
        await session.commit()


def analysis_job_worker(
    progress: ProgressCallback,
    filepath: str,
    filename: str,
    upload_dir: str,
    epoch_length_ms: float,
    freq_band: str,
    custom_min_freq: Optional[float],
    custom_max_freq: Optional[float],
    single_freq: Optional[float],
    run_ica: bool,
    z_threshold: float,
    pp_threshold_uv: float,
) -> Dict[str, Any]:
    """Воркер задачи анализа (поток): пайплайн + удаление временной загрузки."""
    import shutil

    try:
        return run_analysis(
            progress, filepath, filename,
            epoch_length_ms, freq_band,
            custom_min_freq, custom_max_freq, single_freq,
            run_ica, z_threshold, pp_threshold_uv,
        )
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)


async def persist_job_result(job: Job, result: Dict[str, Any]) -> None:
    """Постобработка успешной задачи: запись в БД (в event-loop, не в потоке).

    Сбой БД не отменяет успешный расчёт: результат уже есть у клиента и в
    ``results_dir``, пользователь получает задачу со статусом ``succeeded``.
    """
    try:
        await save_analysis_to_db(result)
    except Exception:
        logger.exception("Не удалось сохранить результат задачи %s в БД", job.job_id)


def submit_uploaded_analysis(
    *,
    filepath: str,
    filename: str,
    upload_dir: str,
    epoch_length_ms: float,
    freq_band: str,
    custom_min_freq: Optional[float],
    custom_max_freq: Optional[float],
    single_freq: Optional[float],
    run_ica: bool,
    z_threshold: float,
    pp_threshold_uv: float,
) -> Job:
    """Ставит анализ загруженного файла в очередь задач (``POST /jobs``).

    Число одновременно выполняемых задач ограничивает ``job_manager`` (остальные
    ждут в очереди); воркер сам удаляет временную загрузку после чтения.
    """
    job = job_manager.submit(
        "analyze", filename, analysis_job_worker,
        filepath, filename, upload_dir,
        epoch_length_ms, freq_band,
        custom_min_freq, custom_max_freq, single_freq,
        run_ica, z_threshold, pp_threshold_uv,
        on_success=persist_job_result,
        meta={"epoch_length_ms": epoch_length_ms, "freq_band": freq_band},
    )
    logger.info("Создана задача %s (%s)", job.job_id, filename)
    return job
