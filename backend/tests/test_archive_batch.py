"""Тесты пакетной обработки архива (С8): серия прогонов и отчёт «обработано/ошибки/дубли».

Проверяем: обход серии с снимком параметров, построчный отчёт (processed /
error / duplicate), дубли по содержимому (sha256 — содержимое считается один
раз), устойчивость серии к падению одной записи и роуты
(``POST /archive/batches`` → 202 → ``GET /archive/batches/{job_id}``).
"""
import asyncio
import os
import shutil
import time

import numpy as np
import pytest

from app.api.params import archive_batch_params
from app.core.config import settings
from app.schemas.analysis import ArchiveBatchResult
from app.services import recording_store
from app.services.archive_batch import (
    ArchiveBatchError,
    resolve_series,
    run_archive_batch,
)
from app.services.recordings import recording_registry
from tests.test_dipole_scanner import _register

_PREFIX = "/api/v1"


@pytest.fixture(autouse=True)
def clean_state():
    """Изоляция реестра записей, каталогов и строк БД между тестами.

    Серия пишет строки прогонов каждой записи (write-API 4.4) в общую tmp-БД —
    каскад §8.4.3 убирает их вместе со строками записей.
    """
    recording_registry.clear()
    root = settings.upload_dir
    before = (
        {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))}
        if os.path.isdir(root) else set()
    )
    yield
    for recording in recording_registry.list():
        asyncio.run(recording_store.drop_recording_rows(recording.recording_id))
    recording_registry.clear()
    if os.path.isdir(root):
        for name in {n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n))} - before:
            shutil.rmtree(os.path.join(root, name), ignore_errors=True)


def _rhythm_edf(
    tmp_path, name: str, freq_hz: float = 10.0, seconds: float = 6.0,
    n_channels: int = 8,
):
    """Синтетический EDF с одним ритмом; <4 каналов — запись «не посчитается»."""
    from tests.conftest import write_minimal_edf

    path = tmp_path / name
    channels = list(settings.standard_channels[:n_channels])
    sfreq = 250.0
    times = np.arange(int(seconds * sfreq)) / sfreq
    gain = 5.0 + np.arange(len(channels), dtype=float)
    data = np.sin(2 * np.pi * freq_hz * times)[None, :] * gain[:, None]
    write_minimal_edf(path, channels, data, sfreq)
    return path


def _series(bands: str = "alpha,beta", recording_ids: str = ""):
    """Параметры серии через форму (та же валидация, что у роута)."""
    return archive_batch_params(
        recording_ids=recording_ids, bands=bands, notch_hz=None,
        reference="average", reference_channels=None,
        epoch_length_ms=1000.0, grid_mm=7.0,
        cluster_voxel_norm=None, cluster_min_points=None,
    )


def test_archive_batch_report_counts_processed_errors_duplicates(tmp_path):
    """Отчёт серии: «обработано / ошибки / дубли» построчно, дубль — по sha256."""
    rec_a = _register(tmp_path, _rhythm_edf(tmp_path, "a.edf"), "rec-arc-a")
    rec_b = _register(tmp_path, _rhythm_edf(tmp_path, "b.edf", freq_hz=20.0), "rec-arc-b")
    # Меньше 4 каналов — расчёт невозможен, запись уходит в «ошибки»
    rec_bad = _register(
        tmp_path, _rhythm_edf(tmp_path, "bad.edf", n_channels=2), "rec-arc-bad",
    )
    # Дубль содержимого: реестр дедуплицирует загрузки, но легаси-записи без
    # отпечатка могли накопиться — серия обязана считать содержимое один раз.
    rec_a.digest = "same-sha256"
    rec_b.digest = "same-sha256"
    rec_bad.digest = "other-sha256"

    params = _series(recording_ids="rec-arc-a,rec-arc-b,rec-arc-bad")
    result = asyncio.run(run_archive_batch(settings, params))

    assert result["pipeline"] == "dipole_batch"
    assert result["params_sig"]
    assert result["summary"] == {"total": 3, "processed": 1, "errors": 1, "duplicates": 1}
    by_state = {item["recording_id"]: item for item in result["items"]}
    assert by_state["rec-arc-a"]["state"] == "processed"
    assert by_state["rec-arc-a"]["n_points"] > 0
    assert by_state["rec-arc-a"]["n_bands_ok"] == 2
    assert by_state["rec-arc-b"]["state"] == "duplicate"
    assert by_state["rec-arc-b"]["duplicate_of"] == "rec-arc-a"
    assert by_state["rec-arc-bad"]["state"] == "error"
    assert by_state["rec-arc-bad"]["error"]
    # Контракт отчёта валидируется на месте
    ArchiveBatchResult(**result)


