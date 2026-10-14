"""Разметка Jev (§5.3): advisory-метки, честность, каскады.

Модель не вызывается: решающий классификатор подменяется тестовым (правило
``docs/rules/tests.md``). Проверяются инварианты §5.3: метки — по явному порогу
и не выдаются за вердикты, ключ ``choice`` вне каталога не сохраняется решением,
ошибка провайдера — строка ``failed`` без достроенных меток, повтор ключа не
шлёт данные снова, удаление материала/дела очищает строки разметки.
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


def insert_snapshot_with_context(case_id: str) -> str:
    """Снимок с двумя записями контекста: разрешённой и закрытой для советников."""

    snapshot_id = str(uuid.uuid4())
    snapshot = ConsiliumSnapshot.model_validate({
        "id": snapshot_id, "case_id": case_id, "case_version": 1,
        "created_at": datetime.utcnow(), "question": "Что чувствовал доброволец?",
        "title": "Дело", "subject_codes": ["V-1"], "recording_ids": [],
        "evidence": [], "sha256": "a" * 64,
        "context": [
            {
                "id": "ctx1", "case_id": case_id, "revision": 1,
                "created_at": datetime.utcnow(), "text": "Секретный рассказ",
                "kind": "volunteer_report", "verified": False,
                "permissions": {"use_with_advisers": False},
            },
            {
                "id": "ctx2", "case_id": case_id, "revision": 1,
                "created_at": datetime.utcnow(), "text": "Разрешённое наблюдение",
                "kind": "observation", "verified": False,
                "permissions": {"use_with_advisers": True},
            },
        ],
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


def insert_answer(
    case_id: str,
    snapshot_id: str,
    *,
    text: str | None = "## Замечено\nЗаметили изменение.",
) -> str:
    """Ответ советника без LLM: строка раунда и ответ с текстом (или без)."""

    answer_id = str(uuid.uuid4())
    round_id = str(uuid.uuid4())

    async def _run() -> None:
        async with db.AsyncSessionLocal() as session:
            session.add(db.ConsiliumRound(
                id=round_id, case_id=case_id, kind="initial",
                snapshot_id=snapshot_id, status="done",
                instruction_versions={"psychological": "1"},
                limits={"roles": ["psychological"]},
                warnings=[], created_at=datetime.utcnow(),
            ))
            session.add(db.ConsiliumAnswer(
                id=answer_id, case_id=case_id, round_id=round_id,
                role="psychological", status="ok" if text else "failed",
                text=text, instruction_version="1",
                created_at=datetime.utcnow(),
            ))
            await session.commit()

    asyncio.run(_run())
    return answer_id


_DEFAULT_ANSWERS: dict[str, Any] = {
    "role_psychological": {"type": "noul", "noul": 0.9},
    "role_neurophysiological": {"type": "noul", "noul": 0.2},
    "role_methodological": {"type": "noul", "noul": 0.7},
    "depth": {
        "type": "choice", "choice": "with_remarks",
        "probabilities": {"initial_only": 0.1, "with_remarks": 0.8, "with_summary": 0.1},
        "confidence": 0.8,
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
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'jev_marks.db'}")
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "AsyncSessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    yield
    asyncio.run(engine.dispose())


def run_mark(
    client: TestClient,
    case_id: str,
    path: str,
    payload: dict[str, Any],
    *,
    key: str | None = None,
    version: int = 1,
) -> Any:
    """Запуск разметки кнопкой; ключ повтора фиксируется для идемпотентности."""
    body = {"request_id": key or request_id(), "expected_version": version, **payload}
    return client.post(f"{PREFIX}/{case_id}/jev-marks/{path}", json=body)


# ---------- «быстрый раунд»: состав ролей и глубина ----------


def test_round_plan_marks_by_threshold_and_repeat_is_idempotent(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Метки ролей — по явному порогу; повтор ключа не шлёт данные снова (§5.3)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    key = request_id()

    started = run_mark(
        client, case["id"], "round-plan", {"snapshot_id": snapshot_id}, key=key,
    )
    assert started.status_code == 201, started.text
    data = started.json()
    assert data["status"] == "ok"
    assert data["kind"] == "round_plan"
    assert data["subject_type"] == "snapshot"
    assert data["subject_id"] == snapshot_id
    # Порог 0.5: 0.9 и 0.7 — метки, 0.2 — нет (advisory, не вердикт)
    assert data["present"] == ["role_psychological", "role_methodological"]
    assert data["probs"]["role_neurophysiological"] == 0.2
    assert data["choice"] == "with_remarks"
    assert data["choice_confidence"] == 0.8
    assert data["model"] == "prov/jev-test"
    assert data["questions_version"] == "1"
    assert len(fake_decide.calls) == 1
    assert set(fake_decide.calls[0]["questions"]) == {
        "role_psychological", "role_neurophysiological", "role_methodological", "depth",
    }

    repeat = run_mark(
        client, case["id"], "round-plan", {"snapshot_id": snapshot_id}, key=key,
    )
    assert repeat.status_code == 201, repeat.text
    assert repeat.json()["id"] == data["id"]
    assert len(fake_decide.calls) == 1  # повтор не шлёт материалы наружу снова

    listing = client.get(f"{PREFIX}/{case['id']}/jev-marks?kind=round_plan")
    assert listing.json()["total"] == 1
    fetched = client.get(f"{PREFIX}/{case['id']}/jev-marks/{data['id']}")
    assert fetched.json()["id"] == data["id"]


def test_round_plan_state_hides_unpermitted_context(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Контекст без разрешения «использовать советниками» не уходит наружу (§5.3)."""
    case = create_case(client)
    snapshot_id = insert_snapshot_with_context(case["id"])

    started = run_mark(client, case["id"], "round-plan", {"snapshot_id": snapshot_id})
    assert started.status_code == 201, started.text
    state = fake_decide.calls[0]["state"]
    assert "Секретный рассказ" not in state
    assert "Разрешённое наблюдение" in state


