"""REST API эндпоинты DipLock.

Контракт ответов описан Pydantic-моделями в ``app/schemas`` (F4): из OpenAPI
генерируются TypeScript-типы frontend. Тяжёлые статические ассеты (меш
fsaverage, атлас Brodmann) отдаются отдельными кэшируемыми эндпоинтами (F6),
долгий анализ — фоновыми задачами с прогрессом по этапам (F7).
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import (
    APIRouter,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Response,
    UploadFile,
)

from app.core.config import settings
from app.schemas.analysis import (
    AnalyzeResponse,
    ArtifactThresholds,
    BrodmannAreaOut,
    BrodmannIndexOut,
    BrodmannLabelsOut,
    ContourSliceOut,
    ContoursOut,
    ContoursRef,
    DipoleScanResult,
    JobCreated,
    JobStatus,
    MetaResponse,
    MriSlicesOut,
    MriSliceRef,
    PreprocessResult,
    PreprocessStage,
    RecordingMeta,
    RecordingSignalsHeader,
    SpectrogramGridHeader,
    SpectrogramResult,
    SpectrumResult,
    SurfaceOut,
    SurfaceRef,
)
from app.services.dipole_scanner import DipoleScanParams, compute_dipole_scan
from app.services.job_manager import ProgressCallback, job_manager
from app.services.preprocess import PreprocessParams, run_preprocess
from app.services.spectral import (
    SpectrumParams,
    cached_topomap,
    compute_spectrum,
)
from app.services.spectrogram import (
    SpectrogramParams,
    cached_grid as cached_spectrogram_grid,
    compute_spectrogram,
    grid_url as spectrogram_grid_url,
    validate_params as validate_spectrogram_params,
)
from app.services.recording_signals import (
    SignalBuildError,
    build_signal_blob,
)
from app.services.recordings import Recording, recording_registry
from app.services.atlas_contours import (
    contours_meta,
    contours_ref as contour_ref,
    slice_contours,
)
from app.services.mri_slices import (
    mri_meta,
    slice_png as mri_slice_png,
    slice_ref as mri_slice_ref,
)
from app.services.surface_cache import (
    asset_version,
    brodmann_area_names,
    get_brodmann_area,
    get_brodmann_bytes,
    get_surface_bytes,
)
from app.utils.versions import library_versions as _library_versions

logger = logging.getLogger(__name__)

router = APIRouter()

# Максимальный размер загружаемого EDF (200 МБ)
MAX_UPLOAD_SIZE = 200 * 1024 * 1024
_UPLOAD_CHUNK = 1024 * 1024

# Имя загрузки: только basename и безопасные символы (F10 — защита от "../" и
# абсолютных путей, которые вывели бы запись за пределы upload_dir).
_UNSAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._+-]+")
_MAX_NAME_LEN = 128


def _noop_progress(stage: str, progress: Optional[float] = None, message: str = "") -> None:
    """Заглушка прогресса для синхронного ``/analyze`` (его некому показывать)."""


def _validate_analysis_params(
    epoch_length_ms: float, freq_band: str, single_freq: Optional[float],
) -> None:
    """Проверка параметров запроса: 400 с понятным для UI текстом."""
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


def _safe_edf_name(filename: Optional[str]) -> str:
    """Санитизация имени загружаемого файла (F10).

    Отбрасывает каталоги (в т.ч. ``../`` и Windows-пути), заменяет небезопасные
    символы, требует суффикс ``.edf``.
    """
    raw_name = (filename or "").replace("\\", "/").strip()
    base = os.path.basename(raw_name) or "recording.edf"
    base = _UNSAFE_NAME_RE.sub("_", base)[:_MAX_NAME_LEN]
    if not base.lower().endswith(".edf"):
        raise HTTPException(status_code=400, detail="Поддерживаются только файлы .edf")
    return base


async def _save_upload(
    file: UploadFile, safe_name: str, with_digest: bool = False,
) -> Tuple[str, str, Optional[str]]:
    """Сохраняет загрузку в отдельный каталог с контролем размера (F10).

    Возвращает ``(путь_к_файлу, каталог_загрузки, sha256)``; каталог удаляет
    вызывающий код (в ``finally``) — при ошибке/413 частичный файл не остаётся
    на диске. ``with_digest`` считает отпечаток содержимого в том же проходе по
    чанкам (нужен дедупу записей); ``/analyze`` и ``/jobs`` его не заказывают —
    они удаляют файл сразу после чтения.
    """
    upload_dir = os.path.join(settings.upload_dir, str(uuid.uuid4()))
    os.makedirs(upload_dir, exist_ok=True)
    tmp_path = os.path.join(upload_dir, safe_name)

    size = 0
    digest = hashlib.sha256() if with_digest else None
    try:
        with open(tmp_path, "wb") as out:
            while chunk := await file.read(_UPLOAD_CHUNK):
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Файл слишком большой (макс {MAX_UPLOAD_SIZE // (1024 * 1024)} МБ)",
                    )
                if digest is not None:
                    digest.update(chunk)
                out.write(chunk)
    except BaseException:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    return tmp_path, upload_dir, digest.hexdigest() if digest is not None else None


def _meta_out(recording: Recording, deduplicated: bool = False) -> RecordingMeta:
    """Паспорт записи для ответа.

    Флаг ``deduplicated`` — факт ответа на загрузку («файл уже хранился, копия не
    создана»), а не свойство файла: в сайдкар записи он не пишется, и обычная
    выдача паспорта (`GET /recordings/{id}`) его не выставляет.
    """
    return RecordingMeta(**recording.meta, deduplicated=deduplicated)


def _surface_ref() -> SurfaceRef:
    """Ссылка на кэшируемый меш: версия считается без построения данных (O(1))."""
    prefix = settings.api_prefix
    return SurfaceRef(
        version=asset_version(settings),
        url=f"{prefix}/surface",
        brodmann_url=f"{prefix}/surface/brodmann",
    )


def _mri_ref() -> MriSliceRef:
    """Ссылка на срезы МРТ: версия по отпечатку тома, без его сборки (O(1))."""
    return MriSliceRef(**mri_slice_ref(settings))


def _contours_ref() -> ContoursRef:
    """Ссылка на контуры атласа: версия по отпечатку файлов, без сборки (O(1))."""
    return ContoursRef(**contour_ref(settings))


def _run_analysis(
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
    передаётся заглушка. Меш fsaverage здесь НЕ строится: клиент получает
    ссылку на кэшируемый ассет (F6).
    """
    from app.services.artifact_detector import detect_artifacts
    from app.services.bandpass_filter import apply_band_filter, compute_band_power
    from app.services.dipole_fitter import fit_dipoles_for_epochs, localize_dipoles
    from app.services.edf_loader import load_edf
    from app.services.epoch_segmenter import segment_epochs

    started = time.perf_counter()
    session_id = str(uuid.uuid4())

    progress("load_edf", message="Чтение EDF, монтаж 10-20, average reference")
    raw = load_edf(filepath, settings.standard_channels, units=settings.edf_units)

    progress("artifacts", message="Детекция артефактов")
    annotations, artifact_stats = detect_artifacts(
        raw, settings, z_threshold, pp_threshold_uv, run_ica=run_ica,
    )

    # Band-specific фильтр применяем к continuous raw ДО нарезки: короткие
    # эпохи (250–1000 мс) короче FIR-фильтра и дают сильные искажения.
    if freq_band != "all" or single_freq is not None:
        progress("filter", message=f"Частотная фильтрация: {freq_band}")
        raw = apply_band_filter(
            raw, freq_band,
            custom_min=custom_min_freq,
            custom_max=custom_max_freq,
            single_freq=single_freq,
            bandwidth_hz=settings.default_single_freq_bandwidth_hz,
        )

    progress("epochs", message=f"Нарезка эпох по {epoch_length_ms:.0f} мс")
    epochs = segment_epochs(
        raw, annotations,
        epoch_length_ms=epoch_length_ms,
        reject_threshold_uv=settings.reject_threshold_uv,
    )
    # len(epochs.events) — все созданные эпохи, len(epochs) — прошедшие reject
    n_epochs_total = int(len(epochs.events))
    n_epochs_used = int(len(epochs))

    progress("band_power", message="Спектральная мощность по диапазонам")
    freq_powers = compute_band_power(epochs, settings.freq_bands)

    progress("dipoles", message="Фитинг диполей по эпохам")
    dipoles = fit_dipoles_for_epochs(epochs, settings, freq_bands=freq_powers)

    progress("localize", message="Локализация: анатомия + поля Бродмана")
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

    versions = _library_versions()
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
        "surface": _surface_ref().model_dump(),
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


