"""Боковая консультация (срез 0015): переписка исследователя с одним советником.

Смысл — личный чат советника рядом с обсуждением: исследователь пишет напрямую
одной роли, советник отвечает по снимку досье и истории переписки. Принципы:

* отправка — только кнопкой; без маршрута ``chat`` — честный 400, заглушек нет;
* стриминг — механизм среза 0011 (``streams``, ключ — id ответа): растущий текст
  виден сразу, готовый ответ приходит поллингом из БД;
* тексты пишутся в БД до объявления успеха задачи (§8, ``on_success_required``),
  в файл задачи попадают только счётчики; реплики append-only, без правок;
* контекст — сжатый дайджест последнего снимка (``rounds.build_digest``) и
  переписка; каждое сокращение подписано предупреждением, ничего молча не
  усекается.
"""

import logging
from typing import Any

from app.core.config import settings
from app.schemas.consilium import (
    ConsiliumChatMessageCreate,
    ConsiliumChatMessageOut,
    ConsiliumChatMessageRetry,
    ConsiliumChatSendOut,
    ConsiliumSnapshot,
)
from app.services import llm_router
from app.services.consilium import chat_store, dossier, rounds, store, streams
from app.services.job_manager import Job, JobCancelledError
from app.services.job_manager import job_manager as jobs

logger = logging.getLogger(__name__)

# Версия инструкции консультации: смена правил — новая версия, реплики разных
# правил не смешиваются в одной переписке.
CHAT_INSTRUCTION_VERSION = "1"

CHAT_TASK = (
    "Это боковая консультация: исследователь пишет тебе напрямую, коллеги-советники "
    "не участвуют. Отвечай на последнее сообщение исследователя свободным текстом: "
    "без разделов «##», коротко и по существу. Если данных досье не хватает — "
    "прямо скажи об этом."
)


async def _latest_snapshot(case_id: str) -> ConsiliumSnapshot:
    """Последний опубликованный снимок — основание ответа; без него — честный 400."""
    page = await dossier.list_snapshots(case_id, 1, 0)
    if not page.items:
        raise store.ConsiliumError(
            400,
            "Нет опубликованного снимка досье — опубликуйте досье на вкладке «Материалы и досье»",
        )
    return await dossier.get_snapshot(case_id, str(page.items[0].id))


def build_messages(
    advisor: rounds.Advisor,
    question: str,
    digest: str,
    history: list[ConsiliumChatMessageOut],
    reply_id: str,
) -> tuple[list[dict[str, str]], list[str]]:
    """Сообщения вызова: досье и переписка; не влезшее — честным предупреждением.

    В переписку идут реплики исследователя и успешные ответы советника;
    ожидающая/неудавшаяся попытка (``reply_id``) и чужие сбои в промпт не попадают.
    """
    warnings: list[str] = []
    rows = [
        row for row in history
        if row.id != reply_id and (row.author == "researcher" or row.status == "ok")
    ]
    blocks = [
        f"### {'Исследователь' if row.author == 'researcher' else advisor.label}\n"
        f"{row.text or ''}".strip()
        for row in rows
    ]
    budget = settings.consilium_prompt_max_chars
    kept: list[str] = []
    total = 0
    overflow = False
    for block in reversed(blocks):
        if not overflow and kept and total + len(block) > budget:
            overflow = True
        if overflow:
            continue
        kept.append(block)
        total += len(block)
    kept.reverse()
    dropped = len(blocks) - len(kept)
    if dropped:
        warnings.append(
            f"Бюджет промпта исчерпан: в запрос советника не вошли ранние реплики "
            f"переписки ({dropped})"
        )
    history_text = "\n\n".join(kept) if kept else "(переписка начинается с этого сообщения)"
    content = (
        f"Вопрос исследования: {question}\n\nДосье:\n{digest}\n\n"
        f"История консультации:\n{history_text}\n\n{CHAT_TASK}"
    )
    return [
        {"role": "system", "content": rounds.chat_instruction(advisor)},
        {"role": "user", "content": content},
    ], warnings


