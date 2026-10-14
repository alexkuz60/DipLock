"""Боковая консультация (срез 0015): переписка исследователя с одним советником.

Модель не вызывается: провайдер подменяется тестовым (правило
``docs/rules/tests.md``). Проверяются инварианты §8/§10: текст ответа пишется в
БД до успеха задачи, реплики append-only (повтор — новая попытка), повтор
``request_id`` не шлёт данные снова, без маршрута ``chat``/снимка — честный 400,
в нити один идущий ответ, прерванная операция видна в строке и повторяема.
"""

import asyncio
import time
import uuid
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models import db
from app.schemas.consilium import ConsiliumChatMessageOut, ConsiliumStreamEvent
from app.services import llm_router
from app.services.consilium import chat, chat_store, rounds, streams
from tests.test_consilium_rounds import create_case, insert_snapshot, request_id

PREFIX = "/api/v1/consilium/cases"

REPLY = "Уточните у добровольца, как менялось самочувствие в первые минуты."


def send(client: TestClient, case_id: str, **changes: Any) -> dict[str, Any]:
    """Сообщение исследователя кнопкой; ответ советника — задача очереди."""
    payload = {
        "request_id": request_id(), "expected_version": 1,
        "role": "psychological", "text": "Что стоит уточнить у добровольца?",
        **changes,
    }
    result = client.post(f"{PREFIX}/{case_id}/chat-messages", json=payload)
    assert result.status_code == 202, result.text
    return result.json()


def wait_reply(
    client: TestClient, case_id: str, chat_id: str, message_id: str,
) -> dict[str, Any]:
    """Ждёт итога ответа: состояние — в строке сообщения, не в файле задачи (§8)."""
    url = f"{PREFIX}/{case_id}/chats/{chat_id}/messages"
    deadline = time.time() + 15
    data: dict[str, Any] = {}
    while time.time() < deadline:
        items = client.get(url).json()["items"]
        data = next((item for item in items if item["id"] == message_id), {})
        if data.get("status") != "running":
            return data
        time.sleep(0.02)
    raise AssertionError(f"ответ не завершился: {data}")


def insert_running_reply(case_id: str, role: str = "psychological") -> tuple[str, str]:
    """Нить с ожидающим ответом без задачи: строка «running» для инвариантов."""
    chat_id = str(uuid.uuid4())
    reply_id = str(uuid.uuid4())

    async def _run() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.ConsiliumChat(
                id=chat_id, case_id=case_id, role=role, created_at=datetime.utcnow(),
            ))
            session.add(db.ConsiliumChatMessage(
                id=reply_id, case_id=case_id, chat_id=chat_id,
                author_kind="advisor", role=role, text=None,
                status="running", model=None, instruction_version="1",
                snapshot_id="snap-1", warnings=[], error=None, job_id=None,
                latency_ms=None, created_at=datetime.utcnow(), finished_at=None,
            ))
            await session.commit()

    asyncio.run(_run())
    return chat_id, reply_id


@pytest.fixture(autouse=True)
def isolated_consilium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своё хранилище БД и чистый RAM-хаб стриминга между тестами."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'chat.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    streams._ROUNDS.clear()
    yield
    streams._ROUNDS.clear()
    asyncio.run(engine.dispose())


def _fake_state() -> llm_router.RouterState:
    provider = llm_router.Provider(
        id="prov", label="Тест", protocol="openai", base_url="http://llm.test",
        model="model-x", enabled=True, api_key=None,
    )
    return llm_router.RouterState(
        providers=(provider,), routes={"chat": "prov", "chat_model": None, "transcribe": None},
    )


