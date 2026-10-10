"""Основание Т1: изолированная БД, ручная история, версии, приватные ошибки."""

import asyncio
import uuid
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import db
from app.schemas.consilium import (
    ConsiliumCaseCreate,
    ConsiliumContextCreate,
    ConsiliumEvidence,
    ConsiliumMessageCreate,
)
from app.services.consilium import store

PREFIX = "/api/v1/consilium/cases"


@pytest.fixture(autouse=True)
def isolated_consilium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своё хранилище, ни миграций, ни изменений рабочей БД пользователя."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'cases.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    yield
    asyncio.run(engine.dispose())


def request_id() -> str:
    """Уникальный ключ ручного действия."""
    return str(uuid.uuid4())


def create(client: TestClient, **changes: Any) -> dict[str, Any]:
    """Создаёт дело через реальный HTTP-контракт."""
    payload = {
        "request_id": request_id(), "title": "Музыка и самочувствие",
        "question": "Что доброволец чувствовал при прослушивании?",
        "subject_codes": ["V-1"], **changes,
    }
    result = client.post(PREFIX, json=payload)
    assert result.status_code == 201, result.text
    assert result.headers["Cache-Control"] == "private, no-store"
    return result.json()


def test_case_create_idempotent_and_conflicting_key(client: TestClient) -> None:
    """Повтор создания возвращает тот же id; новый текст с тем же ключом — конфликт."""
    key = request_id()
    first = create(client, request_id=key)
    second = create(client, request_id=key)
    assert first == second
    assert client.get(PREFIX).json()["total"] == 1
    result = client.post(PREFIX, json={
        "request_id": key, "title": "Иное", "question": "Другой вопрос",
    })
    assert result.status_code == 409


def test_update_versions_archive_and_reopen(client: TestClient) -> None:
    """Stale-паспорт не затирает данные; архив read-only до явного открытия."""
    case = create(client)
    payload = {
        "request_id": request_id(), "expected_version": 1,
        "title": case["title"], "question": "Изменённый вопрос",
        "status": "archived", "subject_codes": ["V-1"],
    }
    changed = client.patch(f"{PREFIX}/{case['id']}", json=payload)
    assert changed.status_code == 200, changed.text
    assert changed.json()["version"] == 2
    assert client.patch(f"{PREFIX}/{case['id']}", json=payload).json() == changed.json()
    stale = client.patch(f"{PREFIX}/{case['id']}", json={**payload, "request_id": request_id()})
    assert stale.status_code == 409
    message = client.post(f"{PREFIX}/{case['id']}/messages", json={
        "request_id": request_id(), "expected_version": 2, "text": "Нельзя в архив",
    })
    assert message.status_code == 409
    reopened = client.patch(f"{PREFIX}/{case['id']}", json={
        **payload, "request_id": request_id(), "expected_version": 2, "status": "open",
    })
    assert reopened.status_code == 200
    assert reopened.json()["version"] == 3


def test_context_revisions_keep_original_and_retry(client: TestClient) -> None:
    """Исправление не стирает рассказ; повтор запроса не добавляет ревизию."""
    case = create(client)
    endpoint = f"{PREFIX}/{case['id']}/context"
    payload = {
        "request_id": request_id(), "expected_version": 1, "text": "Мне было не тревожно",
        "kind": "volunteer_report", "subject_code": "V-1", "author": "V-1",
    }
    original = client.post(endpoint, json=payload)
    assert original.status_code == 201, original.text
    assert client.post(endpoint, json=payload).json() == original.json()
    assert client.get(f"{PREFIX}/{case['id']}").json()["version"] == 2
    revision = {
        **payload, "request_id": request_id(), "expected_version": 2,
        "expected_revision": 1, "text": "Мне было спокойно", "verified": True,
    }
    corrected = client.patch(f"{endpoint}/{original.json()['id']}", json=revision)
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["revision"] == 2
    assert client.patch(f"{endpoint}/{original.json()['id']}", json=revision).json() == corrected.json()
    history = client.get(endpoint).json()
    assert history["total"] == 2
    assert [item["text"] for item in history["items"]] == [payload["text"], revision["text"]]
    assert history["items"][0]["start_sec"] is None
    assert history["items"][0]["permissions"]["use_with_advisers"] is False
    stale = client.patch(f"{endpoint}/{original.json()['id']}", json={
        **revision, "request_id": request_id(), "expected_version": 3,
    })
    assert stale.status_code == 409


