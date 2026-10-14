"""Триаж готовности досье (Jev): типизированные решения, честность, каскады.

Модель не вызывается: решающий классификатор подменяется тестовым (правило
``docs/rules/tests.md``). Проверяются инварианты §5.2: контекст без разрешения
не уходит наружу, ошибка провайдера — строка ``failed`` без достроенных решений,
повтор ключа не шлёт данные снова, удаление материала/дела очищает строки триажа.
"""

import asyncio
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
from app.schemas.consilium import ConsiliumSnapshot
from app.services import llm_router

PREFIX = "/api/v1/consilium/cases"


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


def run_triage(
    client: TestClient, case_id: str, snapshot_id: str,
    *, expected_version: int = 1, key: str | None = None,
) -> Any:
    """Запуск триажа кнопкой; ключ повтора фиксируется для идемпотентности."""
    return client.post(f"{PREFIX}/{case_id}/triage", json={
        "request_id": key or request_id(),
        "expected_version": expected_version,
        "snapshot_id": snapshot_id,
    })


_DEFAULT_ANSWERS: dict[str, Any] = {
    "sufficient": {"type": "noul", "noul": 0.9},
    "deficit": {
        "type": "choice", "choice": "no_measurements",
        "probabilities": {"no_measurements": 0.8, "no_deficit": 0.2},
        "confidence": 0.75,
    },
    "completeness": {
        "type": "score", "score": 2.5,
        "probabilities": {"2": 0.5, "3": 0.5}, "confidence": 0.6,
    },
}


