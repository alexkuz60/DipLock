"""Триаж готовности досье (Jev): быстрые типизированные решения до раунда советников.

Решающий классификатор (маршрут ``decide`` модельного роутера, протокол
``systemone``) отвечает одним вызовом на карту вопросов: достаточно ли
материалов для осмысленного ответа советников на вопрос дела (``noul``), какой
основной дефицит (``choice``) и насколько полно досье (``score``). Правила —
``docs/rules/consilium.md`` §5.2:

* ``state`` — тот же сжатый дайджест снимка, что советникам: контекст только с
  ``use_with_advisers``, каждое сокращение подписано предупреждением;
* уверенность калибрована, но не гарантирует правильность: вердикт выводится
  явным порогом (``settings.consilium_triage_sufficient_min``), не «верой» модели;
* запуск — только кнопкой; ошибка провайдера — честная строка ``failed`` без
  достроенных решений; история append-only, повтор — новая строка;
* в файл задачи и логи тексты досье не попадают — только счётчики и статусы.
"""

import logging
import uuid
from datetime import datetime
from typing import Any, get_args

from sqlalchemy import func, select
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import settings
from app.models import db
from app.schemas.consilium import (
    ConsiliumSnapshot,
    ConsiliumTriageCreate,
    ConsiliumTriageOut,
    ConsiliumTriagePage,
    TriageDeficit,
)
from app.services import llm_router
from app.services.consilium import decide, dossier, store

logger = logging.getLogger(__name__)

# Версия карты вопросов: смена формулировок/критериев — новая версия, чтобы
# старые и новые решения не смешивались в одной истории.
TRIAGE_QUESTIONS_VERSION = "1"

DEFICIT_KEYS: frozenset[str] = frozenset(get_args(TriageDeficit))
_COMPLETENESS_MAX = 3.0  # шкала полноты: 4 уровня → позиции 0…3

TRIAGE_QUESTIONS: dict[str, dict[str, Any]] = {
    "sufficient": {
        "type": "noul",
        "instructions": (
            "Достаточно ли материалов досье, чтобы советники дали осмысленный ответ "
            "на вопрос исследования? Досье может содержать измерения и расчёты, "
            "рассказ добровольца и наблюдения исследователя; отсутствие источника — "
            "пробел, а не «норма». Если материалов нет, они пусты или не отвечают на "
            "вопрос — ответь «нет»."
        ),
    },
    "deficit": {
        "type": "choice",
        "instructions": "Какой основной дефицит досье мешает ответить на вопрос исследования?",
        "criteria": {
            "no_measurements": "нет измерений и расчётов (спектр, диполи, сравнение и т.п.)",
            "no_volunteer_report": "нет рассказа добровольца о переживании и самочувствии",
            "no_observations": "нет наблюдений исследователя об условиях и ходе пробы",
            "incompatible_parameters": (
                "материалы есть, но несопоставимы, неполны или не отвечают на вопрос"
            ),
            "no_deficit": "заметного дефицита нет — материалы отвечают на вопрос",
        },
    },
    "completeness": {
        "type": "score",
        "instructions": (
            "Насколько полно досье покрывает вопрос исследования: от пустого досье "
            "до полного покрытия вопроса?"
        ),
        "criteria": [
            "пусто: материалов нет или они пустые",
            "фрагмент: есть отдельные крупицы, большая часть вопроса не покрыта",
            "достаточно: материалы в основном отвечают на вопрос",
            "полно: вопрос покрыт всесторонне",
        ],
    },
}


def build_state(snapshot: ConsiliumSnapshot) -> tuple[str, list[str]]:
    """State триажа: вопрос дела и дайджест снимка (общий слой ``decide``)."""
    return decide.dossier_state(snapshot)


def _extract(
    answers: dict[str, Any],
) -> tuple[float | None, str | None, float | None, float | None, list[str]]:
    """Поля строки триажа из типизированных ответов; пробелы — NULL и предупреждение.

    Ответ вне каталога (``deficit``) или вне границ шкалы не сохраняется:
    «zero hallucination» гарантирует только форму ответа, не его содержание.
    """
    warnings: list[str] = []
    sufficient_prob = decide.in_range(decide.number(answers.get("sufficient"), "noul"), 0.0, 1.0)
    if sufficient_prob is None:
        warnings.append("Ответ «достаточно ли материалов» не разобран — вердикт не вынесен")

    deficit: str | None = None
    deficit_confidence = decide.in_range(decide.number(answers.get("deficit"), "confidence"), 0.0, 1.0)
    candidate = answers.get("deficit")
    if isinstance(candidate, dict):
        choice = candidate.get("choice")
        if choice in DEFICIT_KEYS:
            deficit = str(choice)
        else:
            warnings.append("Ключ дефицита вне каталога — решение не сохранено")
    else:
        warnings.append("Ответ «основной дефицит» не разобран")

    completeness_score = decide.in_range(
        decide.number(answers.get("completeness"), "score"), 0.0, _COMPLETENESS_MAX,
    )
    if completeness_score is None:
        warnings.append("Ответ «полнота досье» не разобран или вне шкалы")
    return sufficient_prob, deficit, deficit_confidence, completeness_score, warnings


