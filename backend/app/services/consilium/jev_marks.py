"""Разметка Jev (§5.3): advisory-метки решающего классификатора по текстам.

Три применения одного маршрута ``decide`` (``docs/rules/consilium.md`` §5.3):

* ``round_plan`` — какие роли и какая глубина раунда нужны для ответа на вопрос
  дела («быстрый раунд»): подсказка предзаполняет состав ролей и экономит
  LLM-вызовы, запуск раунда остаётся за человеком;
* ``proposal`` — карточка предложения из текста ответа советника: есть ли
  предложение шага, какой из четырёх видов §7, есть ли основание, риски и
  способ проверки;
* ``source_marks`` — на какие из трёх источников (измерения, рассказ
  добровольца, наблюдения исследователя) опираются утверждения текста;
  источники размечаются раздельными вопросами и не смешиваются.

Метки — advisory-подсказки с явным порогом
(``settings.consilium_jev_verdict_min``), не вердикты и не оценки ответов
советников (запрет §0.3): классификатор отвечает только ``noul``/``choice``,
ничего не достраивает и не пишет текст. Правила §5.2 действуют полностью:
запуск — только кнопкой, повтор ``request_id`` возвращает принятую строку и не
шлёт данные снова, ошибка провайдера — строка ``failed`` без достроенных меток,
история append-only, в логи и файл задачи тексты не попадают.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import settings
from app.models import db
from app.schemas.consilium import (
    ConsiliumJevMarkAnswerCreate,
    ConsiliumJevMarkOut,
    ConsiliumJevMarkRoundPlanCreate,
    ConsiliumJevMarksPage,
)
from app.services import llm_router
from app.services.consilium import decide, dossier, rounds, store

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MarkMap:
    """Карта вопросов одного применения разметки: ``noul``-метки и один ``choice``."""

    kind: str
    questions_version: str
    questions: dict[str, dict[str, Any]]
    choice_question: str
    choice_title: str
    choice_keys: frozenset[str]


ROUND_PLAN_MAP = MarkMap(
    kind="round_plan",
    questions_version="1",
    questions={
        "role_psychological": {
            "type": "noul",
            "instructions": (
                "Нужен ли психологический ракурс (рассказ добровольца, переживания, "
                "ненаводящие вопросы) для осмысленного ответа на вопрос исследования?"
            ),
        },
        "role_neurophysiological": {
            "type": "noul",
            "instructions": (
                "Нужен ли нейрофизиологический ракурс (объяснение измеренных изменений "
                "ЭЭГ и их альтернативы) для осмысленного ответа на вопрос исследования?"
            ),
        },
        "role_methodological": {
            "type": "noul",
            "instructions": (
                "Нужен ли методологический ракурс (помехи, сопоставимость прогонов, "
                "границы выводов) для осмысленного ответа на вопрос исследования?"
            ),
        },
        "depth": {
            "type": "choice",
            "instructions": "Какая глубина обсуждения достаточна для ответа на вопрос исследования?",
            "criteria": {
                "initial_only": "достаточно независимых первых ответов советников",
                "with_remarks": "нужны первые ответы и один раунд замечаний коллег",
                "with_summary": "нужны ответы, замечания коллег и итог консилиума",
            },
        },
    },
    choice_question="depth",
    choice_title="глубина обсуждения",
    choice_keys=frozenset({"initial_only", "with_remarks", "with_summary"}),
)

PROPOSAL_MAP = MarkMap(
    kind="proposal",
    questions_version="1",
    questions={
        "has_proposal": {
            "type": "noul",
            "instructions": (
                "Есть ли в тексте предложение конкретного следующего шага исследования?"
            ),
        },
        "step_kind": {
            "type": "choice",
            "instructions": "Какой вид шага предлагает текст?",
            "criteria": {
                "ask_volunteer": "спросить добровольца",
                "clarify_observation": "уточнить условия или наблюдение",
                "run_probe": "провести пробу",
                "run_calculation": "выполнить расчёт",
                "no_proposal": "конкретного предложения шага нет",
            },
        },
        "has_basis": {
            "type": "noul",
            "instructions": "Есть ли у предложения основание — на чём оно основано?",
        },
        "has_risks": {
            "type": "noul",
            "instructions": "Есть ли у предложения риски или ограничения?",
        },
        "has_verification": {
            "type": "noul",
            "instructions": "Есть ли у предложения способ проверки результата?",
        },
    },
    choice_question="step_kind",
    choice_title="вид шага",
    choice_keys=frozenset({
        "ask_volunteer", "clarify_observation", "run_probe", "run_calculation", "no_proposal",
    }),
)

SOURCE_MARKS_MAP = MarkMap(
    kind="source_marks",
    questions_version="1",
    questions={
        "uses_measurements": {
            "type": "noul",
            "instructions": (
                "Опираются ли утверждения текста на измерения и расчётные модели "
                "(сигнал, спектр, диполи, сравнение)?"
            ),
        },
        "uses_volunteer_report": {
            "type": "noul",
            "instructions": (
                "Опираются ли утверждения текста на рассказ добровольца "
                "(его слова о переживании и самочувствии)?"
            ),
        },
        "uses_observations": {
            "type": "noul",
            "instructions": (
                "Опираются ли утверждения текста на наблюдения исследователя "
                "(условия, этапы, поведение)?"
            ),
        },
    },
    choice_question="",
    choice_title="",
    choice_keys=frozenset(),
)

MARK_MAPS: dict[str, MarkMap] = {
    mark_map.kind: mark_map for mark_map in (ROUND_PLAN_MAP, PROPOSAL_MAP, SOURCE_MARKS_MAP)
}

# Роль → подпись для state (из инструкций раундов — единый источник названий).
_ROLE_LABELS = {
    advisor.role: advisor.label for advisor in (*rounds.ADVISORS, rounds.SUMMARY_ADVISOR)
}


def answer_state(question: str, role: str, text: str) -> tuple[str, list[str]]:
    """State разметки ответа: вопрос дела, роль и текст; усечение — с предупреждением."""
    label = _ROLE_LABELS.get(role, role)
    header = f"Вопрос исследования: {question}\n\nОтвет советника ({label}):\n"
    budget = settings.consilium_prompt_max_chars - len(header)
    if budget <= 0:
        budget = 1
    if len(text) > budget:
        warning = (
            f"Текст ответа усечён до {budget} символов — разметка выполнена по усечённому тексту"
        )
        return header + text[:budget], [warning]
    return header + text, []


def _extract(
    mark_map: MarkMap,
    answers: dict[str, Any],
) -> tuple[dict[str, float], list[str], str | None, float | None, list[str]]:
    """Метки из типизированных ответов; пробелы — без метки и с предупреждением.

    ``present`` — только метки, чья калиброванная вероятность достигла порога
    ``settings.consilium_jev_verdict_min``; ключ ``choice`` вне каталога не
    сохраняется решением — предупреждением.
    """
    warnings: list[str] = []
    probs: dict[str, float] = {}
    present: list[str] = []
    threshold = settings.consilium_jev_verdict_min
    for name, spec in mark_map.questions.items():
        if spec["type"] != "noul":
            continue
        prob = decide.in_range(decide.number(answers.get(name), "noul"), 0.0, 1.0)
        if prob is None:
            warnings.append(f"Ответ метки «{name}» не разобран — метка не вынесена")
            continue
        probs[name] = prob
        if prob >= threshold:
            present.append(name)

    choice: str | None = None
    choice_confidence: float | None = None
    if mark_map.choice_question:
        item = answers.get(mark_map.choice_question)
        if isinstance(item, dict):
            key = item.get("choice")
            if key in mark_map.choice_keys:
                choice = str(key)
                choice_confidence = decide.in_range(
                    decide.number(item, "confidence"), 0.0, 1.0,
                )
            else:
                warnings.append(
                    f"Ключ «{mark_map.choice_title}» вне каталога — решение не сохранено",
                )
        else:
            warnings.append(f"Ответ «{mark_map.choice_title}» не разобран")
    return probs, present, choice, choice_confidence, warnings


def _mark_out(row: db.ConsiliumJevMark) -> ConsiliumJevMarkOut:
    """Контракт результата из строки БД (метки — как есть, пробелы — NULL)."""
    return ConsiliumJevMarkOut.model_validate({
        "id": row.id, "case_id": row.case_id, "kind": row.kind,
        "subject_type": row.subject_type, "subject_id": row.subject_id,
        "status": row.status, "model": row.model,
        "questions_version": row.questions_version,
        "probs": row.probs, "present": row.present,
        "choice": row.choice, "choice_confidence": row.choice_confidence,
        "answers": row.answers, "warnings": row.warnings, "error": row.error,
        "latency_ms": row.latency_ms, "created_at": row.created_at,
    })


async def _load_answer(case_id: str, answer_id: str) -> tuple[str, str]:
    """Роль и текст ответа советника; чужой/неполученный ответ — честный отказ."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumAnswer, answer_id)
        if row is None or row.case_id != case_id:
            raise store.ConsiliumError(404, "Ответ советника не найден в этом исследовании")
        if row.status != "ok" or not row.text:
            raise store.ConsiliumError(409, "Ответ советника ещё не получен — размечать нечего")
        return str(row.role), str(row.text)


