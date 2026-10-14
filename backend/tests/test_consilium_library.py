"""Библиотека исследования (Т5, срез 0013): предложения, решения, исполнения.

Инварианты §7 ``docs/rules/consilium.md``: решение человека — append-only
строка с адресом версии карточки (правка делает старое решение прошлым);
исполнение — вручную, отдельными строками; повтор ключа не дублирует строки;
архив read-only; удаление дела очищает библиотеку.
"""

import asyncio
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import db
from tests.test_consilium_rounds import create_case, request_id

PREFIX = "/api/v1/consilium/cases"


@pytest.fixture(autouse=True)
def isolated_consilium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своё хранилище БД между тестами."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'library.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    yield
    asyncio.run(engine.dispose())


def add_proposal(
    client: TestClient, case_id: str, version: int, **changes: object,
) -> dict:
    """Новое предложение кнопкой; остальные поля — разумные значения по умолчанию."""
    payload = {
        "request_id": request_id(), "expected_version": version,
        "kind": "run_probe", "title": "Повторная запись в тишине",
        "rationale": "спектр смещён низкими частотами",
        "check_method": "доля α до и после",
        **changes,
    }
    result = client.post(f"{PREFIX}/{case_id}/proposals", json=payload)
    assert result.status_code == 201, result.text
    return result.json()


def decide(
    client: TestClient, case_id: str, proposal_id: str, version: int, **changes: object,
) -> dict:
    """Решение человека (принято/отклонено) с адресом версии дела."""
    payload = {
        "request_id": request_id(), "expected_version": version,
        "decision": "accepted", "comment": "согласовано с методологом",
        **changes,
    }
    result = client.post(
        f"{PREFIX}/{case_id}/proposals/{proposal_id}/decisions", json=payload,
    )
    assert result.status_code == 201, result.text
    return result.json()


def execute(
    client: TestClient, case_id: str, proposal_id: str, version: int, **changes: object,
) -> dict:
    """Ручное исполнение предложения с результатом."""
    payload = {
        "request_id": request_id(), "expected_version": version,
        "note": "записал повторную пробу в тишине", "result": "доля α выросла на 8%",
        **changes,
    }
    result = client.post(
        f"{PREFIX}/{case_id}/proposals/{proposal_id}/executions", json=payload,
    )
    assert result.status_code == 201, result.text
    return result.json()


# ---------- карточки и версии ----------


def test_create_proposal_from_idea_and_list(client: TestClient) -> None:
    """Идея штурма вносится в библиотеку с фиксацией источника (Т5)."""
    case = create_case(client)
    created = add_proposal(
        client, case["id"], 1,
        source="brainstorm", source_id="idea-1", hypothesis="фон сети вносит вклад",
    )
    assert created["version"] == 1
    assert created["source"] == "brainstorm" and created["source_id"] == "idea-1"
    assert created["decisions"] == [] and created["executions"] == []

    page = client.get(f"{PREFIX}/{case['id']}/proposals").json()
    assert page["total"] == 1
    assert page["items"][0]["title"] == "Повторная запись в тишине"
    assert page["items"][0]["check_method"] == "доля α до и после"


