"""Мозговой штурм (срез 0012): идеи и резюме по снимку досье одним запуском модели.

Смысл — исследовательский штурм до/вокруг раунда советников: модель получает
тот же сжатый дайджест снимка, что советники (``rounds.build_digest``), и
предлагает идеи шагов §7 ``docs/rules/consilium.md`` с основанием и способом
проверки, плюс короткое резюме досье. Принципы:

* запуск — только явной кнопкой в «Материалах и досье»; без маршрута ``chat`` —
  честный 400, фиктивных ответов-заглушек нет;
* стриминг — механизм среза 0011 (``streams``): кусочки текста видны по мере
  генерации, готовый результат приходит поллингом из БД;
* сырой текст ответа сохраняется в ``draft`` всегда: разбор — подсказка, а не
  источник истины; нераспознанная часть честно перечисляется в ``warnings``;
* тексты пишутся в БД до объявления успеха задачи (§8, ``on_success_required``),
  в файл задачи попадают только счётчики.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import settings
from app.models import db
from app.schemas.consilium import (
    ConsiliumBrainstormCreate,
    ConsiliumBrainstormOut,
    ConsiliumBrainstormsPage,
)
from app.services import llm_router
from app.services.consilium import dossier, rounds, rounds_store, store, streams
from app.services.job_manager import Job, JobCancelledError
from app.services.job_manager import job_manager as jobs

logger = logging.getLogger(__name__)

# Версия инструкции штурма: смена правил/формата — новая версия, чтобы идеи
# разных правил не смешивались в одной истории.
BRAINSTORM_INSTRUCTION_VERSION = "1"

# Виды шага §7: ровно такие пометки ждёт формат ответа и парсер.
KIND_LABELS: dict[str, str] = {
    "ask_volunteer": "спросить добровольца",
    "clarify_observation": "уточнить наблюдение",
    "run_probe": "провести пробу",
    "run_calculation": "выполнить расчёт",
}

_ANSWER_FORMAT = (
    "Формат ответа — ровно такие разделы и подзаголовки, заголовки не переименовывать:\n"
    "## Резюме\nКраткое резюме досье: что видно, чего не знаем.\n"
    "## Идеи\n"
    "### 1 · <вид шага> · <название идеи>\n"
    "Основание: на чём идея основана (по материалам досье).\n"
    "Гипотеза: что ожидаем увидеть или узнать.\n"
    "Риски: ограничения и что может пойти не так.\n"
    "Проверка: точное действие и как оценим результат.\n"
    "### 2 · <вид шага> · <название идеи>\n…\n\n"
    "Вид шага — ровно один из четырёх: «спросить добровольца», «уточнить наблюдение», "
    "«провести пробу», «выполнить расчёт». Идей — от 2 до 7, каждая начинается со "
    "строки «###»; поля «Основание», «Гипотеза», «Риски», «Проверка» — каждый с новой "
    "строки с этой пометкой в начале."
)

INSTRUCTION = (
    "Ты ведёшь мозговой штурм исследовательского консилиума по досье добровольца "
    "(доброволец — не пациент, приложение не ставит диагнозов). Предложи идеи шагов: "
    "что спросить у добровольца, что уточнить в наблюдениях, какие пробы и расчёты "
    "провести. Идеи опираются на материалы досье и отвечают на вопрос исследования; "
    "разные идеи — разные шаги, а не повторы одной мысли. Не выдумывай факты и числа, "
    "не ставь диагнозов и не давай личностных оценок; о нехватке данных прямо скажи "
    "в резюме. " + rounds.HONESTY + "\n\n" + _ANSWER_FORMAT
)


@dataclass(frozen=True)
class IdeaDraft:
    """Разобранная идея ответа модели: ровно карточка шага §7."""

    kind: str
    title: str
    rationale: str | None = None
    hypothesis: str | None = None
    risks: str | None = None
    check_method: str | None = None

_FIELD_PREFIXES: tuple[tuple[str, str], ...] = (
    ("основание", "rationale"),
    ("гипотеза", "hypothesis"),
    ("риски", "risks"),
    ("проверка", "check_method"),
)


def _clip(text: str, limit: int) -> str:
    """Обрезка с многоточием: всегда видно, что текст сокращён."""
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def _kind_by_label(label: str) -> str | None:
    """Вид шага по пометке модели; неизвестная пометка — не достраивается."""
    low = label.strip().lower()
    for kind, name in KIND_LABELS.items():
        if low in {name, kind}:
            return kind
    return None


def _sections(text: str) -> dict[str, str]:
    """Разбивает ответ на разделы «## …»; до первого заголовка — не раздел."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.replace("\r\n", "\n").split("\n"):
        stripped = line.strip()
        if stripped.startswith("## "):
            current = stripped[3:].strip().lower()
            sections.setdefault(current, [])
        elif current is not None:
            sections[current].append(line)
    return {name: "\n".join(lines).strip() for name, lines in sections.items()}


