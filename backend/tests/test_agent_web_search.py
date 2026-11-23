"""Веб-поиск Архивариуса: разбор выдачи, сохранение, перевод и контекст промпта."""

import asyncio
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import db
from app.schemas.agent_chat import AgentRoleOut
from app.services import llm_router, streams
from app.services.agent_chat import runner, store, web_search
from app.services.agent_chat.roles import AgentChatError

PREFIX = "/api/v1/agent-chat"

_HTML = """
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpaper&amp;rut=1">
      EEG alpha rhythm
    </a>
  </h2>
  <a class="result__snippet" href="#">Alpha rhythm <b>study</b> in adults</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="https://example.org/second">Second paper</a>
  </h2>
  <a class="result__snippet" href="#">Another snippet</a>
</div>
"""


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


def _mock_client(handler: Any) -> httpx.AsyncClient:
    """HTTP-клиент с MockTransport: сеть в тестах не нужна."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_parse_results_decodes_redirects_and_dedupes() -> None:
    """Ссылка-редирект DuckDuckGo разворачивается, дубли отбрасываются."""
    results = web_search.parse_results(_HTML, 5)
    assert results == [
        {
            "title": "EEG alpha rhythm",
            "url": "https://example.org/paper",
            "snippet": "Alpha rhythm study in adults",
        },
        {
            "title": "Second paper",
            "url": "https://example.org/second",
            "snippet": "Another snippet",
        },
    ]
    assert len(web_search.parse_results(_HTML, 1)) == 1


def test_search_posts_query_and_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Поиск отправляет q и уважает лимит выдачи."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.content.decode()
        return httpx.Response(200, text=_HTML)

    monkeypatch.setattr(web_search, "_client", lambda: _mock_client(handler))
    results, provider = asyncio.run(web_search.search("альфа ритм", limit=1))
    assert provider == "duckduckgo"
    assert len(results) == 1
    assert "q=%D0%B0%D0%BB%D1%8C%D1%84%D0%B0" in seen["body"]


def test_search_provider_error_is_honest(monkeypatch: pytest.MonkeyPatch) -> None:
    """Отказ поисковика — честная ошибка 502, без выдуманных результатов."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    monkeypatch.setattr(web_search, "_client", lambda: _mock_client(handler))
    with pytest.raises(AgentChatError) as excinfo:
        asyncio.run(web_search.search("запрос"))
    assert excinfo.value.status == 502
    assert "503" in str(excinfo.value)


def test_create_and_list_web_search(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """POST сохраняет поиск нити, GET отдаёт его новые сверху."""
    thread = client.post(f"{PREFIX}/threads", json={"title": "Поиск"}).json()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_HTML)

    monkeypatch.setattr(web_search, "_client", lambda: _mock_client(handler))
    created = client.post(
        f"{PREFIX}/threads/{thread['id']}/web-search",
        json={"query": "альфа ритм", "limit": 2},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["query"] == "альфа ритм"
    assert body["provider"] == "duckduckgo"
    assert body["translated"] is False
    assert [item["url"] for item in body["results"]] == [
        "https://example.org/paper", "https://example.org/second",
    ]

    listed = client.get(f"{PREFIX}/threads/{thread['id']}/web-search")
    assert listed.status_code == 200
    assert listed.json()["items"][0]["id"] == body["id"]


def test_translate_web_search(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Перевод сохраняет русские заголовок и фрагмент, отмечая поиск переведённым."""
    thread = client.post(f"{PREFIX}/threads", json={"title": "Перевод"}).json()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_HTML)

    monkeypatch.setattr(web_search, "_client", lambda: _mock_client(handler))
    created = client.post(
        f"{PREFIX}/threads/{thread['id']}/web-search", json={"query": "alpha"},
    ).json()

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None, on_delta: Any = None,
        provider_id: str | None = None, model: str | None = None,
    ) -> llm_router.ChatResult:
        return llm_router.ChatResult(
            text="ЗАГОЛОВОК: Альфа-ритм ЭЭГ\nФРАГМЕНТ: Исследование альфа-ритма",
            provider_id="prov", model="model-x", latency_ms=3.0,
        )

    monkeypatch.setattr(llm_router, "chat", fake_chat)

    async def fake_state() -> SimpleNamespace:
        return _state({"chat": "prov"})

    monkeypatch.setattr(llm_router, "get_state", fake_state)
    translated = client.post(
        f"{PREFIX}/threads/{thread['id']}/web-search/{created['id']}/translate",
    )
    assert translated.status_code == 200, translated.text
    body = translated.json()
    assert body["translated"] is True
    assert body["results"][0]["title_ru"] == "Альфа-ритм ЭЭГ"
    assert body["results"][0]["snippet_ru"] == "Исследование альфа-ритма"


def test_translate_without_chat_route(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без маршрута chat перевод честно отказывает, а не молчит."""
    thread = client.post(f"{PREFIX}/threads", json={"title": "Без маршрута"}).json()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_HTML)

    monkeypatch.setattr(web_search, "_client", lambda: _mock_client(handler))
    created = client.post(
        f"{PREFIX}/threads/{thread['id']}/web-search", json={"query": "alpha"},
    ).json()

    async def fake_state() -> SimpleNamespace:
        return _state({"chat": None})

    monkeypatch.setattr(llm_router, "get_state", fake_state)
    result = client.post(
        f"{PREFIX}/threads/{thread['id']}/web-search/{created['id']}/translate",
    )
    assert result.status_code == 400
    assert "Маршрут chat" in result.json()["detail"]


def test_archivist_prompt_includes_latest_search(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Промпт Архивариуса получает блок найденного и предупреждение о переводе."""
    thread = client.post(f"{PREFIX}/threads", json={"title": "Архив"}).json()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_HTML)

    monkeypatch.setattr(web_search, "_client", lambda: _mock_client(handler))
    client.post(f"{PREFIX}/threads/{thread['id']}/web-search", json={"query": "alpha"})

    role = AgentRoleOut(
        id="archivist", label="Архивариус", instruction="Роль: архивариус.",
        provider_id=None, model=None, enabled=True, builtin=True, sort=5,
    )
    search = asyncio.run(store.latest_web_search(thread["id"]))
    assert search is not None
    context = runner._web_context(search)
    messages, warnings = runner.build_messages(
        role, [], {"archivist": "Архивариус"}, context,
    )
    assert "Найденные в интернете материалы" in messages[1]["content"]
    assert "https://example.org/paper" in messages[1]["content"]
    assert warnings == []


def test_delete_thread_removes_web_searches(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Удаление нити уносит и её поиски."""
    thread = client.post(f"{PREFIX}/threads", json={"title": "Удаление"}).json()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=_HTML)

    monkeypatch.setattr(web_search, "_client", lambda: _mock_client(handler))
    client.post(f"{PREFIX}/threads/{thread['id']}/web-search", json={"query": "alpha"})
    assert client.delete(f"{PREFIX}/threads/{thread['id']}").status_code == 204
    assert client.get(f"{PREFIX}/threads/{thread['id']}/web-search").status_code == 404


def _state(routes: dict[str, str | None]) -> SimpleNamespace:
    """Минимальное состояние роутера для проверки маршрута chat."""
    return SimpleNamespace(routes=routes, providers=[])