def test_foreign_entry_and_context_membership(client: TestClient) -> None:
    """Чужая реплика/участник не принимаются как контекст этого дела."""
    first, second = create(client), create(client)
    payload = {"request_id": request_id(), "expected_version": 1, "text": "Наблюдение"}
    entry = client.post(f"{PREFIX}/{first['id']}/context", json=payload).json()
    foreign = client.patch(f"{PREFIX}/{second['id']}/context/{entry['id']}", json={
        **payload, "expected_revision": 1,
    })
    assert foreign.status_code == 404
    for changes in ({"subject_code": "V-other"}, {"recording_id": "rec-other"}):
        response = client.post(f"{PREFIX}/{second['id']}/context", json={**payload, **changes})
        assert response.status_code == 400
    assert client.get(f"{PREFIX}/{second['id']}").json()["version"] == 1


def test_manual_messages_revisions_and_no_faked_adviser(client: TestClient) -> None:
    """Автор задаётся сервером; исходный текст сохраняется при правке."""
    case = create(client)
    endpoint = f"{PREFIX}/{case['id']}/messages"
    payload = {"request_id": request_id(), "expected_version": 1, "text": "Проверим реакцию"}
    result = client.post(endpoint, json=payload)
    assert result.status_code == 201, result.text
    assert result.json()["author"] == "researcher"
    corrected = client.patch(f"{endpoint}/{result.json()['id']}", json={
        **payload, "request_id": request_id(), "expected_version": 2,
        "expected_revision": 1, "text": "Уточним переживание",
    })
    assert corrected.status_code == 200, corrected.text
    assert client.get(endpoint, params={"limit": 1}).json()["total"] == 2
    assert len(client.get(endpoint, params={"limit": 1, "offset": 1}).json()["items"]) == 1
    fake = client.post(endpoint, json={**payload, "author": "adviser"})
    assert fake.status_code == 422


def test_case_delete_cascade_preview_version_and_neighbors(client: TestClient) -> None:
    """Предпросмотр read-only, DELETE очищает квитанции и ревизии, не соседнее дело."""
    case, neighbor = create(client), create(client)
    client.post(f"{PREFIX}/{case['id']}/messages", json={
        "request_id": request_id(), "expected_version": 1, "text": "Чувствительный текст",
    })
    preview = client.get(f"{PREFIX}/{case['id']}/deletion-preview").json()
    assert preview["message_revisions"] == 1 and preview["version"] == 2
    assert client.delete(f"{PREFIX}/{case['id']}", params={"expected_version": 1}).status_code == 409
    assert client.delete(f"{PREFIX}/{case['id']}", params={"expected_version": 2}).status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}").status_code == 404
    assert client.get(f"{PREFIX}/{neighbor['id']}").status_code == 200

    async def check() -> None:
        async with db.AsyncSessionLocal() as session:
            for model in (db.ConsiliumEntry, db.ConsiliumRequest):
                assert (await session.scalars(select(model).where(model.case_id == case["id"]))).all() == []
    asyncio.run(check())


def test_case_list_pagination_and_missing(client: TestClient) -> None:
    """Total до пагинации и отдельные 404 на неизвестные дела."""
    create(client)
    create(client)
    page = client.get(PREFIX, params={"limit": 1, "offset": 1}).json()
    assert page["total"] == 2 and len(page["items"]) == 1
    for suffix in ("", "/context", "/messages", "/deletion-preview"):
        result = client.get(f"{PREFIX}/missing{suffix}")
        assert result.status_code == 404
        assert "no-store" in result.headers["Cache-Control"]