def _idea_fields(lines: list[str]) -> dict[str, str | None]:
    """Поля карточки: «Пометка: значение», многострочные значения склеиваются."""
    values: dict[str, str] = {}
    current: str | None = None
    for line in lines:
        stripped = line.strip()
        matched: str | None = None
        for prefix, key in _FIELD_PREFIXES:
            if stripped.lower().startswith(prefix + ":"):
                matched = key
                values[key] = stripped.split(":", 1)[1].strip()
                break
        if matched is not None:
            current = matched
        elif current is not None and stripped:
            values[current] = f"{values[current]}\n{stripped}".strip()
    return {
        "rationale": values.get("rationale"),
        "hypothesis": values.get("hypothesis"),
        "risks": values.get("risks"),
        "check_method": values.get("check_method"),
    }


def _parse_idea(block: str) -> tuple[IdeaDraft | None, str | None]:
    """Одна идея «### № · вид · название» с полями; мимо формата — честный отказ."""
    lines = block.split("\n")
    header = lines[0].strip()
    parts = header.split("·", 2)
    kind = _kind_by_label(parts[1]) if len(parts) > 1 else None
    title = parts[2].strip() if len(parts) > 2 else ""
    if kind is None or not title:
        return None, (
            f"Идея «{_clip(header, 60)}» не разобрана: нужна строка «### № · вид · название» "
            f"с одним из четырёх видов шага — смотрите сырой текст"
        )
    fields = _idea_fields(lines[1:])
    return IdeaDraft(kind=kind, title=title, **fields), None


def parse_draft(text: str) -> tuple[str | None, list[IdeaDraft], list[str]]:
    """Разбирает ответ модели на резюме и идеи; нераспознанное — в предупреждениях.

    Ничего не достраивается за модель: нет раздела — предупреждение и пустое
    поле, а сырой текст ответа остаётся в ``draft`` запуска.
    """
    warnings: list[str] = []
    sections = _sections(text)
    summary = sections.get("резюме") or None
    if summary is None:
        warnings.append("Раздел «Резюме» не распознан — резюме не заполнено, смотрите сырой текст")
    ideas: list[IdeaDraft] = []
    block = sections.get("идеи")
    if block is None:
        warnings.append("Раздел «Идеи» не распознан — карточки идей не созданы")
        return summary, ideas, warnings
    for chunk in block.split("\n### "):
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk.startswith("### "):
            chunk = chunk[4:].strip()
        idea, warning = _parse_idea(chunk)
        if idea is not None:
            ideas.append(idea)
        elif warning is not None:
            warnings.append(warning)
    return summary, ideas, warnings


def _set(row: Any, **fields: Any) -> None:
    """Мутация ORM-строки: setattr с переменными — mypy и ruff без замечаний."""
    for name, value in fields.items():
        setattr(row, name, value)


def _brainstorm_out(
    row: db.ConsiliumBrainstorm, ideas: list[db.ConsiliumBrainstormIdea],
) -> ConsiliumBrainstormOut:
    """Контракт запуска; идеи упорядочены так, как их записала модель."""
    ordered = sorted(ideas, key=lambda item: (item.ordinal, str(item.id)))
    return ConsiliumBrainstormOut.model_validate({
        "id": row.id, "case_id": row.case_id, "snapshot_id": row.snapshot_id,
        "status": row.status, "model": row.model,
        "instruction_version": row.instruction_version,
        "summary": row.summary, "draft": row.draft,
        "ideas": [
            {
                "id": idea.id, "brainstorm_id": idea.brainstorm_id,
                "ordinal": idea.ordinal, "kind": idea.kind, "title": idea.title,
                "hypothesis": idea.hypothesis, "rationale": idea.rationale,
                "risks": idea.risks, "check_method": idea.check_method,
            }
            for idea in ordered
        ],
        "warnings": row.warnings, "error": row.error, "job_id": row.job_id,
        "created_at": row.created_at, "finished_at": row.finished_at,
    })


