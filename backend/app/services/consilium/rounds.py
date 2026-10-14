"""Раунды советников (Т3): промпт из снимка досье и оркестрация вызовов модели.

Принципы (docs/rules/consilium.md §6, §8, §9):

* советники получают **один и тот же снимок досье**; первые ответы
  формируются без просмотра ответов коллег, замечания — один раунд;
* отказ одной роли не уничтожает ответы остальных — раунд помечается
  «неполным», неудавшиеся ответы можно повторить отдельно;
* тексты ответов пишутся в БД **до** объявления успеха задачи
  (``on_success_required``), в файл задачи тексты не попадают;
* контекст передаётся только с разрешением ``use_with_advisers``; сокращение
  досье всегда подписано предупреждением, никогда — молчаливое усечение.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from app.core.config import settings
from app.schemas.consilium import (
    ConsiliumAnswerRetry,
    ConsiliumRoundAction,
    ConsiliumRoundCreate,
    ConsiliumRoundOut,
    ConsiliumSnapshot,
)
from app.services import llm_router
from app.services.consilium import dossier, rounds_store, store, streams
from app.services.job_manager import Job, JobCancelledError
from app.services.job_manager import job_manager as jobs

logger = logging.getLogger(__name__)

# Единый формат ответа: ровно такие заголовки разделов ждёт UI-раскрытие
# «На чём основано? / Другие объяснения / Что спросить у добровольца / Шаг».
ANSWER_FORMAT = (
    "Формат ответа — ровно такие разделы, заголовки не переименовывать:\n"
    "## Замечено\n## Возможные объяснения\n## Чего не знаем\n"
    "## Вопрос добровольцу\n## Следующий шаг"
)

HONESTY = (
    "Правила честности: не выдумывай числа и измерения; отсутствие данных — "
    "пробел, а не «норма»; ссылайся на материалы досье по их названиям; "
    "модельная локализация диполей не является прямым измерением; "
    "не ставь диагнозов, не давай личностных оценок и обещаний лечения; "
    "если данных недостаточно — прямо скажи об этом."
)


@dataclass(frozen=True)
class Advisor:
    """Роль советника: ракурс, версия инструкции и системный промпт."""

    role: str
    label: str
    instruction_version: str
    instruction: str


ADVISORS: tuple[Advisor, ...] = (
    Advisor(
        role="psychological",
        label="Психологический советник",
        instruction_version="1",
        instruction=(
            "Ты — психологический советник исследовательского консилиума по "
            "результатам исследования добровольца (доброволец — не пациент, "
            "приложение не ставит диагнозов). Твой ракурс: рассказ добровольца, "
            "его самоописание, жизненный контекст и ненаводящие вопросы о "
            "переживании. Формулируй вопросы простыми словами, порциями, без "
            "наводящих предположений; отказ или отсутствие ответа — честный "
            "результат. Физиологические и технические детали оставляй коллегам, "
            "но не противоречь им молча. " + HONESTY + "\n\n" + ANSWER_FORMAT
        ),
    ),
    Advisor(
        role="neurophysiological",
        label="Нейрофизиологический советник",
        instruction_version="1",
        instruction=(
            "Ты — нейрофизиологический советник исследовательского консилиума. "
            "Твой ракурс: объяснение измеренных изменений ЭЭГ простым языком и "
            "их возможные альтернативы (артефакты, условия записи, физиология, "
            "эффекты фильтрации). Учитывай: GOF диполей не сравним между "
            "частотными полосами; локализация по модели — не прямое измерение; "
            "состав монтажа и качество сигнала ограничивают выводы. "
            "Психологические интерпретации оставляй коллегам. "
            + HONESTY + "\n\n" + ANSWER_FORMAT
        ),
    ),
    Advisor(
        role="methodological",
        label="Методологический советник",
        instruction_version="1",
        instruction=(
            "Ты — методологический советник исследовательского консилиума "
            "(качество данных и границы выводов). Твой ракурс: помехи и артефакты, "
            "сопоставимость прогонов и сессий, полнота материалов досье, пределы "
            "локализации и чрезмерные выводы. Указывай конкретные проверки, "
            "прежде чем доверять выводу, и честно помечай пробелы данных. "
            "Не подменяй содержательный анализ коллег своей оценкой. "
            + HONESTY + "\n\n" + ANSWER_FORMAT
        ),
    ),
)

SUMMARY_ADVISOR = Advisor(
    role="summary",
    label="Итог консилиума",
    instruction_version="1",
    instruction=(
        "Ты составляешь итог исследовательского консилиума по ответам советников. "
        "Сохрани разногласия: покажи, с чем все согласны, где позиции разошлись, "
        "чего не известно. Не сглаживай расхождения, не добавляй фактов, которых "
        "нет в ответах и досье, не выноси суждений о добровольце сверх сказанного. "
        + HONESTY + "\n\n" + ANSWER_FORMAT
        + "\n\nВ разделе «Возможные объяснения» явно укажи: «Согласие: …» и "
        "«Разногласия: …»."
    ),
)

ADVISOR_BY_ROLE: dict[str, Advisor] = {
    **{advisor.role: advisor for advisor in ADVISORS},
    "summary": SUMMARY_ADVISOR,
}

DEFAULT_ROLES: tuple[str, ...] = tuple(advisor.role for advisor in ADVISORS)


def _clip(text: str, limit: int) -> str:
    """Обрезка с многоточием: всегда видно, что текст сокращён."""
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def build_digest(snapshot: ConsiliumSnapshot) -> tuple[str, list[str]]:
    """Сжатое досье для промпта; каждое сокращение подписано предупреждением."""
    budget = settings.consilium_prompt_max_chars
    warnings: list[str] = []
    blocks: list[tuple[str, str]] = [
        (snapshot.question, f"Вопрос исследования: {snapshot.question}"),
        (snapshot.title, f"Дело: {snapshot.title or 'без названия'}"),
        (
            ", ".join(snapshot.subject_codes),
            f"Добровольцы: {', '.join(snapshot.subject_codes) or 'коды не указаны'}",
        ),
    ]
    hidden = 0
    for context in snapshot.context:
        if not context.permissions.use_with_advisers:
            hidden += 1
            continue
        blocks.append((
            context.text,
            f"Контекст ({context.kind}, автор: {context.author}): {_clip(context.text, 2000)}",
        ))
    if hidden:
        warnings.append(
            f"Контекст без разрешения «использовать советниками» не передан: "
            f"{hidden} из {len(snapshot.context)} записей",
        )
    for evidence in snapshot.evidence:
        title = evidence.title or evidence.source_id
        notes = []
        if evidence.warnings:
            notes.append("предупреждения: " + "; ".join(evidence.warnings))
        if evidence.missing:
            notes.append("пробелы: " + "; ".join(evidence.missing))
        payload_text = json.dumps(evidence.payload, ensure_ascii=False, sort_keys=True)
        clipped = _clip(payload_text, 1200)
        if clipped != payload_text:
            notes.append("числа материала сокращены")
        blocks.append((
            title,
            f"Материал «{title}» ({evidence.source_kind}:{evidence.source_id}), "
            f"полнота: {evidence.completeness}, версия {evidence.revision}\n"
            + ("\n".join(notes) + "\n" if notes else "")
            + f"Числа: {clipped}",
        ))
    # Бюджет промпта: блоки входят целиком; невместившееся — честный список
    kept: list[str] = []
    total = 0
    for index, (_title, block) in enumerate(blocks):
        if kept and total + len(block) > budget:
            dropped = [_clip(name or "блок без названия", 80) for name, _ in blocks[index:]]
            warnings.append(
                f"Бюджет промпта исчерпан: в запрос советника не вошли блоки досье "
                f"({len(dropped)}): " + "; ".join(dropped),
            )
            break
        kept.append(block)
        total += len(block)
    return "\n\n".join(kept), warnings


_STAGES = {"initial": "advisers", "remarks": "remarks", "summary": "summary"}
_START_MESSAGES = {
    "initial": "Ответы советников",
    "remarks": "Замечания советников",
    "summary": "Итог консилиума",
}

_TASKS = {
    "initial": "Дай свой ответ по досье, не зная ответов коллег.",
    "remarks": (
        "Ниже — ответы коллег (они не видели твой ответ). Дай один ограниченный "
        "раунд замечаний: с чем согласен, что уточняешь, какие расхождения "
        "сохраняешь. Не повторяй коллег целиком."
    ),
    "summary": "Ниже — ответы советников. Составь итог с сохранением разногласий.",
}


def build_messages(
    advisor: Advisor,
    question: str,
    digest: str,
    kind: str,
    colleagues: list[tuple[str, str]],
) -> list[dict[str, str]]:
    """Сообщения одного вызова: снимок досье и, по ходу, ответы коллег."""
    parts = [f"Вопрос исследования: {question}\n\nДосье:\n{digest}"]
    if colleagues:
        blocks = "\n\n".join(f"### {label}\n{text}" for label, text in colleagues)
        parts.append("Ответы коллег:\n\n" + blocks)
    parts.append(_TASKS[kind])
    return [
        {"role": "system", "content": advisor.instruction},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


async def _ask(
    advisor: Advisor,
    messages: list[dict[str, str]],
    model_label: str | None,
    max_tokens: int,
    warnings: list[str],
    hub: streams.RoundProgress | None = None,
) -> rounds_store.AnswerOutcome:
    """Один вызов советника: отказ роли — её статус, не крушение раунда.

    ``hub`` — стриминг (срез 0011): события роли уходят подписчикам SSE по мере
    генерации; текст в БД пишется только итоговый, дельты остаются в RAM.
    """
    started = time.perf_counter()
    if hub is not None:
        hub.role_started(advisor.role)

    def on_delta(chunk: str) -> None:
        if hub is not None:
            hub.append_delta(advisor.role, chunk)

    try:
        result = await llm_router.chat(
            messages, max_tokens=max_tokens, on_delta=on_delta,
        )
    except Exception as exc:  # провайдер, сеть, тайм-аут — честная ошибка роли
        logger.warning("Советник %s: вызов модели не удался: %s", advisor.role, exc)
        error = str(exc) or type(exc).__name__
        if hub is not None:
            hub.role_finished(advisor.role, status="failed", error=error)
        return rounds_store.AnswerOutcome(
            role=advisor.role, status="failed", error=error,
            instruction_version=advisor.instruction_version, model=model_label,
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
        )
    text = (result.text or "").strip()
    if not text:
        if hub is not None:
            hub.role_finished(
                advisor.role, status="failed",
                error="Модель вернула пустой ответ",
                model=f"{result.provider_id}/{result.model}",
            )
        return rounds_store.AnswerOutcome(
            role=advisor.role, status="failed", error="Модель вернула пустой ответ",
            instruction_version=advisor.instruction_version,
            model=f"{result.provider_id}/{result.model}", latency_ms=result.latency_ms,
        )
    if result.truncated:
        warnings.append(f"Ответ «{advisor.label}» усечён лимитом токенов")
    if hub is not None:
        hub.role_finished(
            advisor.role, status="done", model=f"{result.provider_id}/{result.model}",
        )
    return rounds_store.AnswerOutcome(
        role=advisor.role, status="ok", text=result.text,
        model=f"{result.provider_id}/{result.model}",
        instruction_version=advisor.instruction_version, latency_ms=result.latency_ms,
    )


def _latest_ok(answers: list) -> list[tuple[str, str]]:
    """Последние успешные ответы по ролям (история append-only)."""
    by_role: dict[str, tuple[str, str]] = {}
    for answer in answers:
        if answer.status == "ok" and answer.text:
            label = ADVISOR_BY_ROLE.get(str(answer.role))
            by_role[str(answer.role)] = (
                label.label if label else str(answer.role), str(answer.text),
            )
    return list(by_role.values())


async def _colleagues_for(round: ConsiliumRoundOut) -> list[tuple[str, str]]:
    """Ответы коллег для замечаний/итога; раунд ответов их не видит."""
    if round.kind == "initial" or not round.source_round_id:
        return []
    source = await rounds_store.get_round(str(round.case_id), str(round.source_round_id))
    return _latest_ok(source.answers)


async def chat_target() -> str:
    """Маршрут chat роутера: подпись раунда; без маршрута — честный 400."""
    state = await llm_router.get_state()
    provider_id = state.routes.get("chat")
    if not provider_id:
        raise store.ConsiliumError(
            400, "Маршрут ИИ не назначен — настройте модельный роутер в разделе «Настройки»",
        )
    provider = next((item for item in state.providers if item.id == provider_id), None)
    if provider is None:
        raise store.ConsiliumError(400, "Провайдер маршрута ИИ не найден — проверьте модельный роутер")
    if not provider.enabled:
        raise store.ConsiliumError(400, "Провайдер маршрута ИИ выключен — включите его в настройках")
    chosen = state.routes.get("chat_model")
    return f"{provider.id}/{chosen or provider.model}"


def _submit(
    round: ConsiliumRoundOut,
    *,
    roles: tuple[str, ...],
    question: str,
    digest: str,
    digest_warnings: list[str],
    colleagues: list[tuple[str, str]],
) -> Job:
    """Запускает задачу раунда: запись результатов — до объявления успеха."""
    collected: list[rounds_store.AnswerOutcome] = []
    warnings: list[str] = list(digest_warnings)
    kind = str(round.kind)
    stage = _STAGES[kind]
    max_tokens = settings.consilium_answer_max_tokens
    # Стриминг (0011): журнал событий раунда живёт в RAM, пока идёт запуск
    hub = streams.open_round(str(round.id), roles)

    async def worker(progress: Any) -> dict[str, Any]:
        advisors = [ADVISOR_BY_ROLE[role] for role in roles]
        total = len(advisors)
        progress(stage, 0.0, _START_MESSAGES[kind])
        tasks = {
            asyncio.create_task(_ask(
                advisor,
                build_messages(advisor, question, digest, kind, colleagues),
                round.model, max_tokens, warnings, hub,
            )): advisor
            for advisor in advisors
        }
        try:
            pending = set(tasks)
            finished = 0
            while pending:
                done, pending = await asyncio.wait(
                    pending, return_when=asyncio.FIRST_COMPLETED,
                )
                for task in done:
                    collected.append(task.result())
                    finished += 1
                progress(stage, 0.9 * finished / total, f"Получено ответов: {finished} из {total}")
        except JobCancelledError:
            for task in tasks:
                task.cancel()
            await rounds_store.mark_aborted(round.id, "cancelled", "Отменено пользователем")
            streams.close_round(str(round.id), "Отменено пользователем")
            raise
        except Exception as exc:
            for task in tasks:
                task.cancel()
            await rounds_store.mark_aborted(round.id, "failed", str(exc))
            streams.close_round(str(round.id), str(exc))
            raise
        progress(stage, 1.0, "Ответы получены")
        # В файл задачи не попадают тексты — только счётчики (§8)
        return {
            "round_id": round.id,
            "answers_ok": sum(1 for item in collected if item.status == "ok"),
            "answers_failed": sum(1 for item in collected if item.status == "failed"),
        }

    async def on_success(job: Any, result: Any) -> None:
        try:
            await rounds_store.save_outcomes(round.id, collected, warnings)
        except Exception as exc:
            # Обязательная запись не удалась: строка раунда не должна «висеть»
            await rounds_store.mark_aborted(round.id, "failed", str(exc))
            streams.close_round(str(round.id), str(exc))
            raise
        # Ответы в БД — подписчики стрима получают round_done и дочитывают их поллингом
        streams.close_round(str(round.id))

    job = jobs.submit(
        "consilium_round", None, worker,
        resource="llm", on_success=on_success, on_success_required=True,
        start_stage=stage, start_message=_START_MESSAGES[kind],
        meta={"case_id": str(round.case_id), "round_id": round.id},
    )
    return job


def _limits(roles: tuple[str, ...]) -> dict[str, Any]:
    """Границы раунда (§6): роли, расход и время — фиксируются в строке."""
    return {
        "roles": list(roles),
        "max_tokens": settings.consilium_answer_max_tokens,
        "timeout_s": settings.llm_request_timeout_s,
    }


async def start_round(case_id: str, payload: ConsiliumRoundCreate) -> ConsiliumRoundOut:
    """Запускает раунд советников (ответы или замечания) по снимку досье."""
    model_label = await chat_target()
    snapshot = await dossier.get_snapshot(case_id, payload.snapshot_id)
    digest, digest_warnings = build_digest(snapshot)
    roles = tuple(payload.roles) or DEFAULT_ROLES
    plan = rounds_store.RoundPlan(
        kind=payload.kind, roles=roles, snapshot_id=payload.snapshot_id,
        source_round_id=payload.source_round_id, model=model_label,
        instruction_versions={
            role: ADVISOR_BY_ROLE[role].instruction_version for role in roles
        },
        limits=_limits(roles),
    )
    round, created = await rounds_store.create_round(case_id, payload, plan)
    if created:
        job = _submit(
            round, roles=roles, question=snapshot.question, digest=digest,
            digest_warnings=digest_warnings, colleagues=await _colleagues_for(round),
        )
        await rounds_store.attach_job(round.id, job.job_id)
    return await rounds_store.get_round(case_id, round.id)


async def run_summary(
    case_id: str, round_id: str, payload: ConsiliumRoundAction,
) -> ConsiliumRoundOut:
    """Составляет итог по завершённому раунду, сохраняя разногласия (§6)."""
    model_label = await chat_target()
    source = await rounds_store.get_round(case_id, round_id)
    snapshot = await dossier.get_snapshot(case_id, source.snapshot_id)
    digest, digest_warnings = build_digest(snapshot)
    plan = rounds_store.RoundPlan(
        kind="summary", roles=("summary",), snapshot_id=source.snapshot_id,
        source_round_id=round_id, model=model_label,
        instruction_versions={"summary": SUMMARY_ADVISOR.instruction_version},
        limits=_limits(("summary",)),
    )
    round, created = await rounds_store.create_round(case_id, payload, plan)
    if created:
        job = _submit(
            round, roles=("summary",), question=snapshot.question, digest=digest,
            digest_warnings=digest_warnings, colleagues=await _colleagues_for(round),
        )
        await rounds_store.attach_job(round.id, job.job_id)
    return await rounds_store.get_round(case_id, round.id)


async def retry_role(
    case_id: str, round_id: str, payload: ConsiliumAnswerRetry,
) -> ConsiliumRoundOut:
    """Повтор одного неудавшегося ответа: новая попытка, история остаётся."""
    await chat_target()  # без маршрута повтор не запускается — честный отказ
    round, created = await rounds_store.retry_answer(case_id, round_id, payload)
    if created:
        snapshot = await dossier.get_snapshot(case_id, round.snapshot_id)
        digest, digest_warnings = build_digest(snapshot)
        job = _submit(
            round, roles=(str(payload.role),), question=snapshot.question,
            digest=digest, digest_warnings=digest_warnings,
            colleagues=await _colleagues_for(round),
        )
        await rounds_store.attach_job(round.id, job.job_id)
    return await rounds_store.get_round(case_id, round.id)