async def _save_analysis_to_db(result: Dict[str, Any]) -> None:
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


def _analysis_job_worker(
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
    try:
        return _run_analysis(
            progress, filepath, filename,
            epoch_length_ms, freq_band,
            custom_min_freq, custom_max_freq, single_freq,
            run_ica, z_threshold, pp_threshold_uv,
        )
    finally:
        shutil.rmtree(upload_dir, ignore_errors=True)


async def _persist_job_result(job: Any, result: Dict[str, Any]) -> None:
    """Постобработка успешной задачи: запись в БД (в event-loop, не в потоке)."""
    try:
        await _save_analysis_to_db(result)
    except Exception:
        logger.exception("Не удалось сохранить результат задачи %s в БД", job.job_id)


def _job_status(job: Any) -> JobStatus:
    """``JobStatus`` из задачи; ``result_url`` заполняется только для успешных.

    У предподготовки результат лежит не в ``/jobs/{id}/result``, а рядом со
    записью (``/recordings/{id}/preprocess/{job_id}``) — это отдельный контракт
    (``PreprocessResult`` вместо ``AnalyzeResponse``).
    """
    prefix = settings.api_prefix
    result_url: Optional[str] = None
    if job.status == "succeeded":
        recording_id = job.meta.get("recording_id")
        # Задачи записи (предподготовка, спектр, диполи, спектрограмма) держат
        # результат рядом с записью: `/recordings/{id}/{kind}/{job_id}` —
        # отдельные контракты (`PreprocessResult`, `SpectrumResult`,
        # `DipoleScanResult`, `SpectrogramResult`).
        if recording_id and job.kind in ("preprocess", "spectrum", "dipoles", "spectrogram"):
            result_url = f"{prefix}/recordings/{recording_id}/{job.kind}/{job.job_id}"
        else:
            result_url = f"{prefix}/jobs/{job.job_id}/result"
    return JobStatus(**job.as_dict(), result_url=result_url)


def _recording_job(recording_id: str, job_id: str, kind: str) -> Any:
    """Задача записи нужного типа; 404/409 — как у результата предподготовки.

    Общий разбор для «задач записи»: чужой job, незавершённая или упавшая задача
    не должны отдавать результат, а UI показывает `detail` как есть.
    """
    job = job_manager.get(job_id)
    if job is None or job.kind != kind or job.meta.get("recording_id") != recording_id:
        raise HTTPException(
            status_code=404, detail=f"Задача {kind} {job_id} для записи {recording_id} не найдена",
        )
    if job.status == "failed":
        raise HTTPException(status_code=409, detail=f"Задача завершилась ошибкой: {job.error}")
    if job.status != "succeeded" or job.result is None:
        raise HTTPException(
            status_code=409,
            detail=f"Задача ещё не завершена (этап {job.stage}, прогресс {job.progress:.0%})",
        )
    return job


def _optional_band(band_min: Optional[float], band_max: Optional[float]) -> Optional[Tuple[float, float]]:
    """Полоса фильтра из формы: пара значений либо «без фильтра».

    Односторонняя полоса — ошибка: молча догадываться о второй границе нельзя,
    фильтр меняет и спектр, и локализацию.
    """
    if band_min is None and band_max is None:
        return None
    if band_min is None or band_max is None:
        raise HTTPException(
            status_code=400,
            detail="Полоса задаётся парой band_min и band_max либо не задаётся вовсе",
        )
    if band_min >= band_max:
        raise HTTPException(status_code=400, detail="band_min должен быть меньше band_max")
    return (band_min, band_max)


def _validate_epoch_length(epoch_length_ms: float) -> None:
    """Проверка длины эпохи: только значения из `epoch_lengths_ms` (DRY с панелью)."""
    if epoch_length_ms not in settings.epoch_lengths_ms:
        raise HTTPException(
            status_code=400,
            detail=f"epoch_length_ms должен быть одним из {settings.epoch_lengths_ms}",
        )


def _preprocess_job_worker(
    progress: ProgressCallback,
    recording: Any,
    params: PreprocessParams,
) -> Dict[str, Any]:
    """Воркер задачи предподготовки (поток): одна стадия на запись.

    Загрузку не удаляем (в отличие от ``/jobs``): файл записи принадлежит
    реестру просмотра и живёт по своему TTL.
    """
    return run_preprocess(recording, settings, params, progress)


def _spectrum_job_worker(
    progress: ProgressCallback,
    recording: Any,
    params: SpectrumParams,
) -> Dict[str, Any]:
    """Воркер задачи спектра (поток): Welch PSD + топокарты диапазонов."""
    return compute_spectrum(recording, settings, params, progress)


def _spectrogram_job_worker(
    progress: ProgressCallback,
    recording: Any,
    params: SpectrogramParams,
) -> Dict[str, Any]:
    """Воркер задачи спектрограммы (поток): STFT одного канала → сетка дБ."""
    return compute_spectrogram(recording, settings, params, progress)


def _dipole_scan_job_worker(
    progress: ProgressCallback,
    recording: Any,
    params: DipoleScanParams,
) -> Dict[str, Any]:
    """Воркер быстрого расчёта диполей (поток): перебор сетки по эпохам."""
    return compute_dipole_scan(recording, settings, params, progress)



@router.post("/analyze", response_model=AnalyzeResponse, summary="Синхронный анализ EDF")
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
) -> Dict[str, Any]:
    """Полный пайплайн одним запросом: EDF → артефакты → эпохи → фильтр → диполи.

    Удобно для curl/скриптов. Для UI используйте ``POST /jobs``: там есть
    прогресс по этапам, ограничение параллелизма, и результат не теряется при
    обрыве соединения. Тяжёлый меш fsaverage в ответ НЕ входит — только ссылка
    на кэшируемый ассет (``surface.url``).
    """
    _validate_analysis_params(epoch_length_ms, freq_band, single_freq)
    safe_name = _safe_edf_name(file.filename)
    tmp_path, upload_dir, _digest = await _save_upload(file, safe_name)

    try:
        result = await asyncio.to_thread(
            _run_analysis, _noop_progress, tmp_path, safe_name,
            epoch_length_ms, freq_band,
            custom_min_freq, custom_max_freq, single_freq,
            run_ica, z_threshold, pp_threshold_uv,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Анализ завершился ошибкой")
        raise HTTPException(status_code=500, detail=f"Ошибка анализа: {e}")
    finally:
        # Загрузка удаляется и после успеха (F10): файл уже прочитан
        shutil.rmtree(upload_dir, ignore_errors=True)

    # Сохранить в БД (не падаем при сбое БД)
    try:
        await _save_analysis_to_db(result)
    except Exception:
        logger.exception("Не удалось сохранить результат в БД")

    return result


@router.post(
    "/recordings", status_code=201, response_model=RecordingMeta,
    summary="Загрузить EDF для просмотра (без обработки)",
)
async def create_recording(
    file: UploadFile = File(...), response: Response = None,  # noqa: RUF013 — FastAPI инжектит Response
) -> RecordingMeta:
    """Сохраняет EDF и возвращает паспорт записи (каналы, sfreq, длительность).

    Артефакты/эпохи/диполи здесь не считаются: обработка стартует отдельной
    задачей по кнопке «Пересчитать предподготовку» (docs/ui.md). Файл остаётся
    в ``data/edf/<recording_id>/`` — его читают эндпоинты просмотра; устаревшие
    записи реестр удаляет по TTL и лимиту истории.

    Копии не плодятся: если файл с таким же содержимым (sha256) уже хранится, в
    том числе после рестарта процесса (отпечаток лежит в сайдкаре каталога),
    возвращается **существующая** запись с ``deduplicated=true`` (200), а только
    что записанная копия удаляется. Новая запись — 201.
    """
    safe_name = _safe_edf_name(file.filename)
    tmp_path, upload_dir, digest = await _save_upload(file, safe_name, with_digest=True)
    try:
        recording = await asyncio.to_thread(
            recording_registry.register, tmp_path, upload_dir, safe_name, settings, digest,
        )
    except ValueError as e:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001 — отдаём UI понятный текст, не traceback
        shutil.rmtree(upload_dir, ignore_errors=True)
        logger.exception("Не удалось прочитать EDF %s", safe_name)
        raise HTTPException(status_code=400, detail=f"Не удалось прочитать EDF: {e}")

    if recording.deduplicated:
        # Такой файл уже хранится: только что записанная копия не нужна
        shutil.rmtree(upload_dir, ignore_errors=True)
        if response is not None:
            response.status_code = 200
        logger.info(
            "Загрузка %s: открыта существующая запись %s", safe_name, recording.recording_id,
        )
    return _meta_out(recording, recording.deduplicated)


@router.get(
    "/recordings/{recording_id}", response_model=RecordingMeta,
    summary="Паспорт записи",
)
async def get_recording(recording_id: str) -> RecordingMeta:
    """Метаданные загруженной записи. 404 — неизвестна, устарела (TTL) или удалена."""
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    return _meta_out(recording)


@router.get(
    "/recordings/{recording_id}/signals",
    response_class=Response,
    responses={200: {"model": RecordingSignalsHeader, "content": {"application/octet-stream": {}}}},
    summary="Сигналы записи: float32-огибающая уровня зума (ETag)",
)
async def get_recording_signals(
    recording_id: str,
    level: int = Query(default=1, ge=1, description="Уровень пирамиды (множитель зума ×1…×16)"),
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Огибающая сигналов для вьюера треков (срез 2.5, docs/ui.md §8).

    Ответ — бинарный контейнер float32 (см. ``RecordingSignalsHeader``):
    ``DPS1`` | ``uint32 LE len(header)`` | JSON-заголовок | payload каналов.
    Минимумы/максимумы считаются по временным корзинам, поэтому пики артефактов
    не теряются при прореживании. Уровень отдаётся с ``ETag``: повторный запрос
    с тем же ``If-None-Match`` получает 304, а сам уровень кэшируется на диске.
    """
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    try:
        data, version = await asyncio.to_thread(build_signal_blob, recording, level, settings)
    except SignalBuildError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    headers = {
        "ETag": f'"{version}"',
        # Запись живёт по TTL реестра, поэтому кэшируем приватно и недолго
        "Cache-Control": "private, max-age=3600",
        "X-Signal-Level": str(level),
    }
    if if_none_match and version in if_none_match:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="application/octet-stream", headers=headers)


def _parse_reference_channels(raw: Optional[str]) -> Optional[List[str]]:
    """Разбирает список каналов референса из формы (``F3,F4`` → ``['F3','F4']``)."""
    if not raw:
        return None
    names = [name.strip() for name in raw.split(",") if name.strip()]
    return names or None


@router.post(
    "/recordings/{recording_id}/preprocess", status_code=202, response_model=JobCreated,
    summary="Запустить стадию предподготовки (filter / artifacts / epochs)",
)
async def create_preprocess_job(
    recording_id: str,
    stage: PreprocessStage = Form(..., description="Стадия: filter | artifacts | epochs"),
    band_min: Optional[float] = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: Optional[float] = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: Optional[float] = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: Optional[str] = Form(None, description="Каналы референса через запятую"),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
    flat_line_uv: float = Form(5.0),
    flat_line_ms: float = Form(200.0),
    run_ica: bool = Form(False, description="ICA-ветка детекции (тяжёлая — по умолчанию выключена)"),
    epoch_length_ms: float = Form(2000.0),
    reject_threshold_uv: float = Form(150.0),
) -> JobCreated:
    """Предподготовка записи **по кнопке**: одна стадия = одна задача.

    Правка параметров в UI ничего не запускает (docs/ui.md) — расчёт стартует
    только этим запросом. Стадии раздельные: пересчёт фильтра не обесценивает
    найденные артефакты, а результат каждой стадии клиент подтверждает снимком
    параметров (`stageApplied` в сторе раздела).

    Задача возвращается сразу (202 + ``job_id``): прогресс — в ``GET /jobs/{id}``,
    результат — в ``GET /recordings/{id}/preprocess/{job_id}``.
    """
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )

    band = _optional_band(band_min, band_max)

    if stage == "epochs":
        _validate_epoch_length(epoch_length_ms)

    params = PreprocessParams(
        stage=stage,
        filter_band=band,
        notch_hz=notch_hz,
        reference=reference,
        reference_channels=_parse_reference_channels(reference_channels),
        z_threshold=z_threshold,
        pp_threshold_uv=pp_threshold_uv,
        flat_line_uv=flat_line_uv,
        flat_line_ms=flat_line_ms,
        run_ica=run_ica,
        epoch_length_ms=epoch_length_ms,
        reject_threshold_uv=reject_threshold_uv,
    )

    job = job_manager.submit(
        "preprocess", recording.filename, _preprocess_job_worker,
        recording, params,
        meta={"recording_id": recording_id, "stage": stage},
    )
    prefix = settings.api_prefix
    logger.info("Создана задача предподготовки %s (%s, стадия %s)", job.job_id, recording_id, stage)
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/recordings/{recording_id}/preprocess/{job.job_id}",
    )


@router.get(
    "/recordings/{recording_id}/preprocess/{job_id}", response_model=PreprocessResult,
    summary="Результат стадии предподготовки",
)
async def get_preprocess_result(recording_id: str, job_id: str) -> PreprocessResult:
    """Результат стадии. 409 — задача идёт или упала; 404 — чужой/неизвестный job."""
    job = job_manager.get(job_id)
    if job is None or job.kind != "preprocess" or job.meta.get("recording_id") != recording_id:
        raise HTTPException(
            status_code=404, detail=f"Задача предподготовки {job_id} для записи {recording_id} не найдена",
        )
    if job.status == "failed":
        raise HTTPException(status_code=409, detail=f"Задача завершилась ошибкой: {job.error}")
    if job.status != "succeeded" or job.result is None:
        raise HTTPException(
            status_code=409,
            detail=f"Задача ещё не завершена (этап {job.stage}, прогресс {job.progress:.0%})",
        )
    return PreprocessResult(**job.result)


@router.post(
    "/recordings/{recording_id}/spectrum", status_code=202, response_model=JobCreated,
    summary="Запустить расчёт спектра по диапазонам (Welch PSD)",
)
async def create_spectrum_job(
    recording_id: str,
    band_min: Optional[float] = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: Optional[float] = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: Optional[float] = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: Optional[str] = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(2000.0, description="Длина эпохи для PSD"),
    reject_threshold_uv: float = Form(150.0, description="Порог reject: эпохи выше — не в спектр"),
) -> JobCreated:
    """Спектр записи по ритмам δ…γ — фоновой задачей (202 + ``job_id``).

    Ответ задачи (``GET /recordings/{id}/spectrum/{job_id}``) содержит числа PSD
    и ссылки на топокарты диапазонов; картинки отдаёт отдельный кэшируемый
    эндпоинт ``/spectrum/topomap/{band}.png`` с ETag/304. Расчёт стартует только
    этим запросом (правило «обработка — по кнопке», docs/ui.md).
    """
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    band = _optional_band(band_min, band_max)
    _validate_epoch_length(epoch_length_ms)

    params = SpectrumParams(
        filter_band=band,
        notch_hz=notch_hz,
        epoch_length_ms=epoch_length_ms,
        reference=reference,
        reference_channels=_parse_reference_channels(reference_channels),
        reject_threshold_uv=reject_threshold_uv,
    )
    job = job_manager.submit(
        "spectrum", recording.filename, _spectrum_job_worker, recording, params,
        meta={"recording_id": recording_id, "epoch_length_ms": epoch_length_ms},
    )
    prefix = settings.api_prefix
    logger.info("Создана задача спектра %s (%s)", job.job_id, recording_id)
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/recordings/{recording_id}/spectrum/{job.job_id}",
    )


@router.get(
    "/recordings/{recording_id}/spectrum/{job_id}", response_model=SpectrumResult,
    summary="Результат расчёта спектра",
)
async def get_spectrum_result(recording_id: str, job_id: str) -> SpectrumResult:
    """Числа PSD по диапазонам и ссылки на топокарты. 409 — задача идёт/упала."""
    return SpectrumResult(**_recording_job(recording_id, job_id, "spectrum").result)


@router.get(
    "/recordings/{recording_id}/spectrum/topomap/{band}.png",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
    summary="Топокарта диапазона (PNG, ETag)",
)
async def get_spectrum_topomap(
    recording_id: str,
    band: str,
    band_min: Optional[float] = Query(None, description="Полоса фильтра, нижняя граница, Гц"),
    band_max: Optional[float] = Query(None, description="Полоса фильтра, верхняя граница, Гц"),
    notch_hz: Optional[float] = Query(None, description="Сетевой фильтр, Гц"),
    epoch_length_ms: float = Query(2000.0, description="Длина эпохи для PSD"),
    reject_threshold_uv: float = Query(150.0, description="Порог reject"),
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Response:
    """PNG топокарты ритма в раскладке скальпа; вне круга голова прозрачна.

    Параметры фильтра и эпохи входят в ETag: картинка соответствует **своему**
    расчёту, и смена фильтра не отдаёт старую. Кэш — дисковый, поэтому повторный
    запрос не пересчитывает PSD, а промах кэша пересчитывает (как пирамида
    сигналов, 2.5). Неизвестный диапазон — 400, чужая запись — 404.
    """
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    params = SpectrumParams(
        filter_band=_optional_band(band_min, band_max),
        notch_hz=notch_hz,
        epoch_length_ms=epoch_length_ms,
        reject_threshold_uv=reject_threshold_uv,
    )
    try:
        data, version = await asyncio.to_thread(
            cached_topomap, recording, settings, params, band,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    etag = f'"{version}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=86400",
        "X-Spectrum-Band": band,
    }
    if if_none_match and etag in if_none_match:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="image/png", headers=headers)


@router.post(
    "/recordings/{recording_id}/dipoles", status_code=202, response_model=JobCreated,
    summary="Быстрый расчёт диполей (перебор сетки, одна точка на эпоху)",
)
async def create_dipole_scan_job(
    recording_id: str,
    band_min: Optional[float] = Form(None, description="Нижняя граница полосы, Гц"),
    band_max: Optional[float] = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: Optional[float] = Form(None, description="Сетевой фильтр 50/60 Гц"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: Optional[str] = Form(None, description="Каналы референса через запятую"),
    epoch_length_ms: float = Form(1000.0, description="Длина эпохи для расчёта"),
    reject_threshold_uv: float = Form(150.0, description="Порог reject эпох"),
    grid_mm: float = Form(7.0, ge=2.0, le=20.0, description="Шаг объёмной сетки поиска, мм"),
) -> JobCreated:
    """Быстрый режим («fast»): одна точка на эпоху в пике GFP на сетке узлов.

    Точный фитинг (`mne.fit_dipole` на BEM) — отдельный профиль; здесь результат
    помечен ``method='fast_grid'``, и UI показывает эту метку, а не выдаёт быстрый
    расчёт за точный (`docs/ui.md` §12).
    """
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    band = _optional_band(band_min, band_max)
    _validate_epoch_length(epoch_length_ms)

    params = DipoleScanParams(
        filter_band=band,
        notch_hz=notch_hz,
        epoch_length_ms=epoch_length_ms,
        reject_threshold_uv=reject_threshold_uv,
        reference=reference,
        reference_channels=_parse_reference_channels(reference_channels),
        grid_mm=grid_mm,
    )
    job = job_manager.submit(
        "dipoles", recording.filename, _dipole_scan_job_worker, recording, params,
        meta={"recording_id": recording_id, "epoch_length_ms": epoch_length_ms},
    )
    prefix = settings.api_prefix
    logger.info("Создана задача расчёта диполей %s (%s)", job.job_id, recording_id)
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/recordings/{recording_id}/dipoles/{job.job_id}",
    )


@router.get(
    "/recordings/{recording_id}/dipoles/{job_id}", response_model=DipoleScanResult,
    summary="Результат быстрого расчёта диполей",
)
async def get_dipole_scan_result(recording_id: str, job_id: str) -> DipoleScanResult:
    """Точки диполей (MNI, момент, амплитуда, GOF). 409 — задача идёт или упала."""
    return DipoleScanResult(**_recording_job(recording_id, job_id, "dipoles").result)


@router.post(
    "/recordings/{recording_id}/spectrogram", status_code=202, response_model=JobCreated,
    summary="Запустить расчёт спектрограммы канала (STFT)",
)
async def create_spectrogram_job(
    recording_id: str,
    channel: str = Form("", description="Канал, по которому считается спектрограмма"),
    band_min: Optional[float] = Form(None, description="Нижняя граница полосы, Гц; без пары — без фильтра"),
    band_max: Optional[float] = Form(None, description="Верхняя граница полосы, Гц"),
    notch_hz: Optional[float] = Form(None, description="Сетевой фильтр 50/60 Гц (None — выключен)"),
    reference: str = Form("average", description="average | custom"),
    reference_channels: Optional[str] = Form(None, description="Каналы референса через запятую"),
    window_ms: float = Form(500.0, description="Длина окна STFT, мс"),
    overlap_pct: float = Form(75.0, description="Перекрытие окон, %"),
    fmax_hz: float = Form(40.0, description="Верхняя частота сетки, Гц"),
) -> JobCreated:
    """Спектрограмма выбранного канала — фоновой задачей (202 + ``job_id``).

    Ответ задачи (``GET /recordings/{id}/spectrogram/{job_id}``) отдаёт
    **метаданные** сетки и ссылку на числа; сами числа приходят бинарным
    контейнером (``…/grid.bin``, ``SpectrogramGridHeader``): строк на частоты ×
    столбцов на времена слишком много для JSON-ответа. Палитра, окно дБ и
    сглаживание — параметры просмотра UI, они сетку не пересчитывают.
    """
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    params = SpectrogramParams(
        channel=channel,
        filter_band=_optional_band(band_min, band_max),
        notch_hz=notch_hz,
        reference=reference,
        reference_channels=_parse_reference_channels(reference_channels),
        window_ms=window_ms,
        overlap_pct=overlap_pct,
        fmax_hz=fmax_hz,
    )
    try:
        validate_spectrogram_params(params, settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    job = job_manager.submit(
        "spectrogram", recording.filename, _spectrogram_job_worker, recording, params,
        meta={"recording_id": recording_id, "channel": channel},
    )
    prefix = settings.api_prefix
    logger.info("Создана задача спектрограммы %s (%s)", job.job_id, recording_id)
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/recordings/{recording_id}/spectrogram/{job.job_id}",
    )


@router.get(
    "/recordings/{recording_id}/spectrogram/{job_id}", response_model=SpectrogramResult,
    summary="Результат расчёта спектрограммы (метаданные сетки)",
)
async def get_spectrogram_result(recording_id: str, job_id: str) -> SpectrogramResult:
    """Метаданные сетки + ссылка на числа. 409 — задача идёт или упала.

    ``grid_url`` собирается здесь, а не в воркере: воркер не знает ``job_id``
    (задача создаётся после него), а ссылка адресуется именно задаче.
    """
    job = _recording_job(recording_id, job_id, "spectrogram")
    result = dict(job.result)
    result["grid_url"] = spectrogram_grid_url(settings, recording_id, job_id)
    return SpectrogramResult(**result)


@router.get(
    "/recordings/{recording_id}/spectrogram/{job_id}/grid.bin",
    response_class=Response,
    responses={200: {"model": SpectrogramGridHeader, "content": {"application/octet-stream": {}}}},
    summary="Сетка спектрограммы: float32 дБ (ETag)",
)
async def get_spectrogram_grid(
    recording_id: str,
    job_id: str,
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Сетка уровней (дБ) как бинарный контейнер ``DPS2`` с ETag/304.

    Параметры расчёта берутся из **результата задачи**, а не из query: сетка
    соответствует именно тому расчёту, который показан на экране. При промахе
    дискового кэша сетка пересчитывается (как топокарты, 3.4).
    """
    job = _recording_job(recording_id, job_id, "spectrogram")
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    result = job.result
    band = result.get("filter_band_hz")
    params = SpectrogramParams(
        channel=result["channel"],
        filter_band=(band[0], band[1]) if band and len(band) == 2 else None,
        notch_hz=result.get("notch_hz"),
        window_ms=float(result["window_ms"]),
        overlap_pct=float(result["overlap_pct"]),
        fmax_hz=float(result["fmax_hz"]),
    )
    try:
        data, version = await asyncio.to_thread(
            cached_spectrogram_grid, recording, settings, params,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    etag = f'"{version}-{params.channel}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=86400",
        "X-Spectrogram-Channel": params.channel,
        "X-Spectrogram-Version": version,
    }
    if if_none_match and etag in if_none_match:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="application/octet-stream", headers=headers)



@router.post(
    "/jobs", status_code=202, response_model=JobCreated,
    summary="Запустить анализ фоновой задачей (с прогрессом)",
)
async def create_analysis_job(
    file: UploadFile = File(...),
    epoch_length_ms: float = Form(2000.0),
    freq_band: str = Form("all"),
    custom_min_freq: Optional[float] = Form(None),
    custom_max_freq: Optional[float] = Form(None),
    single_freq: Optional[float] = Form(None),
    run_ica: bool = Form(True),
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
) -> JobCreated:
    """Основной вход для UI: 202 + ``job_id``, далее поллинг ``GET /jobs/{id}``.

    Параметры те же, что у ``POST /analyze``. Число одновременно выполняемых
    задач ограничено ``MAX_CONCURRENT_JOBS`` (остальные ждут в очереди).
    """
    _validate_analysis_params(epoch_length_ms, freq_band, single_freq)
    safe_name = _safe_edf_name(file.filename)
    tmp_path, upload_dir, _digest = await _save_upload(file, safe_name)

    job = job_manager.submit(
        "analyze", safe_name, _analysis_job_worker,
        tmp_path, safe_name, upload_dir,
        epoch_length_ms, freq_band,
        custom_min_freq, custom_max_freq, single_freq,
        run_ica, z_threshold, pp_threshold_uv,
        on_success=_persist_job_result,
        meta={"epoch_length_ms": epoch_length_ms, "freq_band": freq_band},
    )
    prefix = settings.api_prefix
    logger.info("Создана задача %s (%s)", job.job_id, safe_name)
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/jobs/{job.job_id}/result",
    )


