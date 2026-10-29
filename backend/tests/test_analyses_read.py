"""Read-API новой схемы (4.7, окончание): ``GET /recordings`` и ``GET /analyses``.

Чтение таблиц ``recordings``/``analyses``/``dipole_points`` (write-API 4.4):
страница записей с счётчиками детей (кандидаты группового анализа — вместо
legacy ``GET /sessions``), страница прогонов с паспортом записи, паспорт с
полосами и точки пакета. Инварианты read те же, что у сессий
(`docs/rules/results-db.md`): ``total`` до пагинации, 404 на неизвестный
прогон (не пустой список), вердикт КД — честный ``None``. Сид — через тот же
write-API (4.4), что и прод: read обязан видеть ровно те строки.
"""
import asyncio

import pytest

from app.core.config import settings
from app.services import recording_store, results_store
from app.services.preprocess import PreprocessParams
from app.services.recordings import recording_registry
from tests.test_recording_store import _recording
from tests.test_report_store import _params, _report_result

_PREFIX = "/api/v1"
_REC = "rec-analyses-read"
_EMPTY = "rec-analyses-empty"


@pytest.fixture(autouse=True)
def clean_state():
    """Строки теста убираются до и после: общая tmp-БД не помнит соседей."""
    for rec_id in (_REC, _EMPTY):
        asyncio.run(recording_store.drop_recording_rows(rec_id))
    recording_registry.clear()
    yield
    for rec_id in (_REC, _EMPTY):
        asyncio.run(recording_store.drop_recording_rows(rec_id))
    recording_registry.clear()


def _seed() -> None:
    """Прогон пакета (``analyses`` + ``dipole_points`` + ``report_runs``) и одна сессия нарезки.

    Вторая запись остаётся без детей — счётчики обязаны быть честными нулями.
    """
    rec = _recording(_REC)
    asyncio.run(recording_store.upsert_recording(rec))
    asyncio.run(results_store.persist_recording_result(
        "report", rec, _params(), _report_result(), "job-ar-report",
    ))
    asyncio.run(results_store.persist_recording_result(
        "preprocess", rec,
        PreprocessParams(stage="epochs", epoch_length_ms=1000.0),
        {
            "recording_id": _REC, "stage": "epochs", "epoch_length_ms": 1000.0,
            "n_epochs_total": 3, "n_epochs_used": 2, "rejected_epochs": [1],
            "sfreq": 250.0,
        },
        "job-ar-pre",
    ))
    asyncio.run(recording_store.upsert_recording(_recording(_EMPTY)))


def _analysis_id(client) -> int:
    """Идентификатор единственного прогона записи из read-API."""
    page = client.get(f"{_PREFIX}/analyses", params={"recording_id": _REC})
    return int(page.json()["items"][0]["id"])


def test_recordings_page_counts_children(client):
    """Страница записей: паспорт + счётчики детей, запись без детей — нули."""
    _seed()
    page = client.get(f"{_PREFIX}/recordings", params={"limit": 500})
    assert page.status_code == 200
    body = page.json()
    rows = {row["recording_id"]: row for row in body["items"]}
    assert body["total"] >= 2

    row = rows[_REC]
    assert row["filename"] == "probe.edf"
    assert row["patient_alias"] == "Patient-abc123"
    assert row["n_channels"] == 18 and row["sfreq"] == 250.0
    assert (row["n_sessions"], row["n_analyses"], row["n_report_runs"]) == (1, 1, 1)

    empty = rows[_EMPTY]
    assert (empty["n_sessions"], empty["n_analyses"], empty["n_report_runs"]) == (0, 0, 0)


def test_recordings_page_honest_total_and_pagination(client):
    """``total`` считается до пагинации; страницы не пересекаются."""
    _seed()
    full = client.get(f"{_PREFIX}/recordings", params={"limit": 500}).json()
    page1 = client.get(f"{_PREFIX}/recordings", params={"limit": 1, "offset": 0}).json()
    page2 = client.get(f"{_PREFIX}/recordings", params={"limit": 1, "offset": 1}).json()
    assert page1["total"] == page2["total"] == full["total"]
    assert len(page1["items"]) == 1 and len(page2["items"]) == 1
    assert page1["items"][0]["recording_id"] != page2["items"][0]["recording_id"]


