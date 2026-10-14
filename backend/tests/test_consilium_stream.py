"""SSE-стрим раунда советников (срез 0011): дельты ролей и границы потока.

Модель не вызывается: провайдер подменяется тестовым, его текст приходит
кусочками через ``on_delta`` (правило ``docs/rules/tests.md``). Проверяются:
журнал событий дочитывается подписчиком без потерь, честный ``round_done``
позднему подписчику, 404 чужого дела, замена потока повтором (старые подписчики
не висят).
"""

import asyncio
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import db
from app.schemas.consilium import ConsiliumStreamEvent
from app.services import llm_router
from app.services.consilium import streams
from tests.test_consilium_rounds import (
    create_case,
    insert_snapshot,
    request_id,
    role_of,
    wait_round,
)

PREFIX = "/api/v1/consilium/cases"


@pytest.fixture(autouse=True)
def isolated_consilium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своё хранилище БД и чистый RAM-хаб стриминга между тестами."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'stream.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    streams._ROUNDS.clear()
    yield
    streams._ROUNDS.clear()
    asyncio.run(engine.dispose())


@pytest.fixture
def slow_llm(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Тестовый провайдер с медленной генерацией: стрим успевает подключиться."""

    state = SimpleNamespace(chunks=[])

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None,
        on_delta: Any = None,
    ) -> llm_router.ChatResult:
        system = messages[0]["content"] if messages else ""
        role = role_of(system)
        text = f"## Замечено\nЗаметили ({role}).\n## Следующий шаг\nУточнить условия."
        for index in range(0, len(text), 10):
            await asyncio.sleep(0.05)
            chunk = text[index:index + 10]
            state.chunks.append(chunk)
            if on_delta is not None:
                on_delta(chunk)
        return llm_router.ChatResult(
            text=text, provider_id="prov", model="model-x", latency_ms=5.0,
        )

    async def fake_state() -> llm_router.RouterState:
        provider = llm_router.Provider(
            id="prov", label="Тест", protocol="openai", base_url="http://llm.test",
            model="model-x", enabled=True, api_key=None,
        )
        return llm_router.RouterState(
            providers=(provider,), routes={"chat": "prov", "chat_model": None, "transcribe": None},
        )

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


def test_stream_delivers_deltas_and_borders(
    client: TestClient, slow_llm: SimpleNamespace,
) -> None:
    """Живой стрим: дельты складываются в текст роли, поток закрыт round_done."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    started = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    assert started.status_code == 202, started.text
    round_id = started.json()["id"]

    with client.stream(
        "GET", f"{PREFIX}/{case['id']}/rounds/{round_id}/stream",
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "private, no-store"
        body = response.read().decode("utf-8")

    events = _frames(body)
    kinds = [event.type for event in events]
    assert kinds[-1] == "round_done"
    assert "delta" in kinds

    deltas: dict[str, str] = {}
    for event in events:
        if event.type == "delta":
            deltas[str(event.role)] = deltas.get(str(event.role), "") + str(event.delta)
    # Склейка дельт без обрезки краёв возвращает полный текст ответа роли
    assert set(deltas) == {"psychological", "neurophysiological", "methodological"}
    for text in deltas.values():
        assert text.startswith("## Замечено")
        assert text.endswith("Уточнить условия.")
    done_roles = [event.role for event in events if event.type == "role_done"]
    assert len(done_roles) == 3

    # Ответы доехали до БД — стрим был только удобством (§8)
    data = wait_round(client, case["id"], round_id)
    assert data["status"] == "done"


def test_late_subscriber_gets_round_done_only(
    client: TestClient, slow_llm: SimpleNamespace,
) -> None:
    """Поздний подписчик не получает историю текста — только честный round_done."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    started = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    round_id = started.json()["id"]
    wait_round(client, case["id"], round_id)

    result = client.get(f"{PREFIX}/{case['id']}/rounds/{round_id}/stream")
    assert result.status_code == 200
    assert [event.type for event in _frames(result.text)] == ["round_done"]


def test_stream_foreign_case_is_404(
    client: TestClient, slow_llm: SimpleNamespace,
) -> None:
    """Чужой раунд недоступен и в стриме: приватность важнее потока."""
    owner = create_case(client)
    snapshot_id = insert_snapshot(owner["id"])
    started = client.post(f"{PREFIX}/{owner['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    round_id = started.json()["id"]
    stranger = create_case(client)

    result = client.get(f"{PREFIX}/{stranger['id']}/rounds/{round_id}/stream")
    assert result.status_code == 404


def test_open_round_finishes_previous_stream() -> None:
    """Повтор ответа (retry) открывает новый поток: старые подписчики не висят."""
    previous = streams.open_round("round-x", ("psychological",))
    streams.open_round("round-x", ("psychological",))

    assert previous.finished is True
    assert previous.error is not None
    assert streams.get_round("round-x") is not previous
    streams.close_round("round-x")
    assert streams.get_round("round-x") is None


def test_hub_journal_keeps_deltas_and_borders() -> None:
    """Журнал хаба: дельты пишутся как есть (без обрезки пробелов), есть границы."""
    progress = streams.open_round("round-y", ("psychological",))
    progress.role_started("psychological")
    progress.append_delta("psychological", " кусочек ")
    progress.append_delta("psychological", "ещё")
    progress.role_finished("psychological", status="done", model="prov/model-x")
    progress.finish()
    streams.close_round("round-y")

    kinds = [event.type for event in progress.log]
    assert kinds == ["role_started", "delta", "delta", "role_done"]
    assert progress.log[1].delta == " кусочек "  # края дельты сохранены
    assert progress.roles["psychological"].text == " кусочек ещё"
    assert progress.finished is True