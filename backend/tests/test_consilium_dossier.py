"""Т1.3/Т1.4: реальные копии синтетических источников, неизменяемость и удаление."""

import asyncio
import uuid
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models import db
from app.services import group_analysis, job_store, recording_store, results_store
from app.services.job_manager import Job, job_manager

PREFIX = "/api/v1/consilium/cases"


@pytest.fixture(autouse=True)
def isolated_dossier(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Изолирует все владельцы БД, файлы job и реестр, не рабочий архив."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'dossier.db'}")
    maker = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", maker)
    for service in (results_store, recording_store, group_analysis):
        monkeypatch.setattr(service, "AsyncSessionLocal", maker)
    monkeypatch.setattr(settings, "results_dir", str(tmp_path / "results"))
    job_manager.clear()
    asyncio.run(seed())
    yield
    job_manager.clear()
    asyncio.run(engine.dispose())


async def seed() -> None:
    """Создаёт записи, сессию с неизмеренной мощностью, пакет и определение группы."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        for rid in ("rec-a", "rec-b", "rec-other"):
            session.add(db.RecordingRecord(recording_id=rid, filename=f"{rid}.edf"))
        session.add(db.Session(
            id="session-a", recording_id="rec-a", kind="dipoles", params_json={"reference": "average"},
            created_at=datetime.utcnow(), epoch_length_ms=1000,
        ))
        session.add(db.EpochRecord(session_id="session-a", epoch_index=0, has_artifact=0))
        session.add(db.Analysis(
            id=1, recording_id="rec-a", kind="fast_grid", epoch_length_ms=1000,
            warnings=["Редкий монтаж"], created_at=datetime.utcnow(), grid_mm=7,
        ))
        session.add(db.AnalysisBand(analysis_id=1, band_key="alpha", state="ok", n_points=1))
        session.add(db.DipolePoint(
            analysis_id=1, band_key="alpha", epoch_index=0, gof=0.8,
            amplitude_nam=10, anatomical_structure="ROI", mni_coords=[1, 2, 3],
        ))
        session.add(db.GroupAnalysis(
            id=1, name="Группа", band_key="alpha", filters={"band_key": "alpha", "top_n": 12},
            n_sessions_requested=2,
        ))
        session.add(db.GroupAnalysisMember(group_analysis_id=1, recording_id="rec-a", position=0))
        session.add(db.GroupAnalysisMember(group_analysis_id=1, recording_id="rec-b", position=1))
        await session.commit()


def new_id() -> str:
    """Ключ явного действия пользователя."""
    return str(uuid.uuid4())


def case(client: TestClient, ids: list[str] | None = None) -> str:
    """Создаёт исследование для выбранных записей."""
    response = client.post(PREFIX, json={
        "request_id": new_id(), "title": "Музыка", "question": "Что изменилось?",
        "recording_ids": ids or ["rec-a"],
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def version(client: TestClient, cid: str) -> int:
    """Текущая серверная версия, не число попыток на клиенте."""
    return client.get(f"{PREFIX}/{cid}").json()["version"]


def job(rids: list[str], result: dict[str, Any] | None, kind: str = "spectrum") -> Job:
    """Завершённый синтетический job, реально сохранённый в файл через владельца."""
    value = job_manager.create(kind, meta={"recording_ids": rids, "params_sig": "historical-params"})
    # create принимает meta через **kwargs, задаём канонический паспорт явно.
    value.meta = {"recording_ids": rids, "params_sig": "historical-params"}
    value.status = "succeeded"
    value.result = result
    assert job_store.save_record(settings, value.to_record()) is not None
    return value


def add(client: TestClient, cid: str, kind: str, sid: str) -> dict[str, Any]:
    """Принять материал реальным POST, без передачи аналитических чисел клиентом."""
    response = client.post(f"{PREFIX}/{cid}/evidence", json={
        "request_id": new_id(), "expected_version": version(client, cid),
        "source_kind": kind, "source_id": sid,
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_sources_catalog_belongs_to_case_and_no_calculation(client: TestClient) -> None:
    """Список отсекает чужую запись/неполную пару, показывает unavailable и total."""
    cid = case(client)
    available = job(["rec-a"], {"power": None})
    omitted = job(["rec-a"], None)
    job(["rec-other"], {"power": 1})
    job(["rec-a", "rec-b"], {"delta": 2}, "compare")
    response = client.get(f"{PREFIX}/{cid}/sources")
    assert response.status_code == 200, response.text
    sources = response.json()
    assert sources["total"] == 4  # сессия, пакет, два job
    by_id = {entry["id"]: entry for entry in sources["items"]}
    assert by_id[available.job_id]["available"] is True
    assert by_id[omitted.job_id]["available"] is False
    page = client.get(f"{PREFIX}/{cid}/sources", params={"limit": 1, "offset": 1}).json()
    assert page["total"] == 4 and len(page["items"]) == 1
    assert "no-store" in response.headers["Cache-Control"]


def test_disk_job_survives_ram_and_capture_retry(client: TestClient) -> None:
    """Файл job читается после RAM-вытеснения; повтор не создаёт новую копию."""
    cid = case(client)
    value = job(["rec-a"], {"power": None, "count": 0, "warnings": ["Нет бинов"]})
    job_manager.clear()
    payload = {"request_id": new_id(), "expected_version": 1,
               "source_kind": "job", "source_id": value.job_id}
    first = client.post(f"{PREFIX}/{cid}/evidence", json=payload)
    assert first.status_code == 201, first.text
    material = first.json()
    assert material["payload"]["power"] is None and material["payload"]["count"] == 0
    assert "Нет бинов" in material["warnings"]
    assert "structured_parameters" in material["missing"]
    assert material["signal_state"] is None
    Path(job_store.job_path(settings, value.job_id)).unlink()
    repeat = client.post(f"{PREFIX}/{cid}/evidence", json=payload)
    assert repeat.json() == material
    assert client.get(f"{PREFIX}/{cid}/evidence").json()["total"] == 1


@pytest.mark.parametrize("kind,sid", [("session", "session-a"), ("analysis", "1")])
def test_sql_sources_exact_and_preserve_none(client: TestClient, kind: str, sid: str) -> None:
    """SQL-материал читает выбранный прогон, не заменяет NULL нулём или текущими defaults."""
    cid = case(client)
    material = add(client, cid, kind, sid)
    assert material["source_id"] == sid
    if kind == "session":
        assert all(power is None for power in material["payload"]["epochs"][0]["powers"].values())
    else:
        assert material["payload"]["points"][0]["gof"] == 0.8
        assert "Редкий монтаж" in material["warnings"]
        assert material["payload"]["analysis"]["id"] == 1


def test_pair_complete_and_group_freeze(client: TestClient) -> None:
    """Пара целиком входит в дело; группа фиксирует фактические analysis_id и числа."""
    pair = job(["rec-a", "rec-b"], {"delta_direction": "B-A", "warnings": []}, "compare")
    cid = case(client, ["rec-a", "rec-b"])
    material = add(client, cid, "job", pair.job_id)
    assert material["recording_ids"] == ["rec-a", "rec-b"]
    group = add(client, cid, "group", "1")
    aggregate = group["payload"]["aggregate"]
    assert aggregate["participants"][0]["analysis_id"] == 1
    assert aggregate["n_points_total"] == 1
    assert group["completeness"] == "top_n"
    assert any("текущий агрегат" in warning for warning in group["warnings"])

    async def changed() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.Analysis(id=2, recording_id="rec-a", created_at=datetime.utcnow()))
            await session.commit()
    asyncio.run(changed())
    saved = client.get(f"{PREFIX}/{cid}/evidence").json()["items"][-1]
    assert saved["payload"]["aggregate"] == aggregate


def test_snapshot_immutable_context_and_source_deleted(client: TestClient) -> None:
    """Изменение контекста, паспорта и удаление source не меняют прошлое досье."""
    cid = case(client)
    material = add(client, cid, "analysis", "1")
    context = client.post(f"{PREFIX}/{cid}/context", json={
        "request_id": new_id(), "expected_version": version(client, cid),
        "text": "Мне спокойно", "kind": "volunteer_report", "verified": True,
    }).json()
    payload = {"request_id": new_id(), "expected_version": version(client, cid),
               "evidence_ids": [material["id"]], "context_ids": [context["id"]]}
    response = client.post(f"{PREFIX}/{cid}/snapshots", json=payload)
    assert response.status_code == 201, response.text
    snapshot = response.json()
    assert client.post(f"{PREFIX}/{cid}/snapshots", json=payload).json() == snapshot
    correction = client.patch(f"{PREFIX}/{cid}/context/{context['id']}", json={
        "request_id": new_id(), "expected_version": version(client, cid),
        "expected_revision": 1, "text": "Мне тревожно", "kind": "volunteer_report",
    })
    assert correction.status_code == 200

    async def drop() -> None:
        async with db.AsyncSessionLocal() as session:
            await session.execute(delete(db.DipolePoint))
            await session.execute(delete(db.Analysis))
            await session.commit()
    asyncio.run(drop())
    assert client.get(f"{PREFIX}/{cid}/snapshots/{snapshot['id']}").json() == snapshot
    assert snapshot["context"][0]["text"] == "Мне спокойно"
    assert snapshot["evidence"][0]["payload"]["points"][0]["gof"] == 0.8
    assert len(snapshot["sha256"]) == 64


def test_foreign_missing_and_failed_sources(client: TestClient) -> None:
    """Чужое происхождение и недоступное значение не становятся пустым успехом."""
    cid = case(client)
    foreign = job(["rec-other"], {"power": 1})
    for kind, sid, status in (
        ("job", foreign.job_id, 400), ("job", "missing", 404),
        ("group", "1", 400), ("analysis", "999", 404), ("analysis", "bad", 400),
    ):
        result = client.post(f"{PREFIX}/{cid}/evidence", json={
            "request_id": new_id(), "expected_version": 1, "source_kind": kind, "source_id": sid,
        })
        assert result.status_code == status, result.text
    assert version(client, cid) == 1


def test_snapshot_foreign_material_rolls_back(client: TestClient) -> None:
    """Снимок нельзя собрать из материалов соседа; версия дела не увеличивается при отказе."""
    first, second = case(client), case(client)
    material = add(client, first, "analysis", "1")
    result = client.post(f"{PREFIX}/{second}/snapshots", json={
        "request_id": new_id(), "expected_version": 1, "evidence_ids": [material["id"]],
    })
    assert result.status_code == 404
    assert version(client, second) == 1


def test_limits_no_truncation(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Лимит размера/строк — отказ и rollback, а не усечённый материал."""
    cid = case(client)
    large = job(["rec-a"], {"array": [1] * 3000})
    monkeypatch.setattr(settings, "consilium_material_max_bytes", 1024)
    response = client.post(f"{PREFIX}/{cid}/evidence", json={
        "request_id": new_id(), "expected_version": 1, "source_kind": "job", "source_id": large.job_id,
    })
    assert response.status_code == 413
    assert version(client, cid) == 1
    assert client.get(f"{PREFIX}/{cid}/evidence").json()["total"] == 0