@router.get("/jobs", response_model=List[JobStatus], summary="История задач")
async def list_jobs(limit: int = Query(20, ge=1, le=200)) -> List[JobStatus]:
    """Последние задачи (новые — в конце списка)."""
    return [_job_status(job) for job in job_manager.list_jobs(limit)]


@router.get("/jobs/{job_id}", response_model=JobStatus, summary="Состояние задачи")
async def get_job(job_id: str) -> JobStatus:
    """Этап, прогресс (0..1) и ошибка задачи — для прогресс-бара UI."""
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Задача {job_id} не найдена")
    return _job_status(job)


@router.get(
    "/jobs/{job_id}/result", response_model=AnalyzeResponse,
    summary="Результат завершённой задачи",
)
async def get_job_result(job_id: str) -> Dict[str, Any]:
    """Результат анализа. 409 — задача ещё идёт или завершилась ошибкой."""
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Задача {job_id} не найдена")
    if job.status == "failed":
        raise HTTPException(status_code=409, detail=f"Задача завершилась ошибкой: {job.error}")
    if job.status != "succeeded" or job.result is None:
        raise HTTPException(
            status_code=409,
            detail=f"Задача ещё не завершена (этап {job.stage}, прогресс {job.progress:.0%})",
        )
    return job.result


def _asset_response(
    data: bytes, version: str, if_none_match: Optional[str], max_age: int = 86400,
) -> Response:
    """Отдаёт кэшированный JSON-ассет; 304, если ``If-None-Match`` совпал (F6)."""
    headers = {"ETag": f'"{version}"', "Cache-Control": f"public, max-age={max_age}"}
    if if_none_match and version in if_none_match:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="application/json", headers=headers)


