"""Задачи записи: запуск, статус, результат (A1, этап 3).

Задачи записи (``preprocess`` / ``spectrum`` / ``dipoles`` / ``spectrogram`` /
``dipole_refine`` / ``evoked``) отличаются только формой запроса и воркером. Всё остальное у
них общее, и это общее живёт здесь:

* ``require_recording`` — 404 с текстом для UI, если запись неизвестна/устарела;
* воркеры ``worker_*`` — тонкие обёртки сервисов, исполняются в потоке;
* ``submit_recording_job`` — 202 + ``job_id`` и ``result_url`` рядом с записью
  (``/recordings/{id}/{kind}/{job_id}``): контракт результата у каждого вида
  задачи свой (``PreprocessResult``, ``SpectrumResult``, ``DipoleScanResult``,
  ``SpectrogramResult``, ``DipoleRefineResult``), поэтому и адрес не общий;
* ``job_status`` — статус задачи для поллинга; новый ``kind`` обязан появиться и
  здесь, и в `_drop_signal_cache` (правило 2 в ``docs/rules/api-jobs.md``);
* ``recording_job_result`` — разбор результата: чужой/неизвестный job — 404,
  незавершённый или упавший — 409 (UI показывает ``detail`` как есть).
"""
import logging
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException

from app.core.config import settings
from app.schemas.analysis import JobCreated, JobStatus
from app.services import results_store
from app.services.compare import CompareParams, run_compare
from app.services.dipole_scanner import (
    DipoleRefineParams,
    DipoleScanParams,
    compute_dipole_scan,
    refine_dipole_point,
)
from app.services.eloreta import EloretaParams, run_eloreta
from app.services.evoked import EvokedParams, run_evoked
from app.services.job_manager import ProgressCallback, job_manager
from app.services.preprocess import PreprocessParams, run_preprocess
from app.services.recordings import Recording, recording_registry
from app.services.report import ReportParams, run_report
from app.services.session_bundle import BundleParams, run_bundle
from app.services.spectral import SpectrumParams, compute_spectrum
from app.services.spectrogram import SpectrogramParams, compute_spectrogram

logger = logging.getLogger(__name__)

# Виды задач, чей результат лежит рядом с записью, а не в `/jobs/{id}/result`
RECORDING_JOB_KINDS: tuple[str, ...] = (
    "preprocess", "spectrum", "dipoles", "spectrogram", "dipole_refine", "evoked",
    "report", "bundle", "eloreta",
)


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
) -> dict[str, Any]:
    """Воркер задачи предподготовки (поток): одна стадия на запись.

    Загрузку не удаляем (в отличие от ``/jobs``): файл записи принадлежит
    реестру просмотра и живёт по своему TTL.
    """
    return run_preprocess(recording, settings, params, progress)


def worker_evoked(
    progress: ProgressCallback, recording: Recording, params: EvokedParams,
) -> dict[str, Any]:
    """Воркер задачи ERP (поток): усреднение эпох вокруг событий записи (2.7)."""
    return run_evoked(recording, settings, params, progress)


def worker_compare(
    progress: ProgressCallback,
    recording_a: Recording, recording_b: Recording, params: CompareParams,
) -> dict[str, Any]:
    """Воркер дифференциального анализа (поток): PSD пары → дельты и статистика.

    Задача принадлежит **паре** записей, а не одной, поэтому живёт не в
    ``RECORDING_JOB_KINDS``: её результат отдаёт ``GET /compare/{job_id}``.
    """
    return run_compare(recording_a, recording_b, settings, params, progress)


def worker_spectrum(
    progress: ProgressCallback, recording: Recording, params: SpectrumParams,
) -> dict[str, Any]:
    """Воркер задачи спектра (поток): Welch PSD + топокарты диапазонов."""
    return compute_spectrum(recording, settings, params, progress)


def worker_spectrogram(
    progress: ProgressCallback, recording: Recording, params: SpectrogramParams,
) -> dict[str, Any]:
    """Воркер задачи спектрограммы (поток): STFT одного канала → сетка дБ."""
    return compute_spectrogram(recording, settings, params, progress)


def worker_dipole_scan(
    progress: ProgressCallback, recording: Recording, params: DipoleScanParams,
) -> dict[str, Any]:
    """Воркер быстрого расчёта диполей (поток): перебор сетки по эпохам."""
    return compute_dipole_scan(recording, settings, params, progress)


def worker_dipole_refine(
    progress: ProgressCallback, recording: Recording, params: DipoleRefineParams,
) -> dict[str, Any]:
    """Воркер точного уточнения эпохи (поток): BEM fit_dipole в окне пика GFP."""
    return refine_dipole_point(recording, settings, params, progress)


def worker_eloreta(
    progress: ProgressCallback, recording: Recording, params: EloretaParams,
) -> dict[str, Any]:
    """Воркер eLORETA (поток): пик/ROI распределения одной эпохи (остаток B9).

    Дисковых кэшей записи не создаёт (как ``evoked``) — в ``_drop_signal_cache``
    чистить нечего.
    """
    return run_eloreta(recording, settings, params, progress)