def test_sensitive_material_deletion_cleans_snapshots_receipts(client: TestClient) -> None:
    """Удаление материала охватывает снимки и квитанции без удаления аналитического source."""
    cid = case(client)
    material = add(client, cid, "analysis", "1")
    response = client.post(f"{PREFIX}/{cid}/snapshots", json={
        "request_id": new_id(), "expected_version": version(client, cid), "evidence_ids": [material["id"]],
    })
    assert response.status_code == 201
    snapshot = response.json()
    preview = client.get(f"{PREFIX}/{cid}/evidence/{material['id']}/deletion-preview").json()
    assert preview["snapshot_ids"] == [snapshot["id"]]
    assert client.delete(f"{PREFIX}/{cid}/evidence/{material['id']}", params={
        "expected_version": preview["version"],
    }).status_code == 204
    assert client.get(f"{PREFIX}/{cid}/snapshots/{snapshot['id']}").status_code == 404
    assert client.get(f"{PREFIX}/{cid}/evidence").json()["total"] == 0

    async def check() -> None:
        async with db.AsyncSessionLocal() as session:
            assert await session.get(db.Analysis, 1) is not None
            assert (await session.scalars(select(db.ConsiliumRequest).where(
                db.ConsiliumRequest.case_id == cid,
            ))).all() == []
    asyncio.run(check())