@router.get(
    "/surface",
    response_class=Response,
    responses={200: {"model": SurfaceOut, "content": {"application/json": {}}}},
    summary="Меш fsaverage (кэш + ETag)",
)
async def get_surface(
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Децимированный меш lh/rh без тяжёлых BA-индексов.

    Ответ — готовые байты из кэша (без сериализации на каждый запрос); схема
    ``SurfaceOut`` описана в OpenAPI. Повторный запрос с тем же ``If-None-Match``
    получает 304.
    """
    try:
        data, version = get_surface_bytes(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")
    return _asset_response(data, version, if_none_match)


@router.get(
    "/surface/brodmann",
    response_class=Response,
    responses={200: {"model": BrodmannIndexOut, "content": {"application/json": {}}}},
    summary="Индексы вершин всех полей Бродмана (тяжёлый ассет)",
)
async def get_brodmann_all(
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Все метки PALS_B12_Brodmann (≈2 МБ).

    Для одной области используйте ``/surface/brodmann/{area_name}`` — там ответ
    в десятки раз меньше.
    """
    try:
        data, version = get_brodmann_bytes(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")
    return _asset_response(data, version, if_none_match, max_age=604800)


@router.get(
    "/surface/brodmann/{area_name}", response_model=BrodmannAreaOut,
    summary="Индексы вершин одного поля Бродмана",
)
async def get_brodmann_one(area_name: str) -> Dict[str, Any]:
    """Лёгкий ответ по конкретной области (например ``BA17-lh``)."""
    try:
        area = get_brodmann_area(settings, area_name)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")
    if area is None:
        raise HTTPException(status_code=404, detail=f"Поле Бродмана {area_name} не найдено")
    return area


@router.get(
    "/surface/mri", response_model=MriSlicesOut,
    summary="Метаданные срезов МРТ (T1, MNI-сетка)",
)
async def get_mri_slices() -> Dict[str, Any]:
    """Границы, шаг сетки, плоскости и окно яркости срезов.

    Первое обращение собирает том на MNI-сетке из ``T1.mgz`` + ``brainmask.mgz``
    (≈0.7 с) и кладёт его в ``cache_dir/mri``; дальше ответ мгновенный. Сами срезы
    отдаются картинками (``/surface/mri/slice/...``), а не в этом ответе.
    """
    try:
        return mri_meta(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")


@router.get(
    "/surface/mri/slice/{plane}/{mm}.png",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
    summary="Срез МРТ картинкой (PNG, ETag)",
)
async def get_mri_slice(
    plane: str,
    mm: float,
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Response:
    """PNG среза (серый + альфа) в раскладке проекций UI.

    Значение среза квантуется сеткой тома (1 мм), фактическое значение возвращается
    заголовком ``X-Mri-Slice-Mm`` — расхождение с дробным срезом UI видно сразу.
    Неизвестная плоскость — 404, недоступный том — 503, повторный запрос с тем же
    ``If-None-Match`` — 304.
    """
    try:
        data, version, actual_mm = mri_slice_png(settings, plane, mm)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")

    etag = f'"{version}-{plane}-{actual_mm:g}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "public, max-age=604800",
        "X-Mri-Slice-Mm": f"{actual_mm:g}",
    }
    if if_none_match and etag in if_none_match:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="image/png", headers=headers)


@router.get(
    "/surface/contours", response_model=ContoursOut,
    summary="Метаданные контуров атласа (структуры и поля Бродмана)",
)
async def get_contours() -> Dict[str, Any]:
    """Шаг сетки, допуски упрощения, число меток и метод BA-разметки.

    Первое обращение собирает объёмы меток из ``aparc+aseg.mgz`` и ленты коры
    ``lh/rh.ribbon.mgz`` (≈1 с) и кладёт их в ``cache_dir/contours``; дальше ответ
    мгновенный. Сами контуры отдаются по срезу (``/surface/contours/{plane}/{mm}``).
    """
    try:
        return contours_meta(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")


@router.get(
    "/surface/contours/{plane}/{mm}", response_model=ContourSliceOut,
    summary="Контуры среза: анатомические структуры и поля Бродмана (ETag)",
)
async def get_contour_slice(
    plane: str,
    mm: float,
    if_none_match: Optional[str] = Header(default=None, alias="If-None-Match"),
) -> Response:
    """Полигоны меток среза в миллиметрах MNI по осям плоскости.

    Срез квантуется сеткой атласа (1 мм), фактическое значение возвращается полем
    ``mm`` ответа и заголовком ``X-Contour-Mm``. Неизвестная плоскость или срез вне
    сетки — 404, недоступный атлас — 503, повторный запрос с тем же ``If-None-Match``
    — 304. Поля Бродмана размечены **производно** (``method`` в ответе): метки PALS
    живут на поверхности коры, в объём они переносятся по ближайшей вершине.
    """
    try:
        payload = slice_contours(settings, plane, mm)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")

    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    actual_mm = float(payload["mm"])
    etag = f'"{payload["version"]}-{plane}-{actual_mm:g}"'
    headers = {
        "ETag": etag,
        "Cache-Control": "public, max-age=604800",
        "X-Contour-Mm": f"{actual_mm:g}",
    }
    if if_none_match and etag in if_none_match:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="application/json", headers=headers)


@router.get(
    "/brodmann-labels", response_model=BrodmannLabelsOut,
    summary="Имена доступных полей Бродмана",
)
async def get_brodmann_labels() -> Dict[str, Any]:
    """Список меток из кэша атласа (без чтения файлов MNE на каждый запрос)."""
    try:
        names = brodmann_area_names(settings)
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")
    return {"brodmann_areas": names, "count": len(names), "version": asset_version(settings)}


@router.get(
    "/brain-surface", deprecated=True, response_class=Response,
    responses={200: {"model": SurfaceOut, "content": {"application/json": {}}}},
    summary="Устаревший алиас /surface",
)
async def get_brain_surface_legacy(
    include_ba: bool = Query(False, description="Добавить ba_labels (тяжело, ≈2 МБ)"),
) -> Response:
    """Совместимость со старым контрактом: меш + (опционально) BA-индексы."""
    try:
        data, version = get_surface_bytes(settings)
        if include_ba:
            ba_bytes, _ = get_brodmann_bytes(settings)
            areas = json.loads(ba_bytes).get("areas", {})
            mesh = json.loads(data)
            mesh["ba_labels"] = {
                name: {key: value for key, value in area.items() if key != "name"}
                for name, area in areas.items()
            }
            data = json.dumps(mesh, separators=(",", ":")).encode("utf-8")
    except (FileNotFoundError, OSError) as exc:
        raise HTTPException(status_code=503, detail=f"Данные fsaverage недоступны: {exc}")
    return _asset_response(data, version, None)


@router.get("/meta", response_model=MetaResponse, summary="Версии, окружение и параметры")
async def get_meta() -> MetaResponse:
    """Всё, что нужно разделу «Состояние сервера» и provenance результата (F16)."""
    from sqlalchemy.engine import make_url

    versions = _library_versions()
    prefix = settings.api_prefix
    return MetaResponse(
        app=settings.app_name,
        app_version=settings.app_version,
        api_prefix=prefix,
        python_version=sys.version.split()[0],
        platform=sys.platform,
        mne_version=versions["mne"] or "unknown",
        numpy_version=versions["numpy"] or "unknown",
        scipy_version=versions["scipy"] or "unknown",
        sqlalchemy_version=versions["sqlalchemy"] or "unknown",
        trimesh_version=versions["trimesh"],
        subjects_dir=settings.subjects_dir,
        fsaverage_trans=settings.fsaverage_trans,
        upload_dir=settings.upload_dir,
        results_dir=settings.results_dir,
        cache_dir=settings.cache_dir,
        # Только драйвер БД: DSN с паролем наружу не отдаём
        database_backend=make_url(settings.database_url).drivername,
        surface_version=asset_version(settings),
        surface_url=f"{prefix}/surface",
        standard_channels=list(settings.standard_channels),
        epoch_lengths_ms=list(settings.epoch_lengths_ms),
        freq_bands={
            name: [float(fmin), float(fmax)]
            for name, (fmin, fmax) in settings.freq_bands.items()
        },
        signal_levels=[int(level) for level in settings.signal_levels],
        signal_base_points=settings.signal_base_points,
        artifact_thresholds=ArtifactThresholds(
            z_score_threshold=settings.z_score_threshold,
            peak_to_peak_threshold_uv=settings.peak_to_peak_threshold_uv,
            flat_line_threshold_uv=settings.flat_line_threshold_uv,
            flat_line_min_duration_ms=settings.flat_line_min_duration_ms,
            reject_threshold_uv=settings.reject_threshold_uv,
        ),
        dipole_fit_decim=settings.dipole_fit_decim,
        dipole_fit_max_epochs=settings.dipole_fit_max_epochs,
        max_concurrent_jobs=job_manager.max_concurrent,
        cors_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
        mri_slices=_mri_ref(),
        contours=_contours_ref(),
    )







