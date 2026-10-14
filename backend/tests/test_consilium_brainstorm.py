"""Мозговой штурм (срез 0012): разбор ответа, персист идей и резюме, стрим 0011.

Модель не вызывается: провайдер подменяется тестовым (правило
``docs/rules/tests.md``). Проверяются инварианты §8/§10: сырой текст хранится
всегда, нераспознанное — предупреждением, а не достраиванием; повтор ключа не
шлёт данные снова; без маршрута ``chat`` — честный 400; прерванная операция
видна в строке.
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
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import db
from app.schemas.consilium import ConsiliumStreamEvent
from app.services import llm_router
from app.services.consilium import brainstorm, streams
from tests.test_consilium_rounds import create_case, insert_snapshot, request_id

PREFIX = "/api/v1/consilium/cases"

# Ответ тестовой модели строго по формату инструкции штурма
DRAFT = (
    "## Резюме\nМатериалы фрагментарны: видна доля α, контекст обрывочный.\n"
    "## Идеи\n"
    "### 1 · спросить добровольца · Вопрос о самочувствии после прослушивания\n"
    "Основание: рассказ добровольца обрывочен, есть пробелы.\n"
    "Гипотеза: уточнение даст контекст переживания.\n"
    "Риски: наводящий вопрос искажает ответ.\n"
    "Проверка: сверить ответ с наблюдениями исследователя.\n"
    "### 2 · провести пробу · Повторная запись в тишине\n"
    "Основание: спектр смещён низкими частотами.\n"
    "Гипотеза: фон сети вносит вклад.\n"
    "Риски: условия записи отличаются.\n"
    "Проверка: доля α до и после в одном окне.\n"
)


def wait_brainstorm(client: TestClient, case_id: str, brainstorm_id: str) -> dict[str, Any]:
    """Ждёт итога запуска: состояние — в строке, не в файле задачи (§8)."""
    url = f"{PREFIX}/{case_id}/brainstorms/{brainstorm_id}"
    deadline = time.time() + 15
    data: dict[str, Any] = {}
    while time.time() < deadline:
        data = client.get(url).json()
        if data.get("status") != "running":
            return data
        time.sleep(0.02)
    raise AssertionError(f"штурм не завершился: {data}")


@pytest.fixture(autouse=True)
def isolated_consilium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своё хранилище БД и чистый RAM-хаб стриминга между тестами."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'brainstorm.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    streams._ROUNDS.clear()
    yield
    streams._ROUNDS.clear()
    asyncio.run(engine.dispose())


@pytest.fixture
def fake_llm(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Тестовый провайдер: один голос штурма, журнал вызовов, отказ по запросу."""
    state = SimpleNamespace(calls=[], fail=False)

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None,
        on_delta: Any = None,
    ) -> llm_router.ChatResult:
        state.calls.append({"messages": messages})
        if state.fail:
            raise llm_router.LlmRouterError("Сеть недоступна")
        if on_delta is not None:
            # Стриминг (0011): текст приходит кусочками, как у настоящего провайдера
            mid = len(DRAFT) // 2
            on_delta(DRAFT[:mid])
            on_delta(DRAFT[mid:])
        return llm_router.ChatResult(
            text=DRAFT, provider_id="prov", model="model-x", latency_ms=5.0,
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


def start(client: TestClient, case_id: str, snapshot_id: str, **changes: Any) -> dict[str, Any]:
    """Запуск штурма кнопкой; повтор ключа возвращает прежнее тело."""
    payload = {
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
        **changes,
    }
    result = client.post(f"{PREFIX}/{case_id}/brainstorms", json=payload)
    assert result.status_code == 202, result.text
    return result.json()


# ---------- разбор ответа ----------


def test_parse_draft_extracts_summary_and_ideas() -> None:
    summary, ideas, warnings = brainstorm.parse_draft(DRAFT)
    assert summary == "Материалы фрагментарны: видна доля α, контекст обрывочный."
    assert [idea.kind for idea in ideas] == ["ask_volunteer", "run_probe"]
    assert ideas[0].title == "Вопрос о самочувствии после прослушивания"
    assert ideas[1].rationale == "спектр смещён низкими частотами."
    assert ideas[1].check_method == "доля α до и после в одном окне."
    assert warnings == []


def test_parse_draft_keeps_unparsed_parts_as_warnings() -> None:
    text = (
        "Свободный вступление без заголовков.\n"
        "## Идеи\n### 1 · выдумать · Без названия\nОснование: пусто\n"
        "### 2 · провести пробу · Настоящая идея\nПроверка: сделать.\n"
    )
    summary, ideas, warnings = brainstorm.parse_draft(text)
    assert summary is None
    assert [idea.title for idea in ideas] == ["Настоящая идея"]
    assert ideas[0].check_method == "сделать."
    assert any("«Резюме»" in item for item in warnings)
    assert any("не разобрана" in item for item in warnings)


def test_parse_draft_multiline_fields_and_empty_text() -> None:
    text = (
        "## Резюме\nСтрока первая\nСтрока вторая.\n"
        "## Идеи\n### 1 · уточнить наблюдение · Условия пробы\n"
        "Основание: первая строка\nвторая строка.\n"
    )
    summary, ideas, warnings = brainstorm.parse_draft(text)
    assert summary == "Строка первая\nСтрока вторая."
    assert ideas[0].rationale == "первая строка\nвторая строка."
    assert warnings == []
    empty_summary, empty_ideas, empty_warnings = brainstorm.parse_draft("")
    assert empty_summary is None and empty_ideas == []
    assert len(empty_warnings) == 2


# ---------- запуск и персист ----------


def test_brainstorm_persists_summary_and_ideas(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Итог запуска: резюме, карточки идей и сырой текст — одной записью (§8)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    run = start(client, case["id"], snapshot_id)
    # быстрая тестовая модель может успеть ответить до первого чтения строки
    assert run["status"] in {"running", "done"}

    done = wait_brainstorm(client, case["id"], run["id"])
    assert done["status"] == "done"
    assert done["summary"] == "Материалы фрагментарны: видна доля α, контекст обрывочный."
    # контракт убирает пробелы по краям; содержимое draft сохраняется
    assert done["draft"] == DRAFT.strip()
    assert [idea["kind"] for idea in done["ideas"]] == ["ask_volunteer", "run_probe"]
    assert done["ideas"][0]["hypothesis"] == "уточнение даст контекст переживания."
    assert done["ideas"][1]["risks"] == "условия записи отличаются."
    assert done["error"] is None
    # один запуск — один запрос к модели, без перезапросов за спиной
    assert len(fake_llm.calls) == 1


def test_unparseable_answer_keeps_draft_with_warnings(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Нераспознанный формат — предупреждения и сырой текст, без достроенных идей."""

    async def junk_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None, on_delta: Any = None,
    ) -> llm_router.ChatResult:
        return llm_router.ChatResult(
            text="Совсем не по формату", provider_id="prov", model="model-x", latency_ms=5.0,
        )

    monkeypatch.setattr(llm_router, "chat", junk_chat)
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    run = start(client, case["id"], snapshot_id)
    done = wait_brainstorm(client, case["id"], run["id"])

    assert done["status"] == "done"
    assert done["summary"] is None
    assert done["ideas"] == []
    assert done["draft"] == "Совсем не по формату"
    assert len(done["warnings"]) >= 2


def test_repeat_request_id_does_not_start_second_job(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Повтор кнопки тем же ключом возвращает прежнее тело и не шлёт данные снова."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    key = request_id()
    first = start(client, case["id"], snapshot_id, request_id=key)
    second = start(client, case["id"], snapshot_id, request_id=key)
    assert second["id"] == first["id"]

    done = wait_brainstorm(client, case["id"], first["id"])
    assert done["status"] == "done"
    assert len(fake_llm.calls) == 1
    assert client.get(f"{PREFIX}/{case['id']}/brainstorms").json()["total"] == 1


def test_archived_case_rejects_brainstorm(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Архив read-only: новые штурмы не запускаются (правило истории)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    archived = client.patch(f"{PREFIX}/{case['id']}", json={
        "request_id": request_id(), "expected_version": 1,
        "title": case["title"], "question": case["question"],
        "status": "archived", "subject_codes": ["V-1"],
    })
    assert archived.status_code == 200, archived.text

    result = client.post(f"{PREFIX}/{case['id']}/brainstorms", json={
        "request_id": request_id(), "expected_version": 2, "snapshot_id": snapshot_id,
    })
    assert result.status_code == 409


def test_without_chat_route_is_honest_400(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без маршрута chat запуск честно отказывает, а не отвечает заглушкой."""

    async def empty_state() -> llm_router.RouterState:
        return llm_router.RouterState(providers=(), routes={"transcribe": None})

    monkeypatch.setattr(llm_router, "get_state", empty_state)
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    result = client.post(f"{PREFIX}/{case['id']}/brainstorms", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    assert result.status_code == 400


# ---------- стрим (механизм 0011) и состояние строки ----------


@pytest.fixture
def slow_llm(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Медленная генерация: стрим успевает подключиться до итога."""
    state = SimpleNamespace()

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None, on_delta: Any = None,
    ) -> llm_router.ChatResult:
        for index in range(0, len(DRAFT), 40):
            await asyncio.sleep(0.02)
            if on_delta is not None:
                on_delta(DRAFT[index:index + 40])
        return llm_router.ChatResult(
            text=DRAFT, provider_id="prov", model="model-x", latency_ms=5.0,
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
    """Живой стрим штурма: дельты складываются в текст, поток закрыт round_done."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    run = start(client, case["id"], snapshot_id)

    with client.stream(
        "GET", f"{PREFIX}/{case['id']}/brainstorms/{run['id']}/stream",
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "private, no-store"
        body = response.read().decode("utf-8")

    events = _frames(body)
    kinds = [event.type for event in events]
    assert kinds[-1] == "round_done"
    assert "delta" in kinds
    # Склейка дельт без обрезки краёв возвращает полный текст ответа
    text = "".join(str(event.delta) for event in events if event.type == "delta")
    assert text == DRAFT
    assert any(event.type == "role_done" for event in events)

    done = wait_brainstorm(client, case["id"], run["id"])
    assert done["status"] == "done"


def test_late_subscriber_gets_round_done_only(
    client: TestClient, slow_llm: SimpleNamespace,
) -> None:
    """Поздний подписчик не получает историю текста — только честный round_done."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    run = start(client, case["id"], snapshot_id)
    wait_brainstorm(client, case["id"], run["id"])

    result = client.get(f"{PREFIX}/{case['id']}/brainstorms/{run['id']}/stream")
    assert result.status_code == 200
    assert [event.type for event in _frames(result.text)] == ["round_done"]


def test_stream_foreign_case_is_404(
    client: TestClient, slow_llm: SimpleNamespace,
) -> None:
    """Чужой запуск недоступен и в стриме: приватность важнее потока."""
    owner = create_case(client)
    snapshot_id = insert_snapshot(owner["id"])
    run = start(client, owner["id"], snapshot_id)
    wait_brainstorm(client, owner["id"], run["id"])
    stranger = create_case(client)

    result = client.get(f"{PREFIX}/{stranger['id']}/brainstorms/{run['id']}/stream")
    assert result.status_code == 404


def test_mark_interrupted_records_restart_state(client: TestClient) -> None:
    """Старт приложения: «running» без живой задачи — честное «interrupted» (§8)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    run_id = str(uuid.uuid4())

    async def _run() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.ConsiliumBrainstorm(
                id=run_id, case_id=case["id"], snapshot_id=snapshot_id,
                status="running", model="prov/model-x", instruction_version="1",
                summary=None, draft=None, warnings=[], error=None, job_id=None,
                created_at=datetime.utcnow(), finished_at=None,
            ))
            await session.commit()
        assert await brainstorm.mark_interrupted() == 1

    asyncio.run(_run())
    data = client.get(f"{PREFIX}/{case['id']}/brainstorms/{run_id}").json()
    assert data["status"] == "interrupted"
    assert "перезапуском" in data["error"]


def test_delete_case_clears_brainstorm_rows(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Удаление дела очищает штурмы и идеи; счётчики предпросмотра честны."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    run = start(client, case["id"], snapshot_id)
    wait_brainstorm(client, case["id"], run["id"])

    preview = client.get(f"{PREFIX}/{case['id']}/deletion-preview").json()
    assert preview["brainstorms"] == 1 and preview["brainstorm_ideas"] == 2

    deleted = client.delete(f"{PREFIX}/{case['id']}?expected_version={preview['version']}")
    assert deleted.status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}").status_code == 404