async def _ideas_of(
    session: Any, brainstorm_ids: list[str],
) -> dict[str, list[db.ConsiliumBrainstormIdea]]:
    """Идеи запусков в порядке ответа модели (append-only)."""
    if not brainstorm_ids:
        return {}
    rows = (await session.scalars(select(db.ConsiliumBrainstormIdea).where(
        db.ConsiliumBrainstormIdea.brainstorm_id.in_(brainstorm_ids),
    ).order_by(db.ConsiliumBrainstormIdea.ordinal, db.ConsiliumBrainstormIdea.id))).all()
    grouped: dict[str, list[db.ConsiliumBrainstormIdea]] = {}
    for row in rows:
        grouped.setdefault(str(row.brainstorm_id), []).append(row)
    return grouped


async def create(
    case_id: str, payload: ConsiliumBrainstormCreate, model_label: str | None,
) -> tuple[ConsiliumBrainstormOut, bool]:
    """Строка запуска и квитанция одной транзакцией; повтор не шлёт данные снова."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        case = await store.require_case(session, case_id)
        scope = f"{case_id}:brainstorm"
        repeat = await store._receipt(session, scope, payload)
        if repeat is not None:
            return ConsiliumBrainstormOut.model_validate(repeat.response), False
        await rounds_store._require_snapshot(session, case_id, payload.snapshot_id)
        await store._bump(session, case, payload.expected_version)
        row = db.ConsiliumBrainstorm(
            id=str(uuid.uuid4()), case_id=case_id, snapshot_id=payload.snapshot_id,
            status="running", model=model_label,
            instruction_version=BRAINSTORM_INSTRUCTION_VERSION,
            summary=None, draft=None, warnings=[], error=None, job_id=None,
            created_at=datetime.utcnow(), finished_at=None,
        )
        session.add(row)
        await session.flush()
        response = _brainstorm_out(row, [])
        store._save_receipt(session, case_id, scope, payload, response)
        await session.commit()
        return response, True


async def save_outcomes(
    brainstorm_id: str,
    *,
    draft: str,
    summary: str | None,
    ideas: list[IdeaDraft],
    warnings: list[str],
) -> ConsiliumBrainstormOut:
    """Обязательная запись результата до объявления успеха (§8)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumBrainstorm, brainstorm_id)
        if row is None:
            raise store.ConsiliumError(404, "Мозговой штурм не найден")
        now = datetime.utcnow()
        for ordinal, idea in enumerate(ideas, start=1):
            session.add(db.ConsiliumBrainstormIdea(
                id=str(uuid.uuid4()), case_id=row.case_id, brainstorm_id=brainstorm_id,
                ordinal=ordinal, kind=idea.kind, title=idea.title,
                hypothesis=idea.hypothesis, rationale=idea.rationale,
                risks=idea.risks, check_method=idea.check_method, created_at=now,
            ))
        _set(
            row,
            status="done", summary=summary, draft=draft, error=None, finished_at=now,
            warnings=list(dict.fromkeys([*row.warnings, *warnings])),
        )
        await session.flush()
        ideas_rows = (await session.scalars(select(db.ConsiliumBrainstormIdea).where(
            db.ConsiliumBrainstormIdea.brainstorm_id == brainstorm_id,
        ))).all()
        response = _brainstorm_out(row, list(ideas_rows))
        await session.commit()
        return response


async def mark_aborted(brainstorm_id: str, status: str, error: str) -> None:
    """Прерванный/отменённый штурм фиксируется в строке, не в файле задачи."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumBrainstorm, brainstorm_id)
        if row is None:
            return
        _set(row, status=status, error=error, finished_at=datetime.utcnow())
        await session.commit()


async def mark_interrupted() -> int:
    """Старт приложения: живых задач нет, «running» — прервано рестартом (§8)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        rows = (await session.scalars(select(db.ConsiliumBrainstorm).where(
            db.ConsiliumBrainstorm.status == "running",
        ))).all()
        for row in rows:
            _set(
                row,
                status="interrupted",
                error="Прервано перезапуском сервера — запустите штурм снова",
                finished_at=datetime.utcnow(),
            )
        await session.commit()
        return len(rows)


async def attach_job(brainstorm_id: str, job_id: str) -> None:
    """Связь запуска с задачей очереди (файл задачи не хранит тексты)."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumBrainstorm, brainstorm_id)
        if row is not None:
            _set(row, job_id=job_id)
            await session.commit()


async def get_brainstorm(case_id: str, brainstorm_id: str) -> ConsiliumBrainstormOut:
    """Точный запуск с идеями; чужой/удалённый — 404."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        row = await session.get(db.ConsiliumBrainstorm, brainstorm_id)
        if row is None or row.case_id != case_id:
            raise store.ConsiliumError(404, "Мозговой штурм не найден в этом исследовании")
        ideas = (await session.scalars(select(db.ConsiliumBrainstormIdea).where(
            db.ConsiliumBrainstormIdea.brainstorm_id == brainstorm_id,
        ))).all()
        return _brainstorm_out(row, list(ideas))