def worker_report(
    progress: ProgressCallback, recording: Recording, params: ReportParams,
) -> dict[str, Any]:
    """Воркер автоотчёта (поток): часть 1 (стадии) + пакет диполей + MNE.Report."""
    return run_report(recording, settings, params, progress)


def worker_bundle(
    progress: ProgressCallback, recording: Recording, params: BundleParams,
) -> dict[str, Any]:
    """Воркер пакета сессии (поток): zip «EDF + параметры + результаты» или BIDS."""
    return run_bundle(recording, settings, params, progress)


WORKERS: dict[str, Callable[..., dict[str, Any]]] = {
    "dipole_refine": worker_dipole_refine,
    "eloreta": worker_eloreta,
    "preprocess": worker_preprocess,
    "spectrum": worker_spectrum,
    "spectrogram": worker_spectrogram,
    "dipoles": worker_dipole_scan,
    "evoked": worker_evoked,
    "report": worker_report,
    "bundle": worker_bundle,
}


def submit_recording_job(
    kind: str,
    recording: Recording,
    params: Any,
    *,
    meta: dict[str, Any] | None = None,
) -> JobCreated:
    """Ставит задачу записи в очередь и собирает ``JobCreated`` (202 + ``job_id``).

    ``on_success`` — write-API (4.4): успешная задача оставляет строку в БД
    (``sessions``/``epochs``/``dipoles`` или ``analyses``/``report_*``); сбой
    записи перехватывает ``job_manager`` и не меняет статус задачи.
    """
    job = job_manager.submit(
        kind, recording.filename, WORKERS[kind], recording, params,
        on_success=results_store.on_success_callback(kind, recording, params),
        # params_sig — отпечаток параметров задачи в файле истории: по нему
        # автоотчёт сверяет свои числа с последней стадией EDF (§3.9.4, №1).
        # В ``JobStatus`` meta не входит — контракт API не меняется.
        meta={"recording_id": recording.recording_id, "params_sig": repr(params), **(meta or {})},
    )
    logger.info("Создана задача %s %s (%s)", kind, job.job_id, recording.recording_id)
    prefix = settings.api_prefix
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/recordings/{recording.recording_id}/{kind}/{job.job_id}",
    )


def submit_compare_job(
    recording_a: Recording,
    recording_b: Recording,
    params: CompareParams,
    meta: dict[str, Any] | None = None,
) -> JobCreated:
    """202 для задачи сравнения двух записей: результат — ``GET /compare/{job_id}``.

    Задача не привязана к одной записи (пара), поэтому не входит в
    ``RECORDING_JOB_KINDS`` и не пишет строку в БД через ``results_store`` —
    носитель результата B9 (срез 1) — файл задачи и дисковый кэш карт разности.
    """
    filename = f"{recording_a.filename} ↔ {recording_b.filename}"
    job = job_manager.submit(
        "compare", filename, worker_compare,
        recording_a, recording_b, params,
        meta={
            "recording_ids": [recording_a.recording_id, recording_b.recording_id],
            "params_sig": repr(params),
            **(meta or {}),
        },
    )
    logger.info(
        "Создана задача compare %s (%s ↔ %s)",
        job.job_id, recording_a.recording_id, recording_b.recording_id,
    )
    prefix = settings.api_prefix
    return JobCreated(
        job_id=job.job_id,
        status=job.status,
        poll_url=f"{prefix}/jobs/{job.job_id}",
        result_url=f"{prefix}/compare/{job.job_id}",
    )


def job_status(job: Any) -> JobStatus:
    """``JobStatus`` из задачи; ``result_url`` заполняется только для успешных.

    У задач записи результат лежит не в ``/jobs/{id}/result``, а рядом с записью
    (``/recordings/{id}/{kind}/{job_id}``) — это отдельные контракты
    (``PreprocessResult``, ``SpectrumResult``, ``DipoleScanResult``,
    ``SpectrogramResult``). Задача сравнения — пара записей: её результат
    отдаёт ``GET /compare/{job_id}`` (``CompareResult``).
    """
    prefix = settings.api_prefix
    result_url: str | None = None
    if job.status == "succeeded":
        if job.kind == "compare":
            result_url = f"{prefix}/compare/{job.job_id}"
        else:
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
    if job.status == "cancelled":
        # Отдельный текст (правило 6 в docs/rules/api-jobs.md): «ждём» здесь врало бы
        raise HTTPException(
            status_code=409, detail="Задача отменена — запустите расчёт заново",
        )
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


def compare_job_result(job_id: str) -> Any:
    """Задача сравнения двух записей; 404/409 — как у задач записи.

    Чужой вид задачи (спектр, отчёт) на адресе ``/compare/{id}`` — тоже 404:
    адрес контракта ``CompareResult``, и другой результат здесь не читается.
    """
    job = job_manager.get(job_id)
    if job is None or job.kind != "compare":
        raise HTTPException(
            status_code=404, detail=f"Задача сравнения {job_id} не найдена",
        )
    _require_finished(job)
    return job