@pytest.fixture
def fake_decide(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Тестовый решающий классификатор: типизированные решения, журнал вызовов."""
    state = SimpleNamespace(calls=[], fail=False, answers=dict(_DEFAULT_ANSWERS))

    async def fake_call(
        text: str | dict[str, Any] | list[Any],
        questions: dict[str, dict[str, Any]],
        *,
        client: Any = None,
    ) -> llm_router.DecideResult:
        state.calls.append({"state": text, "questions": questions})
        if state.fail:
            raise llm_router.LlmRouterError("Сеть недоступна")
        return llm_router.DecideResult(
            answers=dict(state.answers), provider_id="prov",
            model="jev-test", latency_ms=12.0,
        )

    async def fake_state() -> llm_router.RouterState:
        provider = llm_router.Provider(
            id="prov", label="Тест Jev", protocol="systemone",
            base_url="https://jev.test/v1/systemone", model="jev-test",
            enabled=True, api_key=None,
        )
        return llm_router.RouterState(
            providers=(provider,),
            routes={"chat": None, "chat_model": None, "transcribe": None, "decide": "prov"},
        )

    monkeypatch.setattr(llm_router, "decide", fake_call)
    monkeypatch.setattr(llm_router, "get_state", fake_state)
    return state


@pytest.fixture(autouse=True)
def isolated_consilium(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Своё хранилище, ни миграций рабочей БД, ни изменений данных пользователя."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'triage.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    yield
    asyncio.run(engine.dispose())


# ---------- запуск и идемпотентность ----------


def test_triage_success_and_repeat_does_not_call_again(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Один вызов — типизированные решения в строке; повтор ключа не шлёт данные снова."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    key = request_id()

    started = run_triage(client, case["id"], snapshot_id, key=key)
    assert started.status_code == 201, started.text
    data = started.json()
    assert data["status"] == "ok"
    assert data["sufficient"] is True
    assert data["sufficient_prob"] == 0.9
    assert data["deficit"] == "no_measurements"
    assert data["deficit_confidence"] == 0.75
    assert data["completeness_score"] == 2.5
    assert data["answers"]["sufficient"]["noul"] == 0.9
    assert data["model"] == "prov/jev-test"
    assert data["questions_version"] == "1"
    assert data["latency_ms"] == 12.0
    assert len(fake_decide.calls) == 1
    assert set(fake_decide.calls[0]["questions"]) == {"sufficient", "deficit", "completeness"}

    repeat = run_triage(client, case["id"], snapshot_id, key=key)
    assert repeat.status_code == 201, repeat.text
    assert repeat.json()["id"] == data["id"]
    assert len(fake_decide.calls) == 1  # повтор не шлёт материалы наружу снова

    other_snapshot = insert_snapshot(case["id"])
    conflict = run_triage(client, case["id"], other_snapshot, expected_version=2, key=key)
    assert conflict.status_code == 409
    assert len(fake_decide.calls) == 1  # конфликт ключа не шлёт данные повторно

    listing = client.get(f"{PREFIX}/{case['id']}/triage")
    assert listing.json()["total"] == 1
    fetched = client.get(f"{PREFIX}/{case['id']}/triage/{data['id']}")
    assert fetched.json()["id"] == data["id"]


def test_triage_state_hides_unpermitted_context(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Контекст без разрешения «использовать советниками» не уходит наружу (§5.2)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"], context=[
        {
            "id": "ctx1", "case_id": case["id"], "revision": 1,
            "created_at": datetime.utcnow(), "text": "Секретный рассказ",
            "kind": "volunteer_report", "verified": False,
            "permissions": {"use_with_advisers": False},
        },
        {
            "id": "ctx2", "case_id": case["id"], "revision": 1,
            "created_at": datetime.utcnow(), "text": "Разрешённое наблюдение",
            "kind": "observation", "verified": False,
            "permissions": {"use_with_advisers": True},
        },
    ])

    started = run_triage(client, case["id"], snapshot_id)
    assert started.status_code == 201, started.text
    state = fake_decide.calls[0]["state"]
    assert "Секретный рассказ" not in state
    assert "Разрешённое наблюдение" in state
    assert "Вопрос исследования" in state
    assert any("не передан" in warning for warning in started.json()["warnings"])


# ---------- честность отказов ----------


def test_failed_decide_keeps_honest_failed_row(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Ошибка провайдера — строка ``failed`` без достроенных решений (§5.2)."""
    fake_decide.fail = True
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    started = run_triage(client, case["id"], snapshot_id)
    assert started.status_code == 201, started.text
    data = started.json()
    assert data["status"] == "failed"
    assert data["error"] == "Сеть недоступна"
    assert data["sufficient"] is None and data["sufficient_prob"] is None
    assert data["deficit"] is None and data["completeness_score"] is None
    assert data["answers"] == {}

    listing = client.get(f"{PREFIX}/{case['id']}/triage")
    assert listing.json()["total"] == 1  # попытка сохранена, но без фиктивных решений


def test_missing_decide_route_is_honest_400(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без маршрута decide — честный 400 до внешнего вызова, история пуста."""

    async def no_route() -> llm_router.RouterState:
        return llm_router.RouterState(providers=(), routes={"chat": None, "transcribe": None})

    monkeypatch.setattr(llm_router, "get_state", no_route)
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    started = run_triage(client, case["id"], snapshot_id)
    assert started.status_code == 400
    assert "решающего классификатора" in started.text
    assert client.get(f"{PREFIX}/{case['id']}/triage").json()["total"] == 0


def test_archived_case_rejects_triage(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Архив read-only: триаж не запускается, материалы наружу не уходят."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    archived = client.patch(f"{PREFIX}/{case['id']}", json={
        "request_id": request_id(), "expected_version": 1,
        "title": case["title"], "question": case["question"],
        "status": "archived", "subject_codes": ["V-1"],
    })
    assert archived.status_code == 200, archived.text

    started = run_triage(client, case["id"], snapshot_id, expected_version=2)
    assert started.status_code == 409
    assert "архивировано" in started.text
    assert fake_decide.calls == []


def test_out_of_catalog_deficit_is_not_saved_but_raw_kept(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Ключ вне каталога и вероятность вне границ не выдаются за решение."""
    fake_decide.answers = {
        "sufficient": {"type": "noul", "noul": 0.3},
        "deficit": {
            "type": "choice", "choice": "что-то новое",
            "probabilities": {"что-то новое": 1.0}, "confidence": 1.2,
        },
        "completeness": {"type": "score", "score": 9.0},
    }
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    data = run_triage(client, case["id"], snapshot_id).json()
    assert data["status"] == "ok"
    assert data["sufficient"] is False  # 0.3 < порога 0.6
    assert data["sufficient_prob"] == 0.3
    assert data["deficit"] is None
    assert data["deficit_confidence"] is None  # 1.2 вне шкалы уверенности
    assert data["completeness_score"] is None  # 9.0 вне шкалы полноты
    warnings = data["warnings"]
    assert any("вне каталога" in item for item in warnings)
    assert any("полнота" in item for item in warnings)
    # Сырые ответы сохраняются как есть — решение не подделано, а помечено
    assert data["answers"]["deficit"]["choice"] == "что-то новое"


# ---------- каскады (§10: производные сводки) ----------


def _insert_evidence_record(case_id: str, evidence_id: str) -> None:
    async def _run() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.ConsiliumEvidenceRecord(
                id=evidence_id, case_id=case_id,
                payload={"id": evidence_id, "case_id": case_id, "revision": 1},
                created_at=datetime.utcnow(),
            ))
            await session.commit()

    asyncio.run(_run())


def test_delete_evidence_clears_dependent_triage(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Удаление материала очищает результаты триажа зависимых снимков (§10)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"], evidence=[{
        "id": "ev-1", "revision": 1, "source_kind": "job", "source_id": "j1",
        "recording_ids": [], "payload": {"power": 1.0},
        "completeness": "full", "sha256": "c" * 64,
    }])
    _insert_evidence_record(case["id"], "ev-1")

    started = run_triage(client, case["id"], snapshot_id)
    assert started.status_code == 201, started.text
    assert client.get(f"{PREFIX}/{case['id']}/triage").json()["total"] == 1

    preview = client.get(f"{PREFIX}/{case['id']}/evidence/ev-1/deletion-preview").json()
    assert preview["snapshot_ids"] == [snapshot_id]
    assert preview["triage"] == 1

    deleted = client.delete(
        f"{PREFIX}/{case['id']}/evidence/ev-1?expected_version={preview['version']}",
    )
    assert deleted.status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}/triage").json()["total"] == 0


def test_case_delete_preview_and_cascade_include_triage(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Предпросмотр удаления показывает строки триажа; удаление очищает их."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    started = run_triage(client, case["id"], snapshot_id)
    assert started.status_code == 201, started.text

    preview = client.get(f"{PREFIX}/{case['id']}/deletion-preview").json()
    assert preview["triage"] == 1
    assert any("триажа" in warning for warning in preview["warnings"])

    deleted = client.delete(f"{PREFIX}/{case['id']}?expected_version={preview['version']}")
    assert deleted.status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}/triage").status_code == 404