def test_update_bumps_version_and_decisions_address_versions(client: TestClient) -> None:
    """Правка карточки — новая версия; решения адресуют версии, а не «карточку вообще»."""
    case = create_case(client)
    proposal = add_proposal(client, case["id"], 1)
    first = decide(client, case["id"], proposal["id"], 2)
    assert first["proposal_version"] == 1

    updated = client.patch(
        f"{PREFIX}/{case['id']}/proposals/{proposal['id']}",
        json={
            "request_id": request_id(), "expected_version": 3,
            "kind": "run_probe", "title": "Повторная запись в тишине (уточнено)",
            "check_method": "доля α и L1 до/после",
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["version"] == 2
    assert body["decisions"][0]["proposal_version"] == 1  # старое решение — прошлое

    second = decide(
        client, case["id"], proposal["id"], 4, decision="rejected", comment="рано",
    )
    assert second["proposal_version"] == 2

    detail = client.get(f"{PREFIX}/{case['id']}/proposals/{proposal['id']}").json()
    # append-only: обе строки решений на месте, новые сверху
    assert [item["decision"] for item in detail["decisions"]] == ["rejected", "accepted"]
    assert [item["proposal_version"] for item in detail["decisions"]] == [2, 1]


def test_executions_are_append_only(client: TestClient) -> None:
    """Каждое ручное исполнение — новой строкой: рекомендацию можно воспроизвести (Т5)."""
    case = create_case(client)
    proposal = add_proposal(client, case["id"], 1)
    first = execute(client, case["id"], proposal["id"], 2)
    second = execute(
        client, case["id"], proposal["id"], 3,
        note="повторил пробу через неделю", result="эффект не повторился",
    )
    assert first["result"] == "доля α выросла на 8%"

    detail = client.get(f"{PREFIX}/{case['id']}/proposals/{proposal['id']}").json()
    assert [item["id"] for item in detail["executions"]] == [second["id"], first["id"]]
    assert detail["executions"][0]["result"] == "эффект не повторился"
    assert detail["executions"][1]["result"] == "доля α выросла на 8%"


# ---------- честные границы ----------


def test_repeat_request_id_returns_same_row(client: TestClient) -> None:
    """Повтор ключа не дублирует карточку: повтор UI отправляет прежнее тело."""
    case = create_case(client)
    key = request_id()
    first = add_proposal(client, case["id"], 1, request_id=key)
    second = add_proposal(client, case["id"], 1, request_id=key)
    assert second["id"] == first["id"]
    assert client.get(f"{PREFIX}/{case['id']}/proposals").json()["total"] == 1


def test_archived_case_rejects_library_writes(client: TestClient) -> None:
    """Архив read-only: предложения и решения не добавляются (правило истории)."""
    case = create_case(client)
    proposal = add_proposal(client, case["id"], 1)
    archived = client.patch(f"{PREFIX}/{case['id']}", json={
        "request_id": request_id(), "expected_version": 2,
        "title": case["title"], "question": case["question"],
        "status": "archived", "subject_codes": ["V-1"],
    })
    assert archived.status_code == 200, archived.text

    assert client.post(f"{PREFIX}/{case['id']}/proposals", json={
        "request_id": request_id(), "expected_version": 3,
        "kind": "ask_volunteer", "title": "Новый вопрос добровольцу",
    }).status_code == 409
    result = client.post(
        f"{PREFIX}/{case['id']}/proposals/{proposal['id']}/decisions",
        json={
            "request_id": request_id(), "expected_version": 3,
            "decision": "rejected", "comment": "архив",
        },
    )
    assert result.status_code == 409


def test_foreign_proposal_is_404(client: TestClient) -> None:
    """Чужое предложение недоступно: приватность важнее удобства."""
    owner = create_case(client)
    proposal = add_proposal(client, owner["id"], 1)
    stranger = create_case(client)
    result = client.get(f"{PREFIX}/{stranger['id']}/proposals/{proposal['id']}")
    assert result.status_code == 404


def test_delete_case_clears_library_rows(client: TestClient) -> None:
    """Удаление дела очищает библиотеку; счётчики предпросмотра честны."""
    case = create_case(client)
    proposal = add_proposal(client, case["id"], 1)
    decide(client, case["id"], proposal["id"], 2)
    execute(client, case["id"], proposal["id"], 3)

    preview = client.get(f"{PREFIX}/{case['id']}/deletion-preview").json()
    assert preview["proposals"] == 1
    assert preview["decisions"] == 1
    assert preview["executions"] == 1

    deleted = client.delete(f"{PREFIX}/{case['id']}?expected_version={preview['version']}")
    assert deleted.status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}").status_code == 404