def test_failed_commit_is_not_success_and_does_not_leak(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ни текста SQL, ни реплики в ошибке; неуспешный commit не оставляет дело."""
    async def broken(self: AsyncSession) -> None:
        raise OperationalError("Секретная реплика в SQL", {}, Exception("диск"))

    monkeypatch.setattr(AsyncSession, "commit", broken)
    result = client.post(PREFIX, json={
        "request_id": request_id(), "title": "Приватное", "question": "Чувствительный вопрос",
    })
    assert result.status_code == 503
    assert "Секретная" not in result.text and "Чувствительный" not in result.text
    assert client.get(PREFIX).json()["total"] == 0


def test_recording_links_explicit_and_no_ttl_cascade(client: TestClient) -> None:
    """Создание валидирует запись; удаление исходной строки не удаляет ручное дело."""
    async def seed() -> None:
        await db.init_db()
        async with db.AsyncSessionLocal() as session:
            session.add(db.RecordingRecord(recording_id="rec-one", filename="test.edf"))
            await session.commit()
    asyncio.run(seed())
    case = create(client, recording_ids=["rec-one"])
    unknown = client.post(PREFIX, json={
        "request_id": request_id(), "title": "Нет", "question": "Нет",
        "recording_ids": ["missing"],
    })
    assert unknown.status_code == 404

    async def drop_source() -> None:
        async with db.AsyncSessionLocal() as session:
            row = await session.get(db.RecordingRecord, "rec-one")
            await session.delete(row)
            await session.commit()
    asyncio.run(drop_source())
    saved = client.get(f"{PREFIX}/{case['id']}")
    assert saved.status_code == 200 and saved.json()["recording_ids"] == ["rec-one"]


@pytest.mark.parametrize("changes", [
    {"title": "   "}, {"subject_codes": ["V-1", "V-1"]},
    {"recording_ids": ["../../etc/passwd"]}, {"unknown": 1},
])
def test_contract_rejects_bad_case(changes: dict[str, Any]) -> None:
    """Неизвестные поля, пустые тексты, дубли и пути не проходят контракт."""
    with pytest.raises(ValidationError):
        ConsiliumCaseCreate(request_id="r", question="q", **{"title": "t", **changes})


@pytest.mark.parametrize("changes", [
    {"end_sec": 2}, {"start_sec": 2, "end_sec": 1, "recording_id": "r", "time_basis": "eeg"},
    {"start_sec": 0}, {"start_sec": float("nan")},
    {"permissions": {"external_transfer": True}},
])
def test_context_contract_interval_permissions(changes: dict[str, Any]) -> None:
    """Неизвестное время, NaN и неразрешённая передача не становятся валидным контекстом."""
    with pytest.raises(ValidationError):
        ConsiliumContextCreate(request_id="r", expected_version=1, text="t", **changes)


def test_evidence_contract_keeps_missing_none() -> None:
    """Контракт B15 сохраняет неизмеренное, предупреждения и паспорт модели."""
    evidence = ConsiliumEvidence(
        id="e", revision=1, source_kind="job", source_id="j", recording_ids=["r"],
        payload={"power": None, "count": 0}, signal_state=None, completeness="aggregate",
        warnings=["Редкий монтаж"], missing=["clean_spec"], sha256="a" * 64,
    )
    assert evidence.payload == {"power": None, "count": 0}
    assert evidence.parameters is None and evidence.signal_state is None


def test_persisted_case_read_by_new_session() -> None:
    """Новая сессия читает сохранённое дело, без RAM и реестра задач."""
    created = asyncio.run(store.create_case(ConsiliumCaseCreate(
        request_id="restart", title="Медитация", question="Что менялось?",
    )))
    assert asyncio.run(store.get_case(created.id)) == created
    assert created.created_at <= datetime.utcnow()
    assert ConsiliumMessageCreate(request_id="m", expected_version=1, text="q").text == "q"


def test_validation_error_is_private_and_does_not_echo(client: TestClient) -> None:
    """Ошибка неизвестного поля не отражает текст беседы в диагностике."""
    response = client.post(PREFIX, json={
        "title": "t", "question": "q", "request_id": "r",
        "private_note": "Очень чувствительные слова добровольца",
    })
    assert response.status_code == 422
    assert "no-store" in response.headers["Cache-Control"]
    assert "Очень чувствительные" not in response.text
    assert "input" not in response.json()["detail"][0]


def test_case_survives_dropped_alembic_version(client: TestClient) -> None:
    """Повтор догонки старого файла не пересоздаёт существующую ручную историю."""
    from sqlalchemy import text

    case = create(client)

    async def lose_version() -> None:
        async with db.AsyncSessionLocal() as session:
            await session.execute(text("DROP TABLE alembic_version"))
            await session.commit()

    asyncio.run(lose_version())
    assert client.get(f"{PREFIX}/{case['id']}").json() == case