async def list_brainstorms(case_id: str, limit: int, offset: int) -> ConsiliumBrainstormsPage:
    """История запусков (новые сверху) с честным total."""
    await db.init_db()
    async with db.AsyncSessionLocal() as session:
        await store.require_case(session, case_id)
        condition: ColumnElement[bool] = db.ConsiliumBrainstorm.case_id == case_id
        total = int(await session.scalar(select(func.count()).select_from(
            db.ConsiliumBrainstorm,
        ).where(condition)) or 0)
        rows = (await session.scalars(select(db.ConsiliumBrainstorm).where(condition).order_by(
            db.ConsiliumBrainstorm.created_at.desc(), db.ConsiliumBrainstorm.id.desc(),
        ).limit(limit).offset(offset))).all()
        grouped = await _ideas_of(session, [str(row.id) for row in rows])
        return ConsiliumBrainstormsPage(total=total, items=[
            _brainstorm_out(row, grouped.get(str(row.id), [])) for row in rows
        ])


def _submit(
    run_out: ConsiliumBrainstormOut,
    *,
    question: str,
    digest: str,
    digest_warnings: list[str],
) -> Job:
    """Запускает задачу штурма: запись результатов — до объявления успеха."""
    collected: dict[str, Any] = {}
    warnings: list[str] = list(digest_warnings)
    # Стриминг (0011): журнал событий живёт в RAM, ключ — id запуска, голос один
    hub = streams.open_round(str(run_out.id), ("brainstorm",))

    async def worker(progress: Any) -> dict[str, Any]:
        progress("brainstorm", 0.0, "Мозговой штурм: запрос к внешней модели")
        try:
            hub.role_started("brainstorm")
            result = await llm_router.chat(
                [
                    {"role": "system", "content": INSTRUCTION},
                    {
                        "role": "user",
                        "content": f"Вопрос исследования: {question}\n\n{digest}",
                    },
                ],
                max_tokens=settings.consilium_answer_max_tokens,
                on_delta=lambda delta: hub.append_delta("brainstorm", delta),
            )
            summary, ideas, parse_warnings = parse_draft(result.text)
            collected.update({
                "draft": result.text, "summary": summary, "ideas": ideas,
                "warnings": [*warnings, *parse_warnings],
            })
            hub.role_finished("brainstorm", status="done", model=result.model)
            progress("brainstorm", 1.0, f"Мозговой штурм: разобрано идей {len(ideas)}")
        except JobCancelledError:
            await mark_aborted(run_out.id, "cancelled", "Отменено пользователем")
            streams.close_round(str(run_out.id), "Отменено пользователем")
            raise
        except Exception as exc:
            await mark_aborted(run_out.id, "failed", str(exc))
            streams.close_round(str(run_out.id), str(exc))
            raise
        # В файл задачи не попадают тексты — только счётчики (§8)
        return {
            "brainstorm_id": run_out.id, "ideas": len(ideas),
            "has_summary": summary is not None,
        }

    async def on_success(job: Any, result: Any) -> None:
        try:
            await save_outcomes(
                run_out.id,
                draft=str(collected.get("draft", "")),
                summary=collected.get("summary"),
                ideas=list(collected.get("ideas", [])),
                warnings=list(collected.get("warnings", [])),
            )
        except Exception as exc:
            # Обязательная запись не удалась: строка не должна «висеть»
            await mark_aborted(run_out.id, "failed", str(exc))
            streams.close_round(str(run_out.id), str(exc))
            raise
        # Результат в БД — подписчики стрима получают round_done и дочитывают поллингом
        streams.close_round(str(run_out.id))

    return jobs.submit(
        "consilium_brainstorm", None, worker,
        resource="llm", on_success=on_success, on_success_required=True,
        start_stage="brainstorm", start_message="Мозговой штурм: запрос к внешней модели",
        meta={"case_id": str(run_out.case_id), "brainstorm_id": run_out.id},
    )


async def run(case_id: str, payload: ConsiliumBrainstormCreate) -> ConsiliumBrainstormOut:
    """Запускает мозговой штурм по опубликованному снимку досье (кнопкой)."""
    model_label = await rounds.chat_target()
    snapshot = await dossier.get_snapshot(case_id, payload.snapshot_id)
    digest, digest_warnings = rounds.build_digest(snapshot)
    run_out, created = await create(case_id, payload, model_label)
    if created:
        job = _submit(
            run_out, question=snapshot.question, digest=digest,
            digest_warnings=digest_warnings,
        )
        await attach_job(run_out.id, job.job_id)
    return await get_brainstorm(case_id, run_out.id)