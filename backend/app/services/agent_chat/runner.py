"""Ответы ролевых агентов: промпт из переписки нити и задачи очереди ``llm``.

Каждый адресат отвечает отдельной задачей, видит всю нить (реплики коллег
подписаны ролями), стримится через RAM-хаб ``consilium.streams`` (ключ — id
реплики). Отказ одного агента не ломает остальных; тексты пишутся в БД до
объявления успеха задачи.
"""

import logging
from typing import Any

from app.core.config import settings
from app.schemas.agent_chat import (
    AgentMessageCreate,
    AgentMessageOut,
    AgentRoleOut,
    AgentSendOut,
)
from app.services import llm_router
from app.services.agent_chat import roles, store
from app.services.agent_chat.roles import AgentChatError
from app.services.consilium import streams
from app.services.job_manager import Job, JobCancelledError
from app.services.job_manager import job_manager as jobs

logger = logging.getLogger(__name__)


def build_messages(
    role: AgentRoleOut,
    history: list[AgentMessageOut],
    labels: dict[str, str],
) -> tuple[list[dict[str, str]], list[str]]:
    """Сообщения вызова: инструкция роли и переписка; не влезшее — предупреждением."""
    blocks = []
    for item in history:
        who = "Исследователь" if item.author == "researcher" else labels.get(
            item.role_id or "", item.role_id or "Агент",
        )
        blocks.append(f"### {who}\n{item.text or ''}".strip())
    kept: list[str] = []
    total = 0
    for block in reversed(blocks):
        if kept and total + len(block) > settings.agent_chat_prompt_max_chars:
            break
        kept.append(block)
        total += len(block)
    kept.reverse()
    warnings: list[str] = []
    if len(kept) < len(blocks):
        warnings.append(
            f"Бюджет промпта исчерпан: в запрос не вошли ранние реплики ({len(blocks) - len(kept)})",
        )
    transcript = "\n\n".join(kept)
    task = (
        f"Ты — «{role.label}». Ответь на последнее сообщение исследователя от своей "
        "роли; если оно адресовано другим ролям и не касается тебя — всё равно "
        "дополни по существу, но коротко."
    )
    return [
        {"role": "system", "content": f"{role.instruction}\n\n{roles.BASE_INSTRUCTION}"},
        {"role": "user", "content": f"Переписка:\n{transcript}\n\n{task}"},
    ], warnings


def _submit(
    reply: AgentMessageOut,
    role: AgentRoleOut,
    messages: list[dict[str, str]],
    base_warnings: list[str],
) -> Job:
    """Задача ответа одного агента: запись текста — до объявления успеха."""
    reply_id = reply.id
    voice = role.id
    collected: dict[str, Any] = {}
    hub = streams.open_round(reply_id, (voice,))

    async def worker(progress: Any) -> dict[str, Any]:
        progress(voice, 0.0, f"{role.label}: запрос к модели")
        try:
            hub.role_started(voice)
            result = await llm_router.chat(
                messages,
                max_tokens=settings.agent_chat_answer_max_tokens,
                on_delta=lambda delta: hub.append_delta(voice, delta),
                provider_id=role.provider_id,
                model=role.model,
            )
        except JobCancelledError:
            await store.mark_failed(reply_id, "Отменено пользователем")
            streams.close_round(reply_id, "Отменено пользователем")
            raise
        except Exception as exc:
            error = str(exc) or type(exc).__name__
            logger.warning("Агент %s: вызов модели не удался: %s", voice, exc)
            hub.role_finished(voice, status="failed", error=error)
            collected.update({"status": "failed", "error": error})
            return {"message_id": reply_id, "ok": False}
        model_label = f"{result.provider_id}/{result.model}"
        text = (result.text or "").strip()
        if not text:
            error = "Модель вернула пустой ответ"
            hub.role_finished(voice, status="failed", error=error, model=model_label)
            collected.update({"status": "failed", "error": error, "model": model_label})
            return {"message_id": reply_id, "ok": False}
        warnings = list(base_warnings)
        if result.truncated:
            warnings.append("Ответ усечён лимитом токенов")
        hub.role_finished(voice, status="done", model=model_label)
        collected.update({
            "status": "ok", "text": text, "model": model_label,
            "latency_ms": result.latency_ms, "warnings": warnings,
        })
        progress(voice, 1.0, f"{role.label}: ответ получен")
        return {"message_id": reply_id, "ok": True}

    async def on_success(job: Any, result: Any) -> None:
        try:
            if collected.get("status") == "ok":
                await store.save_reply(
                    reply_id, text=str(collected["text"]), model=collected.get("model"),
                    warnings=list(collected.get("warnings", [])),
                    latency_ms=collected.get("latency_ms"),
                )
            else:
                await store.mark_failed(
                    reply_id, str(collected.get("error", "Модель не ответила")),
                    collected.get("model"),
                )
        except Exception as exc:
            await store.mark_failed(reply_id, str(exc))
            streams.close_round(reply_id, str(exc))
            raise
        streams.close_round(reply_id)

    return jobs.submit(
        "agent_chat", None, worker,
        resource="llm", on_success=on_success, on_success_required=True,
        start_stage="agent", start_message=f"{role.label}: запрос к модели",
        meta={"thread_id": reply.thread_id, "message_id": reply_id, "role_id": voice},
    )


async def _launch(thread_id: str, replies: list[AgentMessageOut]) -> None:
    """Запускает задачи ответов по ожидающим строкам (после записи реплик)."""
    all_roles = (await roles.list_roles()).items
    by_id = {role.id: role for role in all_roles}
    labels = {role.id: role.label for role in all_roles}
    for reply in replies:
        role = by_id.get(reply.role_id or "")
        if role is None:
            await store.mark_failed(reply.id, "Роль удалена")
            continue
        history = await store.history_before(thread_id, reply.id)
        messages, warnings = build_messages(role, history, labels)
        job = _submit(reply, role, messages, warnings)
        await store.attach_job(reply.id, job.job_id)


async def send_message(thread_id: str, payload: AgentMessageCreate) -> AgentSendOut:
    """Сообщение исследователя: адресаты — ``@упоминания`` и явный список."""
    await store.require_thread(thread_id)
    all_roles = (await roles.list_roles()).items
    enabled = {role.id for role in all_roles if role.enabled}
    wanted = list(dict.fromkeys([
        *payload.role_ids, *roles.find_mentions(payload.text, all_roles),
    ]))
    unknown = [role_id for role_id in wanted if role_id not in {r.id for r in all_roles}]
    if unknown:
        raise AgentChatError(400, f"Неизвестная роль: {unknown[0]}")
    wanted = [role_id for role_id in wanted if role_id in enabled]
    if not wanted:
        raise AgentChatError(
            400, "Укажите, к кому обращаетесь: «@Роль» в тексте или выбор роли",
        )
    question, replies = await store.add_exchange(thread_id, payload.text.strip(), wanted)
    await _launch(thread_id, replies)
    return AgentSendOut(message=question, replies=replies)


async def retry_reply(thread_id: str, message_id: str) -> AgentMessageOut:
    """Повтор неудавшегося ответа агента по той же переписке."""
    reply = await store.restart_reply(thread_id, message_id)
    await _launch(thread_id, [reply])
    return reply
