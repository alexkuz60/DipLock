"""Задачи записи: запуск, статус, результат (A1, этап 3).

Пять «задач записи» (``preprocess`` / ``spectrum`` / ``dipoles`` /
``spectrogram``) отличаются только формой запроса и воркером. Всё остальное у
них общее, и это общее живёт здесь:

* ``require_recording`` — 404 с текстом для UI, если запись неизвестна/устарела;
* воркеры ``worker_*`` — тонкие обёртки сервисов, исполняются в потоке;
* ``submit_recording_job`` — 202 + ``job_id`` и ``result_url`` рядом с записью
  (``/recordings/{id}/{kind}/{job_id}``): контракт результата у каждого вида
  задачи свой (``PreprocessResult``, ``SpectrumResult``, ``DipoleScanResult``,
  ``SpectrogramResult``), поэтому и адрес не общий;
* ``job_status`` — статус задачи для поллинга; новый ``kind`` обязан появиться и
  здесь, и в `_drop_signal_cache` (правило 2 в ``docs/rules/api-jobs.md``);
* ``recording_job_result`` — разбор результата: чужой/неизвестный job — 404,
  незавершённый или упавший — 409 (UI показывает ``detail`` как есть).
"""
import logging
from typing import Any, Callable, Dict, Optional, Tuple

from fastapi import HTTPException

from app.core.config import settings
from app.schemas.analysis import JobCreated, JobStatus
from app.services.dipole_scanner import DipoleScanParams, compute_dipole_scan
from app.services.job_manager import ProgressCallback, job_manager
from app.services.preprocess import PreprocessParams, run_preprocess
from app.services.recordings import Recording, recording_registry
from app.services.spectral import SpectrumParams, compute_spectrum
from app.services.spectrogram import SpectrogramParams, compute_spectrogram

logger = logging.getLogger(__name__)

# Виды задач, чей результат лежит рядом с записью, а не в `/jobs/{id}/result`
RECORDING_JOB_KINDS: Tuple[str, ...] = ("preprocess", "spectrum", "dipoles", "spectrogram")


def require_recording(recording_id: str) -> Recording:
    """Запись из реестра или 404: неизвестна, устарела по TTL или уже удалена."""
    recording = recording_registry.get(recording_id)
    if recording is None:
        raise HTTPException(
            status_code=404, detail=f"Запись {recording_id} не найдена или уже удалена",
        )
    return recording


def worker_preprocess(
    progress: ProgressCallback, recording: Recording, params: PreprocessParams,
) -> Dict[str, Any]:
    """Воркер задачи предподготовки (поток): одна стадия на запись.

    Загрузку не удаляем (в отличие от ``/jobs``): файл записи принадлежит
    реестру просмотра и живёт по своему TTL.
    """
    return run_preprocess(recording, settings, params, progress)


def worker_spectrum(
    progress: ProgressCallback, recording: Recording, params: SpectrumParams,
) -> Dict[str, Any]:
    """Воркер задачи спектра (поток): Welch PSD + топокарты диапазонов."""
    return compute_spectrum(recording, settings, params, progress)


def worker_spectrogram(
    progress: ProgressCallback, recording: Recording, params: SpectrogramParams,
) -> Dict[str, Any]:
    """Воркер задачи спектрограммы (поток): STFT одного канала → сетка дБ."""
    return compute_spectrogram(recording, settings, params, progress)


def worker_dipole_scan(
    progress: ProgressCallback, recording: Recording, params: DipoleScanParams,
) -> Dict[str, Any]:
    """Воркер быстрого расчёта диполей (поток): перебор сетки по эпохам."""
    return compute_dipole_scan(recording, settings, params, progress)


WORKERS: Dict[str, Callable[..., Dict[str, Any]]] = {
    "preprocess": worker_preprocess,
    "spectrum": worker_spectrum,
    "spectrogram": worker_spectrogram,
    "dipoles": worker_dipole_scan,
}


def submit_recording_job(
    kind: str,
    recording: Recording,
    params: Any,
    *,
    meta: Optional[Dict[str, Any]] = None,
) -> JobCreated:
    """Ставит задачу записи в очередь и собирает ``JobCreated`` (202 + ``job_id``)."""
    job = job_manager.submit(
        kind, recording.filename, WORKERS[kind], recording, params,
        meta={"recording_id": recording.recording_id, **(meta or {})},
    )
    logger.info("Создана задача %s %s (%s)", kind, job.job_id, recording.recording_id)
    prefix = settings.api_prefix
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/recordings/{recording.recording_id}/{kind}/{job.job_id}",
    )


def job_status(job: Any) -> JobStatus:
    """``JobStatus`` из задачи; ``result_url`` заполняется только для успешных.

    У задач записи результат лежит не в ``/jobs/{id}/result``, а рядом с записью
    (``/recordings/{id}/{kind}/{job_id}``) — это отдельные контракты
    (``PreprocessResult``, ``SpectrumResult``, ``DipoleScanResult``,
    ``SpectrogramResult``).
    """
    prefix = settings.api_prefix
    result_url: Optional[str] = None
    if job.status == "succeeded":
        recording_id = job.meta.get("recording_id")
        if recording_id and job.kind in RECORDING_JOB_KINDS:
            result_url = f"{prefix}/recordings/{recording_id}/{job.kind}/{job.job_id}"
        else:
            result_url = f"{prefix}/jobs/{job.job_id}/result"
    return JobStatus(**job.as_dict(), result_url=result_url)


def _require_finished(job: Any) -> None:
    """409, если задача идёт или упала: результат отдавать ещё нечего.

    Тексты разные осознанно (правило 6 в ``docs/rules/api-jobs.md``): «не
    завершена» — ждём, «результат не сохранён» — задача была завершена, но её
    результат не влез в предел файла задачи (A8), ждать бессмысленно.
    """
    if job.status == "failed":
        raise HTTPException(status_code=409, detail=f"Задача завершилась ошибкой: {job.error}")
    if job.status == "succeeded" and job.result is None:
        raise HTTPException(
            status_code=409,
            detail="Результат задачи не сохранён на диск (слишком большой) — запустите расчёт заново",
        )
    if job.status != "succeeded" or job.result is None:
        raise HTTPException(
            status_code=409,
            detail=f"Задача ещё не завершена (этап {job.stage}, прогресс {job.progress:.0%})",
        )


def job_by_id(job_id: str) -> Any:
    """Задача по id: 404 — неизвестна, 409 — идёт или упала."""
    job = job_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Задача {job_id} не найдена")
    _require_finished(job)
    return job


def recording_job_result(recording_id: str, job_id: str, kind: str) -> Any:
    """Задача записи нужного типа; 404/409 — как у результата предподготовки."""
    job = job_manager.get(job_id)
    if job is None or job.kind != kind or job.meta.get("recording_id") != recording_id:
        raise HTTPException(
            status_code=404, detail=f"Задача {kind} {job_id} для записи {recording_id} не найдена",
        )
    _require_finished(job)
    return job