def test_analyses_page_counters_and_filters(client):
    """Страница прогонов: счётчики полос/точек, паспорт записи, фильтры."""
    _seed()
    page = client.get(f"{_PREFIX}/analyses", params={"recording_id": _REC}).json()
    assert page["total"] == 1
    item = page["items"][0]
    assert item["kind"] == "fast_grid"
    assert item["filename"] == "probe.edf"
    assert item["patient_alias"] == "Patient-abc123"
    assert item["n_bands"] == 2 and item["n_points"] == 9
    assert item["n_epochs_total"] == 10 and item["n_epochs_used"] == 8

    unknown_kind = client.get(
        f"{_PREFIX}/analyses", params={"recording_id": _REC, "kind": "bem_fit"},
    ).json()
    assert unknown_kind["total"] == 0 and unknown_kind["items"] == []


def test_analysis_detail_bands_and_404(client, monkeypatch):
    """Паспорт прогона: полосы ``analysis_bands``, КД — «не оценено», 404 — нет."""
    # Порог X % снят: ветка «не оценено» (пороги методики активны — в
    # test_kd_criteria.py, живой дефолт X = 5 %).
    monkeypatch.setattr(settings, "kd_moment_share", None)
    _seed()
    analysis_id = _analysis_id(client)
    detail = client.get(f"{_PREFIX}/analyses/{analysis_id}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["reference"] == "average"
    assert body["channels"] == ["Fp1", "Fp2"]
    assert body["warnings"] == ["w1"]
    bands = {band["band_key"]: band for band in body["bands"]}
    assert bands["alpha"]["state"] == "ok" and bands["alpha"]["n_points"] == 6
    assert bands["beta"]["n_points"] == 3
    assert bands["alpha"]["moment_max_nam"] == 100.0  # максимум внутри полосы
    assert bands["alpha"]["n_kd_passed"] is None  # пороги методики не заданы

    assert client.get(f"{_PREFIX}/analyses/999999").status_code == 404


def test_analysis_points_filter_and_404(client, monkeypatch):
    """Точки пакета: фильтр полосы, пагинация, честный ``None`` вердикта; 404."""
    # Порог X % снят: ветка «не оценено» (живой дефолт X = 5 % — в
    # test_kd_criteria.py).
    monkeypatch.setattr(settings, "kd_moment_share", None)
    _seed()
    analysis_id = _analysis_id(client)

    alpha = client.get(
        f"{_PREFIX}/analyses/{analysis_id}/points", params={"band_key": "alpha"},
    ).json()
    assert len(alpha) == 6
    first = alpha[0]
    assert first["analysis_id"] == analysis_id
    assert first["band_key"] == "alpha"
    assert first["mni_coords"] == [-42.0, -18.0, 58.0]
    assert first["kd_passed"] is None
    assert first["kd_basis"] is not None
    assert first["kd_basis"]["moment_max_nam"] == 100.0

    all_points = client.get(f"{_PREFIX}/analyses/{analysis_id}/points").json()
    assert len(all_points) == 9
    page = client.get(
        f"{_PREFIX}/analyses/{analysis_id}/points", params={"limit": 4},
    ).json()
    assert len(page) == 4

    assert client.get(f"{_PREFIX}/analyses/999999/points").status_code == 404


def test_sessions_read_marked_deprecated(client):
    """Legacy-ветка ``/sessions*`` помечена deprecated, новая схема — нет (4.7)."""
    spec = client.get("/openapi.json").json()
    for path in (
        "/api/v1/sessions",
        "/api/v1/sessions/{session_id}",
        "/api/v1/sessions/{session_id}/epochs",
        "/api/v1/sessions/{session_id}/dipoles",
    ):
        assert spec["paths"][path]["get"].get("deprecated") is True, path
    for path in ("/api/v1/recordings", "/api/v1/analyses"):
        assert not spec["paths"][path]["get"].get("deprecated", False), path