async def _case_question(case_id: str) -> str:
    """Вопрос дела для контекста разметки (без материалов — только формулировка)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        return str(case.question)


async def _run_mark(
    case_id: str,
    payload: ConsiliumJevMarkRoundPlanCreate | ConsiliumJevMarkAnswerCreate,
    mark_map: MarkMap,
    subject_type: str,
    subject_id: str,
    state_text: str,
    state_warnings: list[str],
) -> ConsiliumJevMarkOut:
    """Один вызов решающего классификатора кнопкой; повтор ключа не шлёт данные снова."""
    model_label = await decide.decide_target()

    # Повтор и архив проверяются до внешней передачи данных (§10, приватность).
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        if case.status != "open":
            raise store.ConsiliumError(409, "Исследование архивировано — сначала откройте его")
        scope = f"{case_id}:jev_mark:{mark_map.kind}"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumJevMarkOut.model_validate(repeat.response)

    answers: dict[str, Any] = {}
    error: str | None = None
    latency_ms: float | None = None
    try:
        result = await llm_router.decide(state_text, mark_map.questions)
        answers = dict(result.answers)
        model_label = f"{result.provider_id}/{result.model}"
        latency_ms = result.latency_ms
    except Exception as exc:  # провайдер, сеть, тайм-аут — честная строка failed
        logger.warning(
            "Разметка %s дела %s: вызов классификатора не удался: %s",
            mark_map.kind, case_id, exc,
        )
        error = str(exc) or type(exc).__name__

    probs, present, choice, choice_confidence, parse_warnings = (
        _extract(mark_map, answers) if answers else ({}, [], None, None, [])
    )
    warnings = list(dict.fromkeys([*state_warnings, *parse_warnings]))

    # Запись результата: квитанция, версия и строка — одной транзакцией.
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumJevMarkOut.model_validate(repeat.response)
        await store._bump(session, case, payload.expected_version)
        row = db.ConsiliumJevMark(
            id=str(uuid.uuid4()), case_id=case_id, kind=mark_map.kind,
            subject_type=subject_type, subject_id=subject_id,
            status="failed" if error else "ok", model=model_label,
            questions_version=mark_map.questions_version,
            probs=probs, present=present, choice=choice,
            choice_confidence=choice_confidence,
            answers=answers, warnings=warnings, error=error,
            latency_ms=latency_ms, created_at=datetime.utcnow(),
        )
        session.add(row)
        await session.flush()
        response = _mark_out(row)
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


async def run_round_plan(
    case_id: str, payload: ConsiliumJevMarkRoundPlanCreate,
) -> ConsiliumJevMarkOut:
    """«Быстрый раунд»: подбор ролей и глубины по снимку досье (advisory)."""
    snapshot = await dossier.get_snapshot(case_id, payload.snapshot_id)
    state_text, digest_warnings = decide.dossier_state(snapshot)
    return await _run_mark(
        case_id, payload, ROUND_PLAN_MAP, "snapshot", payload.snapshot_id,
        state_text, digest_warnings,
    )


async def run_proposal_mark(
    case_id: str, payload: ConsiliumJevMarkAnswerCreate,
) -> ConsiliumJevMarkOut:
    """Карточка предложения из текста ответа советника (advisory, §7)."""
    role, text = await _load_answer(case_id, payload.answer_id)
    question = await _case_question(case_id)
    state_text, state_warnings = answer_state(question, role, text)
    return await _run_mark(
        case_id, payload, PROPOSAL_MAP, "answer", payload.answer_id,
        state_text, state_warnings,
    )


async def run_source_marks(
    case_id: str, payload: ConsiliumJevMarkAnswerCreate,
) -> ConsiliumJevMarkOut:
    """Разметка источников утверждений текста ответа (advisory, три источника)."""
    role, text = await _load_answer(case_id, payload.answer_id)
    question = await _case_question(case_id)
    state_text, state_warnings = answer_state(question, role, text)
    return await _run_mark(
        case_id, payload, SOURCE_MARKS_MAP, "answer", payload.answer_id,
        state_text, state_warnings,
    )


async def get_mark(case_id: str, mark_id: str) -> ConsiliumJevMarkOut:
    """Точная строка разметки; чужой/удалённый результат — 404."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        row = await session.get(db.ConsiliumJevMark, mark_id)
        if row is None or row.case_id != case_id:
            raise store.ConsiliumError(404, "Результат разметки не найден в этом исследовании")
        return _mark_out(row)


async def list_marks(
    case_id: str,
    kind: str | None,
    subject_id: str | None,
    limit: int,
    offset: int,
) -> ConsiliumJevMarksPage:
    """История разметки (новые сверху) с честным total и фильтрами."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        conditions: list[ColumnElement[bool]] = [db.ConsiliumJevMark.case_id == case_id]
        if kind:
            conditions.append(db.ConsiliumJevMark.kind == kind)
        if subject_id:
            conditions.append(db.ConsiliumJevMark.subject_id == subject_id)
        condition = conditions[0] if len(conditions) == 1 else and_(*conditions)
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumJevMark,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumJevMark).where(condition).order_by(
            db.ConsiliumJevMark.created_at.desc(), db.ConsiliumJevMark.id.desc(),
        ).limit(limit).offset(offset))).all()
        return ConsiliumJevMarksPage(total=total, items=[_mark_out(row) for row in rows])