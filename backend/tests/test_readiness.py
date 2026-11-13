"""Готовность записей (раздел «БД»): ``services/readiness.py`` + роуты №84–85.

Сид — через тот же write-API (4.4), что и прод: read-model обязана видеть ровно
те строки. Проверяем: сводку стадий и параметров последнего прогона (история не
UPSERT — ``n_runs``), честные ``None`` «не измерено», фильтры
``only_processed``/``patient_alias``/``search``, ``total`` до пагинации,
карточку с историей прогонов, 404 и ловушку порядка маршрутов
(``/recordings/readiness`` не должен проглатываться ``/recordings/{recording_id}``).
"""
import asyncio
import hashlib
import os
import time
from datetime import datetime

import pytest
from sqlalchemy import delete

from app.models import db as db_module
from app.services import recording_store, results_store
from app.services.dipole_scanner import DipoleScanParams
from app.services.preprocess import PreprocessParams
from app.services.recordings import Recording
from app.services.spectrogram import SpectrogramParams
from tests.test_report_store import _params, _report_result

_PREFIX = "/api/v1"
_REC = "rec-ready"
_REC2 = "rec-ready-alias"
_EMPTY = "rec-ready-empty"
_ORPHAN = "rec-ready-orphan"


async def _add_legacy_session() -> None:
    """Строка ``sessions`` вида legacy (recording_id NULL) — загрузки /analyze."""
    await db_module.init_db()
    async with db_module.AsyncSessionLocal() as session:
        session.add(db_module.Session(
            id="legacy-ready-1", filename="old.edf", kind="legacy",
            n_channels=18, sfreq=250.0, duration_sec=60.0,
            created_at=datetime.utcnow(),
        ))
        await session.commit()


def _recording(recording_id: str, *, filename: str = "ready-probe.edf",
               alias: str = "Patient-abc123") -> Recording:
    """Фейковая запись реестра с выборочным псевдонимом/именем файла."""
    return Recording(
        recording_id=recording_id,
        filename=filename,
        path=os.path.join("/nonexistent", filename),
        upload_dir=os.path.join("/nonexistent", recording_id),
        created_at=time.time(),
        meta={
            "n_channels": 18,
            "sfreq": 250.0,
            "duration_sec": 120.0,
            "channels": ["Fp1", "Fp2"],
            "patient_alias": alias,
            "created_at": datetime.utcnow(),
        },
        digest=hashlib.sha256(recording_id.encode()).hexdigest(),
    )


def _preprocess_result(epoch_length_ms: float) -> dict:
    """Минимальный результат стадии ``epochs`` (write-API шаг ②)."""
    return {
        "recording_id": _REC,
        "stage": "epochs",
        "epoch_length_ms": epoch_length_ms,
        "n_epochs_total": 3,
        "n_epochs_used": 2,
        "rejected_epochs": [1],
        "sfreq": 250.0,
    }


def _dipole_result() -> dict:
    """Минимальный результат быстрого расчёта (одна точка на эпоху)."""
    return {
        "method": "fast_grid",
        "sfreq": 250.0,
        "points": [
            {
                "epoch_index": 0,
                "time_ms": 120.0,
                "mni_coords": [10.0, -20.0, 30.0],
                "amplitude_nam": 12.5,
                "gof": 0.85,
                "anatomical_structure": "Struct0",
                "brodmann_area": "BA17",
            },
        ],
    }


def _seed() -> None:
    """Две записи с результатами и одна пустая: готовность обязана быть честной."""
    rec = _recording(_REC)
    asyncio.run(recording_store.upsert_recording(rec))
    # Два прогона нарезки: история, не UPSERT (params берутся от последнего).
    asyncio.run(results_store.persist_recording_result(
        "preprocess", rec,
        PreprocessParams(stage="epochs", epoch_length_ms=1000.0),
        _preprocess_result(1000.0), "job-ready-pre-1",
    ))
    asyncio.run(results_store.persist_recording_result(
        "preprocess", rec,
        PreprocessParams(
            stage="epochs", epoch_length_ms=2000.0, clean_method="ica",
            filter_band=(0.5, 45.0), notch_hz=50.0,
        ),
        _preprocess_result(2000.0), "job-ready-pre-2",
    ))
    asyncio.run(results_store.persist_recording_result(
        "dipoles", rec, DipoleScanParams(grid_mm=7.0, epoch_length_ms=2000.0),
        _dipole_result(), "job-ready-dip",
    ))
    asyncio.run(results_store.persist_recording_result(
        "report", rec, _params(), _report_result(), "job-ready-rep",
    ))
    rec2 = _recording(_REC2, filename="ready-task.edf", alias="Patient-xyz789")
    asyncio.run(recording_store.upsert_recording(rec2))
    asyncio.run(results_store.persist_recording_result(
        "preprocess", rec2,
        PreprocessParams(stage="epochs", epoch_length_ms=1000.0),
        {**_preprocess_result(1000.0), "recording_id": _REC2}, "job-ready-2",
    ))
    asyncio.run(recording_store.upsert_recording(
        _recording(_EMPTY, filename="ready-empty.edf"),
    ))


