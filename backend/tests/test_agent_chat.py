"""Общий чат консилиума с ролевыми агентами: роли, адресация, ответы, стрим, отказы."""

import asyncio
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import db
from app.schemas.agent_chat import AgentMessageOut
from app.schemas.streams import StreamEvent
from app.services import llm_router, streams
from app.services.agent_chat import roles, runner, store

PREFIX = "/api/v1/agent-chat"
REPLY = "С точки зрения методиста, сначала проверьте артефакты."


@pytest.fixture(autouse=True)
def isolated_chat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своя БД и чистый RAM-хаб стриминга между тестами."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'agents.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    streams._ROUNDS.clear()
    yield
    streams._ROUNDS.clear()
    asyncio.run(engine.dispose())


@pytest.fixture
def fake_llm(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Тестовый провайдер: фиксированный ответ, журнал вызовов, отказ."""
    state = SimpleNamespace(calls=[], fail=False)

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None, on_delta: Any = None,
        provider_id: str | None = None, model: str | None = None,
    ) -> llm_router.ChatResult:
        state.calls.append({"messages": messages, "provider_id": provider_id, "model": model})
        if state.fail:
            raise llm_router.LlmRouterError("Сеть недоступна")
        if on_delta is not None:
            on_delta(REPLY[:10])
            on_delta(REPLY[10:])
        return llm_router.ChatResult(
            text=REPLY, provider_id=provider_id or "prov", model=model or "model-x",
            latency_ms=5.0,
        )

    monkeypatch.setattr(llm_router, "chat", fake_chat)
    return state


def new_thread(client: TestClient) -> str:
    result = client.post(f"{PREFIX}/threads", json={"title": "Тест"})
    assert result.status_code == 201, result.text
    return str(result.json()["id"])


def wait_reply(client: TestClient, thread_id: str, message_id: str) -> dict[str, Any]:
    deadline = time.time() + 10
    while time.time() < deadline:
        item = client.get(f"{PREFIX}/threads/{thread_id}/messages/{message_id}").json()
        if item["status"] != "running":
            return dict(item)
        time.sleep(0.05)
    raise AssertionError("Ответ агента не завершился")


def test_default_roles_seeded_once(client: TestClient) -> None:
    items = client.get(f"{PREFIX}/roles").json()["items"]
    assert [r["id"] for r in items] == [
        "psychologist", "psychotherapist", "neurophysiologist",
        "eeg_methodist", "mne_expert", "archivist", "assistant",
    ]
    assert len(client.get(f"{PREFIX}/roles").json()["items"]) == 7


def test_mention_routes_to_role_and_reply_is_saved(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    thread_id = new_thread(client)
    sent = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "@ЭЭГ-методист что с артефактами?",
    })
    assert sent.status_code == 202, sent.text
    body = sent.json()
    assert body["message"]["addressees"] == ["eeg_methodist"]
    assert [r["role_id"] for r in body["replies"]] == ["eeg_methodist"]
    done = wait_reply(client, thread_id, body["replies"][0]["id"])
    assert done["status"] == "ok"
    assert done["text"] == REPLY
    system = fake_llm.calls[0]["messages"][0]["content"]
    assert "ЭЭГ-методист" in system or "ЭЭГ-методист" in fake_llm.calls[0]["messages"][1]["content"]
    threads = client.get(f"{PREFIX}/threads").json()["items"]
    assert threads[0]["messages"] == 2


def test_two_roles_both_see_thread_and_answer(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    thread_id = new_thread(client)
    sent = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "Оцените запись", "role_ids": ["psychologist", "neurophysiologist"],
    }).json()
    assert len(sent["replies"]) == 2
    for reply in sent["replies"]:
        assert wait_reply(client, thread_id, reply["id"])["status"] == "ok"
    second = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "@Архивариус подведи итог",
    }).json()
    assert wait_reply(client, thread_id, second["replies"][0]["id"])["status"] == "ok"
    transcript = fake_llm.calls[-1]["messages"][1]["content"]
    assert "### Психолог" in transcript and "### Нейрофизиолог" in transcript
    assert "### Исследователь" in transcript


def test_thread_cannot_be_deleted_while_an_agent_is_running(client: TestClient) -> None:
    thread_id = new_thread(client)
    asyncio.run(store.add_exchange(thread_id, "Вопрос", ["psychologist"]))
    result = client.delete(f"{PREFIX}/threads/{thread_id}")
    assert result.status_code == 409
    assert client.get(f"{PREFIX}/threads/{thread_id}/messages").status_code == 200


def test_blank_message_is_rejected(client: TestClient) -> None:
    thread_id = new_thread(client)
    result = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={"text": "   "})
    assert result.status_code == 422


def test_history_excludes_future_exchange_and_current_colleagues(
    client: TestClient,
) -> None:
    thread_id = new_thread(client)
    question, replies = asyncio.run(
        store.add_exchange(thread_id, "Первый вопрос", ["psychologist", "archivist"]),
    )
    future, _ = asyncio.run(store.add_exchange(thread_id, "Будущий вопрос", ["psychologist"]))
    history = asyncio.run(store.history_before(thread_id, replies[0].id))
    assert [item.id for item in history] == [question.id]
    assert future.id not in [item.id for item in history]


def test_no_addressee_is_400(client: TestClient, fake_llm: SimpleNamespace) -> None:
    thread_id = new_thread(client)
    result = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={"text": "Привет всем"})
    assert result.status_code == 400
    assert "к кому" in result.json()["detail"]
    assert not fake_llm.calls


def test_unknown_and_disabled_roles(client: TestClient, fake_llm: SimpleNamespace) -> None:
    thread_id = new_thread(client)
    unknown = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "x", "role_ids": ["nobody"],
    })
    assert unknown.status_code == 400
    client.put(f"{PREFIX}/roles/psychologist", json={"enabled": False})
    disabled = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "@Психолог ты тут?",
    })
    assert disabled.status_code == 400


def test_role_model_override_reaches_router(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    thread_id = new_thread(client)
    client.put(f"{PREFIX}/roles/archivist", json={"provider_id": "deepseek", "model": "m-1"})
    sent = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "@Архивариус привет",
    }).json()
    done = wait_reply(client, thread_id, sent["replies"][0]["id"])
    assert fake_llm.calls[0]["provider_id"] == "deepseek"
    assert fake_llm.calls[0]["model"] == "m-1"
    assert done["model"] == "deepseek/m-1"


def test_failure_is_honest_and_retry_recovers(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    thread_id = new_thread(client)
    fake_llm.fail = True
    sent = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "@Психолог помоги",
    }).json()
    reply_id = sent["replies"][0]["id"]
    failed = wait_reply(client, thread_id, reply_id)
    assert failed["status"] == "failed"
    assert failed["error"] == "Сеть недоступна"
    assert failed["text"] is None
    fake_llm.fail = False
    retry = client.post(f"{PREFIX}/threads/{thread_id}/messages/{reply_id}/retry")
    assert retry.status_code == 202
    recovered = wait_reply(client, thread_id, reply_id)
    assert recovered["status"] == "ok"
    # След прошлой ошибки не стирается: уходит в warnings реплики.
    assert any("Предыдущая попытка: Сеть недоступна" in item for item in recovered["warnings"])
    again = client.post(f"{PREFIX}/threads/{thread_id}/messages/{reply_id}/retry")
    assert again.status_code == 409


def test_custom_role_crud(client: TestClient) -> None:
    created = client.post(f"{PREFIX}/roles", json={
        "label": "Скептик", "instruction": "Ищи слабые места.",
    })
    assert created.status_code == 201
    role_id = created.json()["id"]
    assert client.post(f"{PREFIX}/roles", json={
        "label": "скептик", "instruction": "дубль",
    }).status_code == 409
    assert client.delete(f"{PREFIX}/roles/psychologist").status_code == 400
    assert client.delete(f"{PREFIX}/roles/{role_id}").status_code == 204
    assert client.delete(f"{PREFIX}/roles/{role_id}").status_code == 404


def test_stream_late_subscriber_gets_round_done(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    thread_id = new_thread(client)
    sent = client.post(f"{PREFIX}/threads/{thread_id}/messages", json={
        "text": "@Психолог привет",
    }).json()
    reply_id = sent["replies"][0]["id"]
    wait_reply(client, thread_id, reply_id)
    with client.stream("GET", f"{PREFIX}/threads/{thread_id}/messages/{reply_id}/stream") as r:
        assert r.status_code == 200
        text = "".join(r.iter_text())
    assert "round_done" in text
    assert StreamEvent  # контракт потока общий с Консилиумом


def test_find_mentions_respects_word_boundary() -> None:
    items = asyncio.run(_roles())
    assert roles.find_mentions("@Психолог и @Психотерапевт", items) == [
        "psychologist", "psychotherapist",
    ]
    assert roles.find_mentions("@Психологи", items) == []


async def _roles() -> list[Any]:
    return (await roles.list_roles()).items


def test_prompt_budget_drops_early_replies(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner.settings, "agent_chat_prompt_max_chars", 2000)
    role = asyncio.run(roles.get_role("psychologist"))
    history = [
        AgentMessageOut.model_validate({
            "id": str(i), "thread_id": "t", "author": "researcher", "role_id": None,
            "addressees": [], "status": "ok", "text": "x" * 900, "model": None,
            "error": None, "warnings": [], "latency_ms": None,
            "created_at": "2026-11-20T00:00:00", "finished_at": None,
        })
        for i in range(5)
    ]
    messages, warnings = runner.build_messages(role, history, {})
    assert warnings and "не вошли ранние реплики" in warnings[0]
    assert messages[1]["content"].count("### Исследователь") < 5


def test_mark_interrupted_marks_running(client: TestClient, fake_llm: SimpleNamespace) -> None:
    thread_id = new_thread(client)
    _, replies = asyncio.run(store.add_exchange(thread_id, "q", ["psychologist"]))
    assert asyncio.run(store.mark_interrupted()) == 1
    items = client.get(f"{PREFIX}/threads/{thread_id}/messages").json()["items"]
    # Вопрос и ответ делят created_at: порядок задан явно, ответ — последний.
    assert items[0]["author"] == "researcher"
    assert items[-1]["id"] == replies[0].id
    assert items[-1]["status"] == "interrupted"