# ---------- карточка предложения и разметка источников ----------


def test_proposal_mark_types_step_and_fields(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Карточка предложения: вид шага §7 и поля по порогу; текст не пишется (§5.3)."""
    fake_decide.answers = {
        "has_proposal": {"type": "noul", "noul": 0.9},
        "step_kind": {
            "type": "choice", "choice": "run_probe",
            "probabilities": {"run_probe": 0.8, "ask_volunteer": 0.2},
            "confidence": 0.8,
        },
        "has_basis": {"type": "noul", "noul": 0.7},
        "has_risks": {"type": "noul", "noul": 0.3},
        "has_verification": {"type": "noul", "noul": 0.6},
    }
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    answer_id = insert_answer(case["id"], snapshot_id)

    started = run_mark(client, case["id"], "proposal", {"answer_id": answer_id})
    assert started.status_code == 201, started.text
    data = started.json()
    assert data["kind"] == "proposal"
    assert data["subject_type"] == "answer"
    assert data["subject_id"] == answer_id
    assert data["choice"] == "run_probe"
    assert data["present"] == [
        "has_proposal", "has_basis", "has_verification",
    ]  # 0.3 рисков ниже порога 0.5
    assert data["probs"]["has_risks"] == 0.3
    # State несёт вопрос, роль и текст ответа — не полное досье
    state = fake_decide.calls[0]["state"]
    assert "Ответ советника (Психологический советник)" in state
    assert "Заметили изменение." in state


def test_source_marks_keep_three_sources_separate(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Три источника — раздельными вопросами: метки не смешиваются (§5.3)."""
    fake_decide.answers = {
        "uses_measurements": {"type": "noul", "noul": 0.8},
        "uses_volunteer_report": {"type": "noul", "noul": 0.4},
        "uses_observations": {"type": "noul", "noul": 0.6},
    }
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    answer_id = insert_answer(case["id"], snapshot_id)

    started = run_mark(client, case["id"], "source-marks", {"answer_id": answer_id})
    assert started.status_code == 201, started.text
    data = started.json()
    assert data["kind"] == "source_marks"
    assert data["present"] == ["uses_measurements", "uses_observations"]
    assert set(data["probs"]) == {
        "uses_measurements", "uses_volunteer_report", "uses_observations",
    }
    assert data["choice"] is None  # у источников нет choice-вопроса
    assert set(fake_decide.calls[0]["questions"]) == {
        "uses_measurements", "uses_volunteer_report", "uses_observations",
    }


def test_unparseable_answer_is_skipped_not_invented(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Ответ вне каталога/шкалы не сохраняется решением — предупреждением (§5.3)."""
    fake_decide.answers = {
        "has_proposal": {"type": "noul", "noul": 0.9},
        "step_kind": {
            "type": "choice", "choice": "что-то новое",
            "probabilities": {"что-то новое": 1.0}, "confidence": 1.4,
        },
        "has_basis": {"type": "noul", "noul": "нет числа"},
        "has_risks": {"type": "noul", "noul": 0.2},
        "has_verification": {"type": "noul", "noul": 0.6},
    }
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    answer_id = insert_answer(case["id"], snapshot_id)

    data = run_mark(client, case["id"], "proposal", {"answer_id": answer_id}).json()
    assert data["status"] == "ok"
    assert data["choice"] is None
    assert data["choice_confidence"] is None  # 1.4 вне шкалы уверенности
    assert "has_basis" not in data["probs"] and "has_basis" not in data["present"]
    assert data["present"] == ["has_proposal", "has_verification"]
    warnings = data["warnings"]
    assert any("вне каталога" in item for item in warnings)
    assert any("has_basis" in item for item in warnings)
    # Сырые ответы остаются как есть — решение не подделано
    assert data["answers"]["step_kind"]["choice"] == "что-то новое"


# ---------- честность отказов ----------


def test_failed_decide_keeps_honest_failed_row(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Ошибка провайдера — строка ``failed`` без достроенных меток (§5.3)."""
    fake_decide.fail = True
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    started = run_mark(client, case["id"], "round-plan", {"snapshot_id": snapshot_id})
    assert started.status_code == 201, started.text
    data = started.json()
    assert data["status"] == "failed"
    assert data["error"] == "Сеть недоступна"
    assert data["probs"] == {} and data["present"] == []
    assert data["choice"] is None and data["choice_confidence"] is None
    assert data["answers"] == {}

    listing = client.get(f"{PREFIX}/{case['id']}/jev-marks")
    assert listing.json()["total"] == 1  # попытка сохранена, но без фиктивных меток


def test_missing_decide_route_is_honest_400(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Без маршрута decide — честный 400 до внешнего вызова, история пуста."""

    async def no_route() -> llm_router.RouterState:
        return llm_router.RouterState(providers=(), routes={"chat": None, "transcribe": None})

    monkeypatch.setattr(llm_router, "get_state", no_route)
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    started = run_mark(client, case["id"], "round-plan", {"snapshot_id": snapshot_id})
    assert started.status_code == 400
    assert "решающего классификатора" in started.text
    assert client.get(f"{PREFIX}/{case['id']}/jev-marks").json()["total"] == 0


def test_archived_case_rejects_marks(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Архив read-only: разметка не запускается, материалы наружу не уходят."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    archived = client.patch(f"{PREFIX}/{case['id']}", json={
        "request_id": request_id(), "expected_version": 1,
        "title": case["title"], "question": case["question"],
        "status": "archived", "subject_codes": ["V-1"],
    })
    assert archived.status_code == 200, archived.text

    started = run_mark(
        client, case["id"], "round-plan",
        {"snapshot_id": snapshot_id}, key=request_id(),
    )
    assert started.status_code == 409
    assert "архивировано" in started.text
    assert fake_decide.calls == []


def test_missing_or_unfinished_answer_is_honest_refusal(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Чужой ответ — 404; ответ без текста — 409; классификатор не вызывается."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])

    missing = run_mark(client, case["id"], "proposal", {"answer_id": "нет-такого"})
    assert missing.status_code == 404
    assert fake_decide.calls == []

    answer_id = insert_answer(case["id"], snapshot_id, text=None)
    unfinished = run_mark(client, case["id"], "proposal", {"answer_id": answer_id})
    assert unfinished.status_code == 409
    assert "не получен" in unfinished.text
    assert fake_decide.calls == []


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


def test_delete_evidence_clears_dependent_marks(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Удаление материала очищает разметку снимков и ответов (§10)."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"], evidence=[{
        "id": "ev-1", "revision": 1, "source_kind": "job", "source_id": "j1",
        "recording_ids": [], "payload": {"power": 1.0},
        "completeness": "full", "sha256": "c" * 64,
    }])
    answer_id = insert_answer(case["id"], snapshot_id)
    _insert_evidence_record(case["id"], "ev-1")

    plan = run_mark(client, case["id"], "round-plan", {"snapshot_id": snapshot_id})
    proposal = run_mark(
        client, case["id"], "proposal", {"answer_id": answer_id}, version=2,
    )
    assert plan.status_code == 201 and proposal.status_code == 201, proposal.text
    assert client.get(f"{PREFIX}/{case['id']}/jev-marks").json()["total"] == 2

    preview = client.get(f"{PREFIX}/{case['id']}/evidence/ev-1/deletion-preview").json()
    assert preview["snapshot_ids"] == [snapshot_id]
    assert preview["jev_marks"] == 2

    deleted = client.delete(
        f"{PREFIX}/{case['id']}/evidence/ev-1?expected_version={preview['version']}",
    )
    assert deleted.status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}/jev-marks").json()["total"] == 0


def test_case_delete_preview_and_cascade_include_marks(
    client: TestClient, fake_decide: SimpleNamespace,
) -> None:
    """Предпросмотр удаления показывает строки разметки; удаление очищает их."""
    case = create_case(client)
    snapshot_id = insert_snapshot(case["id"])
    started = run_mark(client, case["id"], "round-plan", {"snapshot_id": snapshot_id})
    assert started.status_code == 201, started.text

    preview = client.get(f"{PREFIX}/{case['id']}/deletion-preview").json()
    assert preview["jev_marks"] == 1
    assert any("разметки" in warning for warning in preview["warnings"])

    deleted = client.delete(f"{PREFIX}/{case['id']}?expected_version={preview['version']}")
    assert deleted.status_code == 204
    assert client.get(f"{PREFIX}/{case['id']}/jev-marks").status_code == 404