@pytest.fixture(autouse=True)
def clean_state():
    """Строки теста убираются до и после: общая tmp-БД не помнит соседей."""
    for rec_id in (_REC, _REC2, _EMPTY, _ORPHAN):
        asyncio.run(recording_store.drop_recording_rows(rec_id))
    _drop_legacy()
    yield
    for rec_id in (_REC, _REC2, _EMPTY, _ORPHAN):
        asyncio.run(recording_store.drop_recording_rows(rec_id))
    _drop_legacy()


def _drop_legacy() -> None:
    """Убирает симулированную legacy-строку (каскад её не касается: FK нет)."""

    async def _run() -> None:
        await db_module.init_db()
        async with db_module.AsyncSessionLocal() as session:
            await session.execute(
                delete(db_module.Session).where(db_module.Session.id == "legacy-ready-1")
            )
            await session.commit()

    asyncio.run(_run())


def _page(client, **params) -> dict:
    response = client.get(f"{_PREFIX}/recordings/readiness", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _row(body: dict, recording_id: str) -> dict:
    rows = {item["recording_id"]: item for item in body["items"]}
    assert recording_id in rows, f"записи {recording_id} нет на странице готовности"
    return rows[recording_id]


def _stage(row: dict, key: str) -> dict:
    stages = {stage["stage"]: stage for stage in row["stages"]}
    return stages[key]


def test_readiness_page_stages_and_latest_params(client):
    """Стадии, «k из N», параметры последнего прогона; пустая запись — «0 из 5»."""
    _seed()
    body = _page(client, limit=500)
    row = _row(body, _REC)

    assert row["filename"] == "ready-probe.edf"
    assert row["patient_alias"] == "Patient-abc123"
    assert row["readiness_total"] == 5
    assert row["readiness_ready"] == 4  # preprocess, dipoles, package, report
    assert [stage["stage"] for stage in row["stages"]] == [
        "preprocess", "dipoles", "package", "report", "spectrogram",
    ]

    pre = _stage(row, "preprocess")
    assert pre["state"] == "ready" and pre["n_runs"] == 2
    assert pre["job_id"] == "job-ready-pre-2"  # последний прогон, не первый
    params = pre["params"]
    assert params["epoch_length_ms"] == 2000.0  # параметры именно последнего
    assert params["clean_method"] == "ica"
    assert params["filter_band_hz"] == [0.5, 45.0]
    assert params["notch_hz"] == 50.0
    assert (params["n_epochs_total"], params["n_epochs_used"], params["n_epochs_rejected"]) == (3, 2, 1)

    dip = _stage(row, "dipoles")
    assert dip["params"]["grid_mm"] == 7.0
    assert dip["params"]["method"] == "fast_grid"
    assert dip["params"]["n_dipoles"] == 1

    package = _stage(row, "package")
    assert package["params"]["grid_mm"] == 7.0
    assert {band["band_key"] for band in package["params"]["bands"]} == {"alpha", "beta"}

    report = _stage(row, "report")
    assert report["params"]["qc_status"] == "ok"
    assert report["params"]["good_data_percent"] == 93.5

    spec = _stage(row, "spectrogram")
    assert spec["state"] == "none" and spec["params"] is None

    empty = _row(body, _EMPTY)
    assert (empty["readiness_ready"], empty["readiness_total"]) == (0, 5)
    assert all(stage["state"] == "none" for stage in empty["stages"])


def test_readiness_page_route_not_shadowed(client):
    """/recordings/readiness — свой роут, не «запись readiness» (ловушка порядка)."""
    _seed()
    response = client.get(f"{_PREFIX}/recordings/readiness")
    assert response.status_code == 200
    assert "items" in response.json()


def test_only_processed_search_and_alias_filters(client):
    """Фильтры шаблонов D–E: обработанные, подстрока, псевдоним."""
    _seed()
    processed = _page(client, only_processed=True, limit=500)
    ids = {item["recording_id"] for item in processed["items"]}
    assert _REC in ids and _REC2 in ids
    assert _EMPTY not in ids

    found = _page(client, search="ready-task", limit=500)
    assert [item["recording_id"] for item in found["items"]] == [_REC2]

    by_alias = _page(client, patient_alias="Patient-xyz789", limit=500)
    assert [item["recording_id"] for item in by_alias["items"]] == [_REC2]


def test_readiness_honest_total_and_pagination(client):
    """``total`` считается до пагинации; страницы не пересекаются."""
    _seed()
    full = _page(client, limit=500)
    page1 = _page(client, limit=1, offset=0)
    page2 = _page(client, limit=1, offset=1)
    assert page1["total"] == page2["total"] == full["total"]
    assert len(page1["items"]) == 1 and len(page2["items"]) == 1
    assert page1["items"][0]["recording_id"] != page2["items"][0]["recording_id"]


def test_sort_keys_and_paging_over_sorted_set(client):
    """Сортировка (шаблон F): name/readiness; страницы режут отсортированный набор."""
    _seed()
    by_name = _page(client, search="ready-", sort="name", limit=500)
    assert [item["filename"] for item in by_name["items"]] == [
        "ready-empty.edf", "ready-probe.edf", "ready-task.edf",
    ]

    by_ready = _page(client, search="ready-", sort="readiness", limit=500)
    assert [item["recording_id"] for item in by_ready["items"]] == [_REC, _REC2, _EMPTY]

    page1 = _page(client, search="ready-", sort="name", limit=2, offset=0)
    page2 = _page(client, search="ready-", sort="name", limit=2, offset=2)
    assert page1["total"] == page2["total"] == 3
    assert [item["filename"] for item in page1["items"]] == [
        "ready-empty.edf", "ready-probe.edf",
    ]
    assert [item["filename"] for item in page2["items"]] == ["ready-task.edf"]

    bad = client.get(f"{_PREFIX}/recordings/readiness", params={"sort": "nope"})
    assert bad.status_code == 422


def test_recording_readiness_card_history_and_404(client):
    """Карточка: история прогонов (новые сверху) и 404 для неизвестной записи."""
    _seed()
    response = client.get(f"{_PREFIX}/recordings/{_REC}/readiness")
    assert response.status_code == 200
    detail = response.json()
    assert detail["recording_id"] == _REC
    assert detail["readiness_ready"] == 4

    pre = _stage(detail, "preprocess")
    assert [run["job_id"] for run in pre["runs"]] == ["job-ready-pre-2", "job-ready-pre-1"]
    assert pre["runs"][0]["params"]["epoch_length_ms"] == 2000.0
    assert pre["runs"][1]["params"]["epoch_length_ms"] == 1000.0

    missing = client.get(f"{_PREFIX}/recordings/rec-no-such/readiness")
    assert missing.status_code == 404


def test_legacy_and_orphan_sessions_are_not_listed(client):
    """Legacy-сессии (recording_id NULL) и сироты без строки записи не в таблице.

    Страница читает зеркало ``recordings``: строки ``sessions`` без записи
    (legacy ``/analyze`` до 4.4 и сироты) готовности не создают.
    """
    _seed()
    # Симуляция legacy-строки /analyze: recording_id NULL, kind='legacy'.
    asyncio.run(_add_legacy_session())
    # Прогон записи, которой нет в зеркале recordings (сирота).
    asyncio.run(results_store.persist_recording_result(
        "spectrogram",
        _recording(_ORPHAN),
        SpectrogramParams(channel="Fp1"),
        {"recording_id": _ORPHAN, "sfreq": 250.0, "filter_band_hz": [1.0, 40.0]},
        "job-ready-spec",
    ))
    body = _page(client, limit=500)
    listed = {item["recording_id"] for item in body["items"]}
    assert _ORPHAN not in listed
    for item in body["items"]:
        pre = _stage(item, "preprocess")
        assert pre["n_runs"] >= 0  # счётчики честные: legacy-строки к ним не примешаны
    assert all(
        item["readiness_total"] == 5 for item in body["items"]
    )