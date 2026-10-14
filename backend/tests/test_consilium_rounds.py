"""Раунды советников (Т3): оркестрация, границы, append-only история, честность.

Модель не вызывается: провайдер подменяется тестовым (правило
``docs/rules/tests.md``). Проверяются инварианты §6/§8/§10: отказ одной роли
не уничтожает остальные, успех — после записи, контекст без разрешения не
уходит советнику, удаление материала очищает производные сводки.
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
from app.schemas.consilium import (
    ConsiliumRoundCreate,
    ConsiliumSnapshot,
)
from app.services import llm_router
from app.services.consilium import rounds, rounds_store

PREFIX = "/api/v1/consilium/cases"

# Маркеры ролей в системных промптах (инструкции rounds.ADVISORS)
_MARKERS = {
    "psychological": "психологический советник",
    "neurophysiological": "нейрофизиологический советник",
    "methodological": "методологический советник",
    "summary": "итог исследовательского консилиума",
}


def request_id() -> str:
    return str(uuid.uuid4())


def create_case(client: TestClient) -> dict[str, Any]:
    result = client.post(PREFIX, json={
        "request_id": request_id(), "title": "Музыка и самочувствие",
        "question": "Что доброволец чувствовал при прослушивании?",
        "subject_codes": ["V-1"],
    })
    assert result.status_code == 201, result.text
    return result.json()


def insert_snapshot(case_id: str, **changes: Any) -> str:
    """Опубликованный снимок без тяжёлого каталога: пустое досье, один вопрос."""

    snapshot_id = str(uuid.uuid4())
    snapshot = ConsiliumSnapshot.model_validate({
        "id": snapshot_id, "case_id": case_id, "case_version": 1,
        "created_at": datetime.utcnow(), "question": "Что чувствовал доброволец?",
        "title": "Дело", "subject_codes": ["V-1"], "recording_ids": [],
        "evidence": [], "context": [], "sha256": "a" * 64,
        **changes,
    })

    async def _run() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.ConsiliumSnapshotRecord(
                id=snapshot_id, case_id=case_id,
                payload=snapshot.model_dump(mode="json"),
                created_at=datetime.utcnow(),
            ))
            await session.commit()

    asyncio.run(_run())
    return snapshot_id


def wait_round(client: TestClient, case_id: str, round_id: str) -> dict[str, Any]:
    """Ждёт итога раунда: состояние — в строке, не в файле задачи (§8)."""
    url = f"{PREFIX}/{case_id}/rounds/{round_id}"
    deadline = time.time() + 15
    data: dict[str, Any] = {}
    while time.time() < deadline:
        data = client.get(url).json()
        if data.get("status") != "running":
            return data
        time.sleep(0.02)
    raise AssertionError(f"раунд не завершился: {data}")


def role_of(system: str) -> str:
    for role, marker in _MARKERS.items():
        if marker in system:
            return role
    return "unknown"


@pytest.fixture
def fake_llm(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Тестовый провайдер: текст по ролям, отказ выбранных ролей, журнал вызовов."""
    state = SimpleNamespace(
        calls=[],
        fail=set(),
        empty=set(),
    )

    async def fake_chat(
        messages: list[dict[str, str]], *, route: str = "chat",
        max_tokens: int = 1024, client: Any = None,
        on_delta: Any = None,
    ) -> llm_router.ChatResult:
        system = messages[0]["content"] if messages else ""
        role = role_of(system)
        state.calls.append({"role": role, "messages": messages})
        if role in state.fail:
            raise llm_router.LlmRouterError("Сеть недоступна")
        text = "" if role in state.empty else (
            f"## Замечено\nЗаметили ({role}).\n## Возможные объяснения\nВарианты.\n"
            f"## Чего не знаем\nПробел.\n## Вопрос добровольцу\nКак себя чувствовали?\n"
            f"## Следующий шаг\nУточнить условия."
        )
        if on_delta is not None and text:
            # Стриминг (0011): текст приходит кусочками, как у настоящего провайдера
            mid = len(text) // 2
            on_delta(text[:mid])
            on_delta(text[mid:])
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


