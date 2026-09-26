"""Тесты задач записи (A1, этап 3): запуск, статус, результат, отмена (3.2).

Из этих функций собираются пять эндпоинтов ``/recordings/{id}/{kind}``. Поэтому
проверяются три вещи: адрес результата у задачи записи (он рядом с записью, а не
в ``/jobs/{id}/result``), разбор чужого/незавершённого результата (404/409) и
запуск через общий помощник с воркером из ``WORKERS``. Плюс ``DELETE /jobs/{id}``:
404/409 разбора и реальная остановка бегущего воркера.
"""
import os
import shutil
import threading
import time

import numpy as np
import pytest
from fastapi import HTTPException

from app.api import recording_jobs
from app.core.config import settings
from app.services.job_manager import Job, job_manager
from app.services.recordings import recording_registry
from tests.conftest import write_minimal_edf
from tests.test_dipole_scanner import _register, _wait_finished

_PREFIX = "/api/v1"


def _upload_dirs() -> set[str]:
    root = settings.upload_dir
    if not os.path.isdir(root):
        return set()
    return {name for name in os.listdir(root) if os.path.isdir(os.path.join(root, name))}


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра задач/записей и каталогов загрузок между тестами."""
    job_manager.clear()
    recording_registry.clear()
    before = _upload_dirs()
    yield
    job_manager.clear()
    recording_registry.clear()
    for name in _upload_dirs() - before:
        shutil.rmtree(os.path.join(settings.upload_dir, name), ignore_errors=True)


def _stored_job(
    kind: str = "spectrum", recording_id: object = "rec-1", result: object = None,
) -> Job:
    """Задача в реестре ``job_manager`` без запуска воркера (для проверок разбора)."""
    job = job_manager.create(kind, "rec.edf", recording_id=recording_id)
    if result is not None:
        job.finish(result)
    return job


# ---------- статус задачи: адрес результата ----------

@pytest.mark.parametrize("kind", ["preprocess", "spectrum", "dipoles", "spectrogram"])
def test_job_status_points_to_recording_result(kind):
    """У задач записи результат лежит рядом с записью (свой контракт на вид)."""
    job = Job(job_id="j1", kind=kind, status="succeeded", meta={"recording_id": "rec-1"})
    status = recording_jobs.job_status(job)

    assert status.result_url == f"{_PREFIX}/recordings/rec-1/{kind}/j1"


def test_job_status_analyze_uses_generic_result_url():
    """Файловый анализ отдаёт результат по общему адресу ``/jobs/{id}/result``."""
    job = Job(job_id="j1", kind="analyze", status="succeeded", meta={})

    assert recording_jobs.job_status(job).result_url == f"{_PREFIX}/jobs/j1/result"


def test_job_status_has_no_result_url_while_running():
    """Пока задача идёт, ``result_url`` пуст: UI не должен ходить за результатом."""
    job = Job(job_id="j1", kind="spectrum", status="running", meta={"recording_id": "rec-1"})

    assert recording_jobs.job_status(job).result_url is None


# ---------- запись из реестра ----------

def test_require_recording_reports_unknown_id():
    """Чужая/устаревшая запись — 404 с текстом для UI."""
    with pytest.raises(HTTPException) as err:
        recording_jobs.require_recording("nope")

    assert err.value.status_code == 404
    assert "nope" in err.value.detail


# ---------- разбор результата ----------

def test_recording_job_result_rejects_foreign_job():
    """Задача другого вида (или другой записи) не отдаёт свой результат."""
    job = _stored_job(kind="spectrum", recording_id="rec-1")

    with pytest.raises(HTTPException) as err:
        recording_jobs.recording_job_result("rec-1", job.job_id, "dipoles")

    assert err.value.status_code == 404


def test_recording_job_result_conflicts_while_running():
    job = _stored_job()

    with pytest.raises(HTTPException) as err:
        recording_jobs.recording_job_result("rec-1", job.job_id, "spectrum")

    assert err.value.status_code == 409
    assert "не завершена" in err.value.detail


def test_recording_job_result_reports_failed_job():
    job = _stored_job()
    job.fail(ValueError("нет эпох"))

    with pytest.raises(HTTPException) as err:
        recording_jobs.recording_job_result("rec-1", job.job_id, "spectrum")

    assert err.value.status_code == 409
    assert "нет эпох" in err.value.detail


def test_recording_job_result_returns_finished_job():
    job = _stored_job(result={"method": "fast_grid"})

    assert recording_jobs.recording_job_result("rec-1", job.job_id, "spectrum").result == {
        "method": "fast_grid",
    }


def test_job_by_id_reports_unknown_and_unfinished():
    """Общий доступ к результату задачи: 404 — нет задачи, 409 — ещё считает."""
    with pytest.raises(HTTPException) as err:
        recording_jobs.job_by_id("unknown")

    assert err.value.status_code == 404

    job = _stored_job(kind="analyze", recording_id=None)
    with pytest.raises(HTTPException) as err:
        recording_jobs.job_by_id(job.job_id)

    assert err.value.status_code == 409


# ---------- запуск задачи записи (route + помощник) ----------

def test_submit_recording_job_returns_urls_and_runs_worker(client, tmp_path, monkeypatch):
    """``POST /recordings/{id}/preprocess`` → 202, адреса в echo, воркер из WORKERS."""
    edf_path = tmp_path / "rec-jobs.edf"
    channels = list(settings.standard_channels[:4])
    sfreq = 250.0
    times = np.arange(int(2 * sfreq)) / sfreq
    data = np.stack([np.sin(2 * np.pi * 10 * times) * 20 for _ in channels])
    write_minimal_edf(edf_path, channels, data, sfreq)
    recording = _register(tmp_path, edf_path, "rec-jobs")

    calls: list = []

    def _fake_worker(progress, rec, params):
        calls.append((rec.recording_id, params))
        return {"recording_id": rec.recording_id, "stage": params.stage}

    monkeypatch.setitem(recording_jobs.WORKERS, "preprocess", _fake_worker)

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/preprocess",
        data={"stage": "filter", "band_min": 8, "band_max": 13, "epoch_length_ms": 2000},
    )
    assert created.status_code == 202, created.text

    payload = created.json()
    assert payload["poll_url"] == f"{_PREFIX}/jobs/{payload['job_id']}"
    assert payload["result_url"] == (
        f"{_PREFIX}/recordings/{recording.recording_id}/preprocess/{payload['job_id']}"
    )

    status = _wait_finished(client, payload["job_id"])
    assert status["status"] == "succeeded", status
    # Тот же адрес результата в статусе задачи: UI берёт его оттуда, а не собирает сам
    assert status["result_url"] == payload["result_url"]
    assert calls and calls[0][0] == recording.recording_id
    assert calls[0][1].stage == "filter"
    assert calls[0][1].filter_band == (8.0, 13.0)

    result = client.get(payload["result_url"])
    assert result.status_code == 200
    # Остальные поля контракта заполнены значениями по умолчанию (схема ответа)
    assert result.json()["recording_id"] == recording.recording_id
    assert result.json()["stage"] == "filter"


def test_preprocess_job_rejects_unknown_recording(client):
    """Задача записи без записи: 404 до постановки в очередь, а не 500 внутри."""
    created = client.post(
        f"{_PREFIX}/recordings/nope/preprocess", data={"stage": "filter"},
    )

    assert created.status_code == 404
    assert "nope" in created.json()["detail"]


# ---------- отмена задачи (3.2) ----------


def test_cancel_endpoint_reports_unknown_job(client):
    """DELETE неизвестной задачи — 404 с текстом для UI."""
    resp = client.delete(f"{_PREFIX}/jobs/nope")

    assert resp.status_code == 404
    assert "nope" in resp.json()["detail"]


def test_cancel_endpoint_rejects_finished_job(client):
    """Завершённую задачу отменить нельзя — 409, статус не изменился."""
    job = _stored_job(result={"method": "fast_grid"})

    resp = client.delete(f"{_PREFIX}/jobs/{job.job_id}")

    assert resp.status_code == 409
    assert "отменять нечего" in resp.json()["detail"]
    assert job.status == "succeeded"


def test_cancel_endpoint_stops_running_job(client, tmp_path, monkeypatch):
    """DELETE останавливает воркер на тике прогресса: cancelled, результата нет."""
    edf_path = tmp_path / "rec-cancel.edf"
    channels = list(settings.standard_channels[:4])
    sfreq = 250.0
    times = np.arange(int(2 * sfreq)) / sfreq
    data = np.stack([np.sin(2 * np.pi * 10 * times) * 20 for _ in channels])
    write_minimal_edf(edf_path, channels, data, sfreq)
    recording = _register(tmp_path, edf_path, "rec-cancel")

    release = threading.Event()

    def slow_worker(progress, rec, params):
        for i in range(1000):
            progress(params.stage, (i + 1) / 1000, "расчёт")
            if release.wait(timeout=0.01):
                break
        return {"recording_id": rec.recording_id, "stage": params.stage}

    monkeypatch.setitem(recording_jobs.WORKERS, "preprocess", slow_worker)

    created = client.post(
        f"{_PREFIX}/recordings/{recording.recording_id}/preprocess",
        data={"stage": "filter", "band_min": 8, "band_max": 13, "epoch_length_ms": 2000},
    )
    assert created.status_code == 202, created.text
    job_id = created.json()["job_id"]

    try:
        accepted = client.delete(f"{_PREFIX}/jobs/{job_id}")
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["job_id"] == job_id

        status: dict = {}
        for _ in range(300):
            status = client.get(f"{_PREFIX}/jobs/{job_id}").json()
            if status["status"] == "cancelled":
                break
            time.sleep(0.01)
        assert status["status"] == "cancelled", status
        assert status["result_url"] is None

        # Результат отменённой задачи не отдаётся (отдельный текст, правило 6)
        result = client.get(
            f"{_PREFIX}/recordings/{recording.recording_id}/preprocess/{job_id}",
        )
        assert result.status_code == 409
        assert "отменена" in result.json()["detail"]
    finally:
        release.set()