@pytest.fixture
def fake_llm(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Тестовый провайдер: фиксированный ответ, журнал вызовов, отказ/пустота."""
    state = SimpleNamespace(calls=[], fail=False, empty=False)

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None,
        on_delta: Any = None,
    ) -> llm_router.ChatResult:
        state.calls.append({"messages": messages})
        if state.fail:
            raise llm_router.LlmRouterError("Сеть недоступна")
        text = "" if state.empty else REPLY
        if on_delta is not None and text:
            # Стриминг (0011): текст приходит кусочками, как у настоящего провайдера
            mid = len(text) // 2
            on_delta(text[:mid])
            on_delta(text[mid:])
        return llm_router.ChatResult(
            text=text, provider_id="prov", model="model-x", latency_ms=5.0,
        )

    async def fake_state() -> llm_router.RouterState:
        return _fake_state()

    monkeypatch.setattr(llm_router, "chat", fake_chat)
    monkeypatch.setattr(llm_router, "get_state", fake_state)
    return state


# ---------- переписка и контекст ----------


def test_send_message_persists_reply_with_snapshot_basis(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Ответ советника: текст и основание (снимок) в строке, нить — одна на роль."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    sent = send(client, case["id"])

    assert sent["message"]["author"] == "researcher"
    assert sent["message"]["status"] == "ok"
    assert sent["message"]["text"] == "Что стоит уточнить у добровольца?"
    assert sent["reply"]["author"] == "advisor"
    assert sent["reply"]["status"] == "running"

    done = wait_reply(client, case["id"], sent["reply"]["chat_id"], sent["reply"]["id"])
    assert done["status"] == "ok", done
    assert done["text"] == REPLY
    assert done["model"] == "prov/model-x"
    assert done["snapshot_id"] == snapshot_id
    assert done["instruction_version"] == chat.CHAT_INSTRUCTION_VERSION

    chats = client.get(f"{PREFIX}/{case['id']}/chats").json()
    assert chats["total"] == 1
    assert chats["items"][0]["role"] == "psychological"
    assert chats["items"][0]["messages"] == 2

    messages = client.get(
        f"{PREFIX}/{case['id']}/chats/{sent['reply']['chat_id']}/messages",
    ).json()
    assert messages["total"] == 2
    assert [item["author"] for item in messages["items"]] == ["researcher", "advisor"]

    # Промпт: ракурс советника без формата разделов раунда, досье и переписка
    call = fake_llm.calls[0]["messages"]
    assert "психологический советник" in call[0]["content"]
    assert "Формат ответа" not in call[0]["content"]
    assert "Вопрос исследования" in call[1]["content"]
    assert "История консультации" in call[1]["content"]
    assert "Что стоит уточнить у добровольца?" in call[1]["content"]


def test_send_without_snapshot_is_400(client: TestClient, fake_llm: SimpleNamespace) -> None:
    """Без опубликованного снимка консультация не начинается — честный 400."""
    case = create_case(client)
    result = client.post(f"{PREFIX}/{case['id']}/chat-messages", json={
        "request_id": request_id(), "expected_version": 1,
        "role": "psychological", "text": "Вопрос без досье",
    })
    assert result.status_code == 400, result.text
    assert "снимка" in result.text
    assert fake_llm.calls == []


def test_send_without_chat_route_is_400(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без маршрута chat — честный 400, фиктивных ответов нет."""
    async def no_route_state() -> llm_router.RouterState:
        return llm_router.RouterState(
            providers=(), routes={"chat": None, "chat_model": None, "transcribe": None},
        )

    monkeypatch.setattr(llm_router, "get_state", no_route_state)
    case = create_case(client)
    insert_snapshot(case["id"])
    result = client.post(f"{PREFIX}/{case['id']}/chat-messages", json={
        "request_id": request_id(), "expected_version": 1,
        "role": "psychological", "text": "Вопрос без маршрута",
    })
    assert result.status_code == 400, result.text
    assert "Маршрут ИИ не назначен" in result.text


def test_repeat_request_id_does_not_send_again(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Повтор ключа возвращает прежнее тело и не шлёт данные снова."""
    case = create_case(client)
    insert_snapshot(case["id"])
    payload = {
        "request_id": request_id(), "expected_version": 1,
        "role": "psychological", "text": "Один и тот же вопрос",
    }
    first = client.post(f"{PREFIX}/{case['id']}/chat-messages", json=payload)
    assert first.status_code == 202, first.text
    repeat = client.post(f"{PREFIX}/{case['id']}/chat-messages", json=payload)
    assert repeat.status_code == 202, repeat.text
    assert repeat.json() == first.json()
    assert len(fake_llm.calls) == 1

    messages = client.get(
        f"{PREFIX}/{case['id']}/chats/{first.json()['reply']['chat_id']}/messages",
    ).json()
    assert messages["total"] == 2

    # Другой текст с тем же ключом — 409, не молчаливый дубль
    conflict = client.post(f"{PREFIX}/{case['id']}/chat-messages", json={
        **payload, "text": "Другой вопрос с тем же ключом",
    })
    assert conflict.status_code == 409, conflict.text


def test_second_message_while_reply_running_is_409(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """В нити один идущий ответ: новый запрос до завершения — 409, без записи."""
    case = create_case(client)
    insert_snapshot(case["id"])
    chat_id, _reply_id = insert_running_reply(case["id"])

    result = client.post(f"{PREFIX}/{case['id']}/chat-messages", json={
        "request_id": request_id(), "expected_version": 1,
        "role": "psychological", "text": "Второй вопрос в той же нити",
    })
    assert result.status_code == 409, result.text
    assert "уже отвечает" in result.text
    assert fake_llm.calls == []
    messages = client.get(f"{PREFIX}/{case['id']}/chats/{chat_id}/messages").json()
    assert messages["total"] == 1  # только вставленная ожидающая строка


# ---------- отказы и повторы ----------


def test_failed_reply_is_retried_as_new_attempt(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Неудавшийся ответ — честной ошибкой; повтор — новая попытка, история остаётся."""
    case = create_case(client)
    insert_snapshot(case["id"])
    fake_llm.fail = True
    sent = send(client, case["id"])
    failed = wait_reply(client, case["id"], sent["reply"]["chat_id"], sent["reply"]["id"])
    assert failed["status"] == "failed"
    assert failed["text"] is None
    assert "Сеть недоступна" in (failed["error"] or "")

    fake_llm.fail = False
    retry = client.post(
        f"{PREFIX}/{case['id']}/chat-messages/{sent['reply']['id']}/retry",
        json={"request_id": request_id(), "expected_version": 2},
    )
    assert retry.status_code == 202, retry.text
    attempt = retry.json()
    assert attempt["id"] != sent["reply"]["id"]
    assert attempt["status"] == "running"

    done = wait_reply(client, case["id"], attempt["chat_id"], attempt["id"])
    assert done["status"] == "ok", done
    assert done["text"] == REPLY

    # append-only: неудавшаяся попытка остаётся, всего три строки
    messages = client.get(f"{PREFIX}/{case['id']}/chats/{attempt['chat_id']}/messages").json()
    assert messages["total"] == 3
    statuses = [item["status"] for item in messages["items"]]
    assert statuses == ["ok", "failed", "ok"]


def test_retry_requires_failed_advisor_reply(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Повторить можно только неудавшийся ответ советника, не реплику исследователя."""
    case = create_case(client)
    insert_snapshot(case["id"])
    sent = send(client, case["id"])
    wait_reply(client, case["id"], sent["reply"]["chat_id"], sent["reply"]["id"])

    for message_id, expected in (
        (sent["message"]["id"], 400),  # реплика исследователя
        (sent["reply"]["id"], 400),  # успешный ответ
        ("missing-id", 404),
    ):
        result = client.post(
            f"{PREFIX}/{case['id']}/chat-messages/{message_id}/retry",
            json={"request_id": request_id(), "expected_version": 2},
        )
        assert result.status_code == expected, result.text


def test_empty_answer_is_honest_failure(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Пустой ответ модели — честный отказ, не достроенный текст."""
    case = create_case(client)
    insert_snapshot(case["id"])
    fake_llm.empty = True
    sent = send(client, case["id"])
    done = wait_reply(client, case["id"], sent["reply"]["chat_id"], sent["reply"]["id"])
    assert done["status"] == "failed"
    assert done["text"] is None
    assert done["error"] == "Модель вернула пустой ответ"


# ---------- стрим (механизм 0011) ----------


@pytest.fixture
def slow_llm(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Тестовый провайдер с медленной генерацией: стрим успевает подключиться."""

    state = SimpleNamespace(chunks=[])

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None,
        on_delta: Any = None,
    ) -> llm_router.ChatResult:
        for index in range(0, len(REPLY), 10):
            await asyncio.sleep(0.05)
            chunk = REPLY[index:index + 10]
            state.chunks.append(chunk)
            if on_delta is not None:
                on_delta(chunk)
        return llm_router.ChatResult(
            text=REPLY, provider_id="prov", model="model-x", latency_ms=5.0,
        )

    async def fake_state() -> llm_router.RouterState:
        return _fake_state()

    monkeypatch.setattr(llm_router, "chat", fake_chat)
    monkeypatch.setattr(llm_router, "get_state", fake_state)
    return state


def _frames(body: str) -> list[ConsiliumStreamEvent]:
    """Разобрать тело SSE-ответа в события (фреймы `data:` + JSON)."""
    events: list[ConsiliumStreamEvent] = []
    for block in body.split("\n\n"):
        for line in block.splitlines():
            if line.startswith("data:"):
                events.append(ConsiliumStreamEvent.model_validate_json(line[5:].strip()))
                break
    return events


def test_chat_stream_delivers_deltas_and_round_done(
    client: TestClient, slow_llm: SimpleNamespace,
) -> None:
    """Живой стрим ответа: дельты складываются в текст, поток закрыт round_done."""
    case = create_case(client)
    insert_snapshot(case["id"])
    sent = send(client, case["id"])

    with client.stream(
        "GET", f"{PREFIX}/{case['id']}/chat-messages/{sent['reply']['id']}/stream",
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "private, no-store"
        body = response.read().decode("utf-8")

    events = _frames(body)
    kinds = [event.type for event in events]
    assert kinds[-1] == "round_done"
    assert "delta" in kinds
    text = "".join(event.delta or "" for event in events if event.type == "delta")
    assert text == REPLY
    assert events[-1].error is None


def test_stream_foreign_case_is_404(client: TestClient, fake_llm: SimpleNamespace) -> None:
    """Чужое дело или отсутствующая реплика — честный 404, не чужой поток."""
    first = create_case(client)
    other = create_case(client)
    insert_snapshot(first["id"])
    sent = send(client, first["id"])
    for case_id, message_id in (
        (other["id"], sent["reply"]["id"]),
        (first["id"], "missing-id"),
    ):
        result = client.get(f"{PREFIX}/{case_id}/chat-messages/{message_id}/stream")
        assert result.status_code == 404, result.text


# ---------- архив, прерывание, удаление ----------


def test_archived_case_rejects_new_messages(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Архив — read-only: новые реплики консультации не принимаются."""
    case = create_case(client)
    insert_snapshot(case["id"])
    updated = client.patch(f"{PREFIX}/{case['id']}", json={
        "request_id": request_id(), "expected_version": 1,
        "title": "Музыка и самочувствие",
        "question": "Что доброволец чувствовал при прослушивании?",
        "subject_codes": ["V-1"],
        "status": "archived",
    })
    assert updated.status_code == 200, updated.text

    result = client.post(f"{PREFIX}/{case['id']}/chat-messages", json={
        "request_id": request_id(), "expected_version": 2,
        "role": "psychological", "text": "Вопрос в архив",
    })
    assert result.status_code == 409, result.text
    assert "архивировано" in result.text
    assert fake_llm.calls == []


def test_interrupted_reply_is_retriable(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Прерванная рестартом операция видна в строке и повторяема."""
    case = create_case(client)
    insert_snapshot(case["id"])
    chat_id, reply_id = insert_running_reply(case["id"])
    assert asyncio.run(chat_store.mark_interrupted()) == 1

    messages = client.get(f"{PREFIX}/{case['id']}/chats/{chat_id}/messages").json()
    row = messages["items"][0]
    assert row["status"] == "interrupted"
    assert "перезапуском" in row["error"]

    retry = client.post(
        f"{PREFIX}/{case['id']}/chat-messages/{reply_id}/retry",
        json={"request_id": request_id(), "expected_version": 1},
    )
    assert retry.status_code == 202, retry.text
    done = wait_reply(client, case["id"], chat_id, retry.json()["id"])
    assert done["status"] == "ok", done


def test_deletion_preview_counts_and_cascade(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Счётчики переписки видны до подтверждения; удаление чистит нити каскадом."""
    case = create_case(client)
    insert_snapshot(case["id"])
    sent = send(client, case["id"])
    wait_reply(client, case["id"], sent["reply"]["chat_id"], sent["reply"]["id"])

    preview = client.get(f"{PREFIX}/{case['id']}/deletion-preview").json()
    assert preview["chats"] == 1
    assert preview["chat_messages"] == 2
    assert any("консультаций" in warning for warning in preview["warnings"])

    deleted = client.delete(
        f"{PREFIX}/{case['id']}", params={"expected_version": preview["version"]},
    )
    assert deleted.status_code == 204, deleted.text
    assert client.get(f"{PREFIX}/{case['id']}/chats").status_code == 404

    async def _count() -> int:
        async with db.AsyncSessionLocal() as session:
            return len((await session.scalars(select(db.ConsiliumChatMessage))).all())

    assert asyncio.run(_count()) == 0


# ---------- сборка промпта ----------


def _row(
    message_id: str, author: str, text: str | None, status: str = "ok",
) -> ConsiliumChatMessageOut:
    return ConsiliumChatMessageOut.model_validate({
        "id": message_id, "case_id": "case-1", "chat_id": "chat-1",
        "author": author, "role": "psychological", "status": status,
        "text": text, "created_at": datetime.utcnow(),
    })


def test_build_messages_skips_failed_and_pending_rows() -> None:
    """В промпт идут реплики исследователя и успешные ответы; сбой и ожидание — мимо."""
    advisor = rounds.ADVISOR_BY_ROLE["psychological"]
    history = [
        _row("m1", "researcher", "Первый вопрос"),
        _row("a1", "advisor", "Сбойный ответ", status="failed"),
        _row("a2", "advisor", None, status="running"),
        _row("m2", "researcher", "Второй вопрос"),
        _row("a3", "advisor", "Успешный ответ"),
    ]
    messages, warnings = chat.build_messages(
        advisor, "Вопрос исследования?", "Досье.", history, "a2",
    )
    assert warnings == []
    content = messages[1]["content"]
    assert "Первый вопрос" in content
    assert "Второй вопрос" in content
    assert "Успешный ответ" in content
    assert "Сбойный ответ" not in content
    # Инструкция советника — без формата разделов раунда
    assert "Формат ответа" not in messages[0]["content"]
    assert "психологический советник" in messages[0]["content"]


def test_build_messages_budget_drops_oldest_with_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Бюджет промпта: не влезшее — честным предупреждением, не молчаливым усечением."""
    monkeypatch.setattr(settings, "consilium_prompt_max_chars", 120)
    advisor = rounds.ADVISOR_BY_ROLE["psychological"]
    history = [
        _row("m1", "researcher", "Старое сообщение " + "х" * 300),
        _row("m2", "researcher", "Новое сообщение"),
    ]
    messages, warnings = chat.build_messages(advisor, "В?", "Д.", history, "none")
    assert any("не вошли ранние реплики" in item for item in warnings)
    content = messages[1]["content"]
    assert "Новое сообщение" in content
    assert "Старое сообщение" not in content