@pytest.fixture(autouse=True)
def isolated_consilium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своё хранилище, ни миграций рабочей БД, ни изменений данных пользователя."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'rounds.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    yield
    asyncio.run(engine.dispose())


# ---------- раунд ответов ----------


def test_initial_round_persists_all_advisors(client: TestClient, fake_llm: SimpleNamespace) -> None:
    """Три советника получают один снимок; тексты пишутся до успеха задачи."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    started = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    assert started.status_code == 202, started.text
    # Тестовая модель отвечает мгновенно — к ответу 202 раунд может быть готов
    assert started.json()["status"] in ("running", "done")
    if started.json()["status"] == "running":
        assert started.json()["answers"] == []

    data = wait_round(client, case["id"], started.json()["id"])
    assert data["status"] == "done"
    roles = [answer["role"] for answer in data["answers"]]
    assert roles == ["psychological", "neurophysiological", "methodological"]
    assert all(answer["status"] == "ok" for answer in data["answers"])
    assert all(answer["text"] for answer in data["answers"])
    assert all(answer["model"] == "prov/model-x" for answer in data["answers"])
    assert data["instruction_versions"] == {
        "psychological": "1", "neurophysiological": "1", "methodological": "1",
    }
    assert data["limits"]["roles"] == roles
    # Файл задачи не содержит текстов (§8) — только счётчики
    from app.services.job_manager import job_manager

    job = job_manager.get(str(data["job_id"]))
    assert job is not None and job.result is not None
    assert job.result == {"round_id": data["id"], "answers_ok": 3, "answers_failed": 0}


def test_failed_advisor_keeps_others_and_retry_appends(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Отказ одной роли — раунд «неполный»; повтор дописывает новую попытку."""
    fake_llm.fail.add("neurophysiological")
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    started = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    data = wait_round(client, case["id"], started.json()["id"])

    assert data["status"] == "partial"
    by_role = {answer["role"]: answer for answer in data["answers"]}
    assert by_role["psychological"]["status"] == "ok"
    assert by_role["methodological"]["status"] == "ok"
    assert by_role["neurophysiological"]["status"] == "failed"
    assert "Сеть недоступна" in by_role["neurophysiological"]["error"]
    assert by_role["neurophysiological"]["text"] is None

    fake_llm.fail.clear()
    retried = client.post(f"{PREFIX}/{case['id']}/rounds/{data['id']}/retry", json={
        "request_id": request_id(), "expected_version": 2,
        "role": "neurophysiological",
    })
    assert retried.status_code == 202, retried.text
    after = wait_round(client, case["id"], data["id"])

    assert after["status"] == "done"
    # Append-only: прежняя неудачная попытка остаётся в истории
    attempts = [a for a in after["answers"] if a["role"] == "neurophysiological"]
    assert [a["status"] for a in attempts] == ["failed", "ok"]
    assert len(after["answers"]) == 4

    # Успешный ответ не переспрашивается — расход ограничен
    again = client.post(f"{PREFIX}/{case['id']}/rounds/{data['id']}/retry", json={
        "request_id": request_id(), "expected_version": 3,
        "role": "psychological",
    })
    assert again.status_code == 409


# ---------- границы раундов (§6) ----------


def test_one_initial_per_snapshot_and_contract(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Один раунд ответов на снимок; форма замечаний требует исходный раунд."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    first = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    wait_round(client, case["id"], first.json()["id"])

    second = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 2, "snapshot_id": snapshot_id,
    })
    assert second.status_code == 409

    no_source = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 2, "snapshot_id": snapshot_id,
        "kind": "remarks",
    })
    assert no_source.status_code == 422

    summary_in_roles = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 2, "snapshot_id": snapshot_id,
        "roles": ["summary"],
    })
    assert summary_in_roles.status_code == 422