def test_case_delete_cleans_materials_and_snapshots(client: TestClient) -> None:
    """DELETE дела удаляет две новые таблицы при выключенных FK SQLite."""
    cid = case(client)
    material = add(client, cid, "analysis", "1")
    client.post(f"{PREFIX}/{cid}/snapshots", json={
        "request_id": new_id(), "expected_version": version(client, cid), "evidence_ids": [material["id"]],
    })
    preview = client.get(f"{PREFIX}/{cid}/deletion-preview").json()
    assert preview["evidence_items"] == 1 and preview["snapshots"] == 1
    assert client.delete(f"{PREFIX}/{cid}", params={"expected_version": preview["version"]}).status_code == 204

    async def check() -> None:
        async with db.AsyncSessionLocal() as session:
            for model in (db.ConsiliumEvidenceRecord, db.ConsiliumSnapshotRecord):
                assert (await session.scalars(select(model))).all() == []
    asyncio.run(check())


def test_parallel_initialization_serialized() -> None:
    """Несколько HTTP-чтений не ломают глобальный контекст Alembic."""
    async def concurrent() -> None:
        await asyncio.gather(db.init_db(), db.init_db(), db.init_db())
    asyncio.run(concurrent())


def test_snapshot_limit_rolls_back_and_empty_source_is_honest(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Пустой успешный источник допустим; досье сверх лимита не публикуется."""
    cid = case(client)
    empty = job(["rec-a"], {"points": [], "warnings": ["Точек нет"]}, "dipoles")
    material = add(client, cid, "job", empty.job_id)
    assert material["payload"]["points"] == []
    monkeypatch.setattr(settings, "consilium_snapshot_max_bytes", 1024)
    response = client.post(f"{PREFIX}/{cid}/snapshots", json={
        "request_id": new_id(), "expected_version": 2, "evidence_ids": [material["id"]],
    })
    assert response.status_code == 413, response.text
    assert version(client, cid) == 2
    assert client.get(f"{PREFIX}/{cid}/snapshots").json()["total"] == 0


def test_material_commit_failure_does_not_publish(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Сбой commit не оставляет копию, квитанцию и увеличенную версию."""
    cid = case(client)
    async def broken(self: AsyncSession) -> None:
        raise OperationalError("Private payload", {}, Exception("failure"))
    monkeypatch.setattr(AsyncSession, "commit", broken)
    response = client.post(f"{PREFIX}/{cid}/evidence", json={
        "request_id": new_id(), "expected_version": 1, "source_kind": "analysis", "source_id": "1",
    })
    assert response.status_code == 503
    assert "Private payload" not in response.text
    assert version(client, cid) == 1
    assert client.get(f"{PREFIX}/{cid}/evidence").json()["total"] == 0


def test_sql_row_limit_refuses_truncation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Лимит точек пакета не превращает часть выборки в полный материал."""
    async def extra_point() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.DipolePoint(analysis_id=1, band_key="alpha", epoch_index=1))
            await session.commit()
    asyncio.run(extra_point())
    cid = case(client)
    monkeypatch.setattr(settings, "consilium_source_max_rows", 1)
    response = client.post(f"{PREFIX}/{cid}/evidence", json={
        "request_id": new_id(), "expected_version": 1, "source_kind": "analysis", "source_id": "1",
    })
    assert response.status_code == 413
    assert client.get(f"{PREFIX}/{cid}/evidence").json()["total"] == 0


def test_job_payload_origin_mismatch_is_rejected(client: TestClient) -> None:
    """Повреждённый паспорт не разрешает чужой результат внутри job."""
    cid = case(client)
    mismatch = job(["rec-a"], {"recording_id": "rec-other", "power": 9})
    response = client.post(f"{PREFIX}/{cid}/evidence", json={
        "request_id": new_id(), "expected_version": 1,
        "source_kind": "job", "source_id": mismatch.job_id,
    })
    assert response.status_code == 409
    assert version(client, cid) == 1
