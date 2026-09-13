"""REST API эндпоинты DipLock.

Контракт ответов описан Pydantic-моделями в ``app/schemas`` (F4): из OpenAPI
генерируются TypeScript-типы frontend. Тяжёлые статические ассеты (меш
fsaverage, атлас Brodmann) отдаются отдельными кэшируемыми эндпоинтами (F6),
долгий анализ — фоновыми задачами с прогрессом по этапам (F7).
"""
import asyncio
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
    JobCreated,
    JobStatus,
    MetaResponse,
    RecordingMeta,
    SurfaceOut,
    SurfaceRef,
)
from app.services.job_manager import ProgressCallback, job_manager
from app.services.recordings import recording_registry
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


async def _save_upload(file: UploadFile, safe_name: str) -> Tuple[str, str]:
    """Сохраняет загрузку в отдельный каталог с контролем размера (F10).

    Возвращает ``(путь_к_файлу, каталог_загрузки)``; каталог удаляет вызывающий
    код (в ``finally``) — при ошибке/413 частичный файл не остаётся на диске.
    """
    upload_dir = os.path.join(settings.upload_dir, str(uuid.uuid4()))
    os.makedirs(upload_dir, exist_ok=True)
    tmp_path = os.path.join(upload_dir, safe_name)

    size = 0
    try:
        with open(tmp_path, "wb") as out:
            while chunk := await file.read(_UPLOAD_CHUNK):
                size += len(chunk)
                if size > MAX_UPLOAD_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Файл слишком большой (макс {MAX_UPLOAD_SIZE // (1024 * 1024)} МБ)",
                    )
                out.write(chunk)
    except BaseException:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise
    finally:
        await file.close()
    return tmp_path, upload_dir


def _surface_ref() -> SurfaceRef:
    """Ссылка на кэшируемый меш: версия считается без построения данных (O(1))."""
    prefix = settings.api_prefix
    return SurfaceRef(
        version=asset_version(settings),
        url=f"{prefix}/surface",
        brodmann_url=f"{prefix}/surface/brodmann",
    )


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
    """``JobStatus`` из задачи; ``result_url`` заполняется только для успешных."""
    prefix = settings.api_prefix
    result_url = f"{prefix}/jobs/{job.job_id}/result" if job.status == "succeeded" else None
    return JobStatus(**job.as_dict(), result_url=result_url)


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
    tmp_path, upload_dir = await _save_upload(file, safe_name)

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
async def create_recording(file: UploadFile = File(...)) -> RecordingMeta:
    """Сохраняет EDF и возвращает паспорт записи (каналы, sfreq, длительность).

    Артефакты/эпохи/диполи здесь не считаются: обработка стартует отдельной
    задачей по кнопке «Пересчитать предподготовку» (docs/ui.md). Файл остаётся
    в ``data/edf/<recording_id>/`` — его читают эндпоинты просмотра; устаревшие
    записи реестр удаляет по TTL и лимиту истории.
    """
    safe_name = _safe_edf_name(file.filename)
    tmp_path, upload_dir = await _save_upload(file, safe_name)
    try:
        recording = await asyncio.to_thread(
            recording_registry.register, tmp_path, upload_dir, safe_name, settings,
        )
    except ValueError as e:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001 — отдаём UI понятный текст, не traceback
        shutil.rmtree(upload_dir, ignore_errors=True)
        logger.exception("Не удалось прочитать EDF %s", safe_name)
        raise HTTPException(status_code=400, detail=f"Не удалось прочитать EDF: {e}")
    return RecordingMeta(**recording.meta)


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
    return RecordingMeta(**recording.meta)


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
    tmp_path, upload_dir = await _save_upload(file, safe_name)

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
    )