def _triage_out(row: db.ConsiliumTriage) -> ConsiliumTriageOut:
    """Контракт результата из строки БД (решения — как есть, пробелы — NULL)."""
    return ConsiliumTriageOut.model_validate({
        "id": row.id, "case_id": row.case_id, "snapshot_id": row.snapshot_id,
        "status": row.status, "model": row.model,
        "questions_version": row.questions_version,
        "sufficient": row.sufficient, "sufficient_prob": row.sufficient_prob,
        "deficit": row.deficit, "deficit_confidence": row.deficit_confidence,
        "completeness_score": row.completeness_score,
        "answers": row.answers, "warnings": row.warnings, "error": row.error,
        "latency_ms": row.latency_ms, "created_at": row.created_at,
    })


async def run_triage(case_id: str, payload: ConsiliumTriageCreate) -> ConsiliumTriageOut:
    """Триаж досье одним вызовом решающего классификатора (кнопка, без очереди).

    Повтор ключа возвращает ранее принятую строку и **не шлёт данные снова**;
    ошибка провайдера сохраняется строкой ``failed`` (решения не достраиваются).
    """
    model_label = await decide.decide_target()
    snapshot = await dossier.get_snapshot(case_id, payload.snapshot_id)
    state_text, digest_warnings = build_state(snapshot)

    # Повтор и архив проверяются до внешней передачи данных (§10, приватность).
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        if case.status != "open":
            raise store.ConsiliumError(409, "Исследование архивировано — сначала откройте его")
        scope = f"{case_id}:triage"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumTriageOut.model_validate(repeat.response)

    answers: dict[str, Any] = {}
    error: str | None = None
    latency_ms: float | None = None
    try:
        result = await llm_router.decide(state_text, TRIAGE_QUESTIONS)
        answers = dict(result.answers)
        model_label = f"{result.provider_id}/{result.model}"
        latency_ms = result.latency_ms
    except Exception as exc:  # провайдер, сеть, тайм-аут — честная строка failed
        logger.warning("Триаж дела %s: вызов классификатора не удался: %s", case_id, exc)
        error = str(exc) or type(exc).__name__

    sufficient_prob, deficit, deficit_confidence, completeness_score, parse_warnings = (
        _extract(answers) if answers else (None, None, None, None, [])
    )
    warnings = list(dict.fromkeys([*digest_warnings, *parse_warnings]))

    # Запись результата: квитанция, версия и строка — одной транзакцией.
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumTriageOut.model_validate(repeat.response)
        await store._bump(session, case, payload.expected_version)
        row = db.ConsiliumTriage(
            id=str(uuid.uuid4()), case_id=case_id, snapshot_id=payload.snapshot_id,
            status="failed" if error else "ok", model=model_label,
            questions_version=TRIAGE_QUESTIONS_VERSION,
            sufficient=(
                sufficient_prob >= settings.consilium_triage_sufficient_min
                if sufficient_prob is not None else None
            ),
            sufficient_prob=sufficient_prob, deficit=deficit,
            deficit_confidence=deficit_confidence, completeness_score=completeness_score,
            answers=answers, warnings=warnings, error=error,
            latency_ms=latency_ms, created_at=datetime.utcnow(),
        )
        session.add(row)
        await session.flush()
        response = _triage_out(row)
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response


async def get_triage(case_id: str, triage_id: str) -> ConsiliumTriageOut:
    """Точная строка триажа; чужой/удалённый результат — 404."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        row = await session.get(db.ConsiliumTriage, triage_id)
        if row is None or row.case_id != case_id:
            raise store.ConsiliumError(404, "Результат триажа не найден в этом исследовании")
        return _triage_out(row)


async def list_triage(case_id: str, limit: int, offset: int) -> ConsiliumTriagePage:
    """История триажа (новые сверху) с честным total."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        condition: ColumnElement[bool] = db.ConsiliumTriage.case_id == case_id
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumTriage,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumTriage).where(condition).order_by(
            db.ConsiliumTriage.created_at.desc(), db.ConsiliumTriage.id.desc(),
        ).limit(limit).offset(offset))).all()
        return ConsiliumTriagePage(total=total, items=[_triage_out(row) for row in rows])