def _submit(
    reply: ConsiliumChatMessageOut,
    *,
    question: str,
    digest: str,
    digest_warnings: list[str],
    history: list[ConsiliumChatMessageOut],
) -> Job:
    """Задача ответа советника: запись текста — до объявления успеха (§8)."""
    role = str(reply.role)
    advisor = rounds.ADVISOR_BY_ROLE[role]
    reply_id = str(reply.id)
    messages, prompt_warnings = build_messages(
        advisor, question, digest, history, reply_id,
    )
    collected: dict[str, Any] = {}
    base_warnings: list[str] = [*digest_warnings, *prompt_warnings]
    # Стриминг (0011): журнал событий живёт в RAM, ключ — id ответа, голос один
    hub = streams.open_round(reply_id, (role,))

    async def worker(progress: Any) -> dict[str, Any]:
        progress(role, 0.0, "Консультация: запрос к внешней модели")
        try:
            hub.role_started(role)
            result = await llm_router.chat(
                messages,
                max_tokens=settings.consilium_answer_max_tokens,
                on_delta=lambda delta: hub.append_delta(role, delta),
            )
        except JobCancelledError:
            await chat_store.mark_aborted(reply_id, "cancelled", "Отменено пользователем")
            streams.close_round(reply_id, "Отменено пользователем")
            raise
        except Exception as exc:  # провайдер, сеть, тайм-аут — честная ошибка ответа
            error = str(exc) or type(exc).__name__
            logger.warning("Консультация %s: вызов модели не удался: %s", role, exc)
            hub.role_finished(role, status="failed", error=error)
            collected.update({"status": "failed", "error": error, "model": None})
            return {"message_id": reply_id, "ok": False}
        model_label = f"{result.provider_id}/{result.model}"
        text = (result.text or "").strip()
        if not text:
            hub.role_finished(
                role, status="failed", error="Модель вернула пустой ответ",
                model=model_label,
            )
            collected.update({
                "status": "failed", "error": "Модель вернула пустой ответ",
                "model": model_label,
            })
            return {"message_id": reply_id, "ok": False}
        reply_warnings = list(base_warnings)
        if result.truncated:
            reply_warnings.append("Ответ советника усечён лимитом токенов")
        hub.role_finished(role, status="done", model=model_label)
        collected.update({
            "status": "ok", "text": text, "model": model_label,
            "latency_ms": result.latency_ms, "warnings": reply_warnings,
        })
        progress(role, 1.0, "Консультация: ответ получен")
        # В файл задачи не попадают тексты — только счётчики (§8)
        return {"message_id": reply_id, "ok": True}

    async def on_success(job: Any, result: Any) -> None:
        try:
            if collected.get("status") == "ok":
                await chat_store.save_reply(
                    reply_id,
                    text=str(collected.get("text", "")),
                    model=collected.get("model"),
                    warnings=list(collected.get("warnings", [])),
                    latency_ms=collected.get("latency_ms"),
                )
            else:
                await chat_store.mark_aborted(
                    reply_id, "failed",
                    str(collected.get("error", "Модель не ответила")),
                )
        except Exception as exc:
            # Обязательная запись не удалась: строка не должна «висеть»
            await chat_store.mark_aborted(reply_id, "failed", str(exc))
            streams.close_round(reply_id, str(exc))
            raise
        # Результат в БД — подписчики стрима получают round_done и дочитывают поллингом
        streams.close_round(reply_id)

    return jobs.submit(
        "consilium_chat", None, worker,
        resource="llm", on_success=on_success, on_success_required=True,
        start_stage="consultation", start_message="Консультация: запрос к внешней модели",
        meta={
            "case_id": str(reply.case_id), "chat_id": str(reply.chat_id),
            "message_id": reply_id,
        },
    )


async def send_message(case_id: str, payload: ConsiliumChatMessageCreate) -> ConsiliumChatSendOut:
    """Сообщение исследователя: реплика и задача ответа советника (кнопкой)."""
    await rounds.chat_target()  # без маршрута chat — честный 400, заглушек нет
    snapshot = await _latest_snapshot(case_id)
    digest, digest_warnings = rounds.build_digest(snapshot)
    send, created = await chat_store.send_message(
        case_id, payload,
        snapshot_id=str(snapshot.id),
        instruction_version=CHAT_INSTRUCTION_VERSION,
    )
    if created:
        history = await chat_store.load_conversation(case_id, str(send.reply.chat_id))
        job = _submit(
            send.reply, question=snapshot.question, digest=digest,
            digest_warnings=digest_warnings, history=history,
        )
        await chat_store.attach_job(str(send.reply.id), job.job_id)
    return send


async def retry_message(
    case_id: str, message_id: str, payload: ConsiliumChatMessageRetry,
) -> ConsiliumChatMessageOut:
    """Повтор неудавшегося ответа: новая попытка по той же переписке и снимку."""
    await rounds.chat_target()
    snapshot = await _latest_snapshot(case_id)
    digest, digest_warnings = rounds.build_digest(snapshot)
    attempt, created = await chat_store.retry_reply(
        case_id, message_id, payload,
        snapshot_id=str(snapshot.id),
        instruction_version=CHAT_INSTRUCTION_VERSION,
    )
    if created:
        history = await chat_store.load_conversation(case_id, str(attempt.chat_id))
        job = _submit(
            attempt, question=snapshot.question, digest=digest,
            digest_warnings=digest_warnings, history=history,
        )
        await chat_store.attach_job(str(attempt.id), job.job_id)
    return attempt