def test_remarks_see_colleagues_but_initial_does_not(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Первые ответы без просмотра коллег; замечания видят ответы (§6)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    first = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    wait_round(client, case["id"], first.json()["id"])
    initial_calls = [call for call in fake_llm.calls if call["role"] != "summary"]
    assert all("Ответы коллег" not in call["messages"][1]["content"] for call in initial_calls)

    remarks = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 2, "snapshot_id": snapshot_id,
        "kind": "remarks", "source_round_id": first.json()["id"],
    })
    assert remarks.status_code == 202, remarks.text
    done = wait_round(client, case["id"], remarks.json()["id"])
    assert done["kind"] == "remarks"
    assert done["status"] == "done"

    remark_messages = [
        call["messages"][1]["content"] for call in fake_llm.calls
        if "раунд замечаний" in call["messages"][1]["content"]
    ]
    assert len(remark_messages) == 3
    assert all("Ответы коллег" in text for text in remark_messages)
    assert all("Заметили (psychological)" in text for text in remark_messages)

    again = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 3, "snapshot_id": snapshot_id,
        "kind": "remarks", "source_round_id": first.json()["id"],
    })
    assert again.status_code == 409


def test_summary_round_and_single_summary_per_snapshot(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Итог — отдельной кнопкой, один на снимок; роль summary пишется в строку."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    first = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    source_id = first.json()["id"]
    wait_round(client, case["id"], source_id)

    summary = client.post(f"{PREFIX}/{case['id']}/rounds/{source_id}/summary", json={
        "request_id": request_id(), "expected_version": 2,
    })
    assert summary.status_code == 202, summary.text
    done = wait_round(client, case["id"], summary.json()["id"])
    assert done["kind"] == "summary"
    assert done["status"] == "done"
    assert [a["role"] for a in done["answers"]] == ["summary"]
    assert done["answers"][0]["text"]

    second = client.post(f"{PREFIX}/{case['id']}/rounds/{source_id}/summary", json={
        "request_id": request_id(), "expected_version": 3,
    })
    assert second.status_code == 409


# ---------- честность и приватность ----------


def test_unconfigured_router_fails_fast_without_fake_answers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без маршрута ИИ — честный 400 и пустая история, не ответы-заглушки."""

    async def no_route() -> llm_router.RouterState:
        return llm_router.RouterState(providers=(), routes={"chat": None, "chat_model": None})

    monkeypatch.setattr(llm_router, "get_state", no_route)
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    started = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    assert started.status_code == 400
    assert "Маршрут ИИ" in started.text

    listing = client.get(f"{PREFIX}/{case['id']}/rounds")
    assert listing.json()["total"] == 0
    assert client.get(f"{PREFIX}/{case['id']}").json()["version"] == 1


def test_digest_hides_unpermitted_context_and_signs_truncation() -> None:
    """Контекст без разрешения не уходит советнику; сокращения подписаны."""
    snapshot = ConsiliumSnapshot.model_validate({
        "id": "s", "case_id": "c", "case_version": 1,
        "created_at": datetime.utcnow(), "question": "Вопрос?",
        "title": "Дело", "subject_codes": ["V-1"], "recording_ids": [],
        "evidence": [{
            "id": "e1", "revision": 1, "source_kind": "job", "source_id": "j1",
            "recording_ids": ["r1"], "payload": {"power": "x" * 5000},
            "completeness": "full", "sha256": "b" * 64, "missing": ["clean_spec"],
        }],
        "context": [
            {
                "id": "ctx1", "case_id": "c", "revision": 1,
                "created_at": datetime.utcnow(), "text": "Секретный рассказ",
                "kind": "volunteer_report", "verified": False,
                "permissions": {"use_with_advisers": False},
            },
            {
                "id": "ctx2", "case_id": "c", "revision": 1,
                "created_at": datetime.utcnow(), "text": "Разрешённое наблюдение",
                "kind": "observation", "verified": False,
                "permissions": {"use_with_advisers": True},
            },
        ],
        "sha256": "a" * 64,
    })

    digest, warnings = rounds.build_digest(snapshot)

    assert "Секретный рассказ" not in digest
    assert "Разрешённое наблюдение" in digest
    assert any("не передан" in warning and "1 из 2" in warning for warning in warnings)
    # Числа материала сокращены — и в самом досье, и в подписи-предупреждении
    assert "числа материала сокращены" in digest
    assert "…" in digest


def test_mark_interrupted_records_restart_state() -> None:
    """Старт приложения: «running» без живой задачи — честное «interrupted» (§8)."""
    plan = rounds_store.RoundPlan(
        kind="initial", roles=("psychological",), snapshot_id="snap-1",
        source_round_id=None, model="prov/model-x",
        instruction_versions={"psychological": "1"}, limits={"roles": ["psychological"]},
    )
    payload = ConsiliumRoundCreate(
        request_id="r1", expected_version=1, snapshot_id="snap-1",
    )

    async def _run() -> tuple[str, str]:
        await db.init_db()
        async with db.AsyncSessionLocal() as session:
            session.add(db.ConsiliumCase(
                id="case-1", title="Дело", question="Вопрос?", direction="other",
                status="open", version=1, subject_codes=["V-1"], recording_ids=[],
                created_at=datetime.utcnow(), updated_at=datetime.utcnow(),
            ))
            session.add(db.ConsiliumSnapshotRecord(
                id="snap-1", case_id="case-1",
                payload={"id": "snap-1", "case_id": "case-1"}, created_at=datetime.utcnow(),
            ))
            await session.commit()
        await rounds_store.create_round("case-1", payload, plan)
        assert await rounds_store.mark_interrupted() == 1
        listing = await rounds_store.list_rounds("case-1", 10, 0)
        after = await rounds_store.get_round("case-1", listing.items[0].id)
        return after.status, after.error or ""

    status, error = asyncio.run(_run())
    assert status == "interrupted"
    assert "перезапуск" in error.lower()


def test_delete_evidence_clears_dependent_rounds(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Удаление материала очищает производные сводки (§10), не исходный расчёт."""
    case = create_case(client)
    snapshot_id = insert_snapshot(
        case["id"],
        evidence=[{
            "id": "ev-1", "revision": 1, "source_kind": "job", "source_id": "j1",
            "recording_ids": [], "payload": {"power": 1.0},
            "completeness": "full", "sha256": "c" * 64,
        }],
    )

    async def _insert_evidence() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.ConsiliumEvidenceRecord(
                id="ev-1", case_id=case["id"],
                payload={"id": "ev-1", "case_id": case["id"], "revision": 1},
                created_at=datetime.utcnow(),
            ))
            await session.commit()

    asyncio.run(_insert_evidence())

    started = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 1, "snapshot_id": snapshot_id,
    })
    wait_round(client, case["id"], started.json()["id"])
    assert client.get(f"{PREFIX}/{case['id']}/rounds").json()["total"] == 1

    preview = client.get(f"{PREFIX}/{case['id']}/evidence/ev-1/deletion-preview").json()
    assert preview["snapshot_ids"] == [snapshot_id]
    assert preview["rounds"] == 1 and preview["answers"] == 3

    deleted = client.delete(
        f"{PREFIX}/{case['id']}/evidence/ev-1?expected_version={preview['version']}",
    )
    assert deleted.status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}/rounds").json()["total"] == 0


def test_archived_case_rejects_new_rounds(
    client: TestClient, fake_llm: SimpleNamespace,
) -> None:
    """Архив read-only: новые раунды не запускаются (правило истории)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    archived = client.patch(f"{PREFIX}/{case['id']}", json={
        "request_id": request_id(), "expected_version": 1,
        "title": case["title"], "question": case["question"],
        "status": "archived", "subject_codes": ["V-1"],
    })
    assert archived.status_code == 200, archived.text

    started = client.post(f"{PREFIX}/{case['id']}/rounds", json={
        "request_id": request_id(), "expected_version": 2, "snapshot_id": snapshot_id,
    })
    assert started.status_code == 409