def test_archive_series_survives_one_failure(tmp_path):
    """Одна упавшая запись не валит серию: её ошибка — в своей строке отчёта."""
    rec_ok = _register(tmp_path, _rhythm_edf(tmp_path, "ok.edf"), "rec-arc-ok")
    rec_fail = _register(
        tmp_path, _rhythm_edf(tmp_path, "fail.edf", n_channels=2), "rec-arc-fail",
    )
    rec_ok.digest = "d1"
    rec_fail.digest = "d2"

    params = _series(recording_ids="rec-arc-ok,rec-arc-fail")
    result = asyncio.run(run_archive_batch(settings, params))

    assert result["summary"]["processed"] == 1
    assert result["summary"]["errors"] == 1
    by_state = {item["recording_id"]: item for item in result["items"]}
    assert by_state["rec-arc-fail"]["state"] == "error"
    assert by_state["rec-arc-fail"]["error"]
    assert result["warnings"]
    assert by_state["rec-arc-ok"]["state"] == "processed"


def test_resolve_series_unknown_recording_is_error():
    """Неизвестная запись серии — ошибка с текстом (последний рубеж формы)."""
    with pytest.raises(ArchiveBatchError, match="не найдены"):
        resolve_series(settings, ["rec-missing"])


def test_archive_batch_endpoint_returns_report(client, tmp_path):
    """POST /archive/batches → 202 → отчёт серии на /archive/batches/{id}."""
    rec_a = _register(tmp_path, _rhythm_edf(tmp_path, "x.edf"), "rec-arc-x")
    rec_b = _register(
        tmp_path, _rhythm_edf(tmp_path, "y.edf", freq_hz=20.0), "rec-arc-y",
    )
    rec_a.digest = "dx"
    rec_b.digest = "dy"
    response = client.post(
        f"{_PREFIX}/archive/batches",
        data={
            "recording_ids": "rec-arc-x,rec-arc-y",
            "bands": "alpha,beta",
            "epoch_length_ms": "1000",
            "grid_mm": "7",
        },
    )
    assert response.status_code == 202
    created = response.json()
    assert created["result_url"].endswith(f"/archive/batches/{created['job_id']}")

    deadline = time.time() + 90.0
    body: dict = {}
    while time.time() < deadline:
        body = client.get(f"{_PREFIX}/jobs/{created['job_id']}").json()
        if body["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.05)
    assert body["status"] == "succeeded", body
    # Адрес контракта серии: задача не «записи», результат живёт на своём адресе
    assert body["result_url"] == created["result_url"]

    report = client.get(created["result_url"])
    assert report.status_code == 200
    payload = report.json()
    assert payload["summary"] == {
        "total": 2, "processed": 2, "errors": 0, "duplicates": 0,
    }
    assert len(payload["items"]) == 2


def test_archive_batch_endpoint_requires_known_recording(client, tmp_path):
    """Неизвестная запись в форме — 404 с текстом (require_recording)."""
    _register(tmp_path, _rhythm_edf(tmp_path, "z.edf"), "rec-arc-z")
    response = client.post(
        f"{_PREFIX}/archive/batches",
        data={"recording_ids": "rec-ghost", "bands": "alpha"},
    )
    assert response.status_code == 404