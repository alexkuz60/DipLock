"""HTTP-контракт общего чата консилиума с ролевыми ИИ-агентами."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api.private import PrivateRoute
from app.api.sse import stream_frames
from app.schemas.agent_chat import (
    AgentMessageCreate,
    AgentMessageOut,
    AgentMessagesPage,
    AgentRoleCreate,
    AgentRoleOut,
    AgentRolesPage,
    AgentRoleUpdate,
    AgentSendOut,
    AgentThreadCreate,
    AgentThreadOut,
    AgentThreadsPage,
    AgentWebSearchCreate,
    AgentWebSearchesPage,
    AgentWebSearchOut,
)
from app.schemas.consilium import ConsiliumStreamEvent
from app.services import llm_router
from app.services.agent_chat import roles, runner, store, web_search
from app.services.agent_chat.roles import AgentChatError
from app.services.consilium import streams

router = APIRouter(prefix="/agent-chat", tags=["Консилиум-чат"], route_class=PrivateRoute)


@asynccontextmanager
async def guarded(response: Response) -> AsyncIterator[None]:
    """Приватные ответы и безопасные ошибки чата."""
    response.headers["Cache-Control"] = "private, no-store"
    try:
        yield
    except AgentChatError as exc:
        raise HTTPException(exc.status, str(exc), headers={"Cache-Control": "no-store"}) from None
    except llm_router.LlmRouterError as exc:
        raise HTTPException(exc.status, str(exc), headers={"Cache-Control": "no-store"}) from None
    except SQLAlchemyError:
        raise HTTPException(503, "Не удалось сохранить или прочитать чат", headers={
            "Cache-Control": "no-store",
        }) from None


@router.get("/roles", response_model=AgentRolesPage)
async def list_roles(response: Response) -> AgentRolesPage:
    """Роли агентов (первый вызов создаёт стартовый набор)."""
    async with guarded(response):
        return await roles.list_roles()


@router.post("/roles", status_code=201, response_model=AgentRoleOut)
async def create_role(payload: AgentRoleCreate, response: Response) -> AgentRoleOut:
    """Пользовательская роль."""
    async with guarded(response):
        return await roles.create_role(payload)


@router.put("/roles/{role_id}", response_model=AgentRoleOut)
async def update_role(role_id: str, payload: AgentRoleUpdate, response: Response) -> AgentRoleOut:
    """Правка роли: инструкция, модель, включение."""
    async with guarded(response):
        return await roles.update_role(role_id, payload)


@router.delete("/roles/{role_id}", status_code=204)
async def delete_role(role_id: str, response: Response) -> Response:
    """Удалить пользовательскую роль."""
    async with guarded(response):
        await roles.delete_role(role_id)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/threads", response_model=AgentThreadsPage)
async def list_threads(response: Response) -> AgentThreadsPage:
    """Нити чата, новые сверху."""
    async with guarded(response):
        return await store.list_threads()


@router.post("/threads", status_code=201, response_model=AgentThreadOut)
async def create_thread(payload: AgentThreadCreate, response: Response) -> AgentThreadOut:
    """Новая нить."""
    async with guarded(response):
        return await store.create_thread(payload)


@router.delete("/threads/{thread_id}", status_code=204)
async def delete_thread(thread_id: str, response: Response) -> Response:
    """Удалить нить с репликами."""
    async with guarded(response):
        await store.delete_thread(thread_id)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/threads/{thread_id}/messages", response_model=AgentMessagesPage)
async def list_messages(thread_id: str, response: Response) -> AgentMessagesPage:
    """Переписка нити."""
    async with guarded(response):
        return await store.list_messages(thread_id)


@router.get("/threads/{thread_id}/web-search", response_model=AgentWebSearchesPage)
async def list_web_searches(thread_id: str, response: Response) -> AgentWebSearchesPage:
    """Поиски нити, новые сверху."""
    async with guarded(response):
        return await store.list_web_searches(thread_id)


@router.post(
    "/threads/{thread_id}/web-search", status_code=201, response_model=AgentWebSearchOut,
)
async def create_web_search(
    thread_id: str, payload: AgentWebSearchCreate, response: Response,
) -> AgentWebSearchOut:
    """Веб-поиск Архивариуса: запрос уходит поисковику только по этой кнопке."""
    async with guarded(response):
        await store.require_thread(thread_id)
        results, provider = await web_search.search(payload.query, limit=payload.limit)
        return await store.save_web_search(
            thread_id, query=payload.query, provider=provider,
            results=results, role_id=payload.role_id,
        )


@router.post(
    "/threads/{thread_id}/web-search/{search_id}/translate",
    response_model=AgentWebSearchOut,
)
async def translate_web_search(
    thread_id: str, search_id: str, response: Response,
) -> AgentWebSearchOut:
    """Перевод найденных материалов на русский — отдельным явным действием."""
    async with guarded(response):
        saved = await store.get_web_search(thread_id, search_id)
        provider_id: str | None = None
        model: str | None = None
        if saved.role_id:
            try:
                role = await roles.get_role(saved.role_id)
            except AgentChatError:
                role = None
            if role is not None:
                provider_id, model = role.provider_id, role.model
        translated = await web_search.translate(
            [item.model_dump() for item in saved.results],
            provider_id=provider_id, model=model,
        )
        return await store.update_web_search_results(thread_id, search_id, translated)


@router.post(
    "/threads/{thread_id}/messages", status_code=202, response_model=AgentSendOut,
)
async def send_message(
    thread_id: str, payload: AgentMessageCreate, response: Response,
) -> AgentSendOut:
    """Сообщение исследователя: ответы адресатов приходят задачами и стримом."""
    async with guarded(response):
        return await runner.send_message(thread_id, payload)


@router.get("/threads/{thread_id}/messages/{message_id}", response_model=AgentMessageOut)
async def get_message(thread_id: str, message_id: str, response: Response) -> AgentMessageOut:
    """Одна реплика (поллинг ответа)."""
    async with guarded(response):
        return await store.get_message(thread_id, message_id)


@router.post(
    "/threads/{thread_id}/messages/{message_id}/retry",
    status_code=202, response_model=AgentMessageOut,
)
async def retry_message(
    thread_id: str, message_id: str, response: Response,
) -> AgentMessageOut:
    """Повторить неудавшийся ответ агента."""
    async with guarded(response):
        return await runner.retry_reply(thread_id, message_id)


@router.get(
    "/threads/{thread_id}/messages/{message_id}/stream",
    responses={
        200: {
            "model": ConsiliumStreamEvent,
            "description": (
                "SSE-поток ответа агента: фреймы `event:` + JSON `ConsiliumStreamEvent`"
            ),
            "content": {
                "text/event-stream": {
                    "schema": {"$ref": "#/components/schemas/ConsiliumStreamEvent"},
                },
            },
        },
    },
)
async def stream_message(
    thread_id: str, message_id: str, response: Response,
) -> StreamingResponse:
    """Стрим ответа агента; позднему подписчику — только round_done."""
    async with guarded(response):
        await store.get_message(thread_id, message_id)
    return StreamingResponse(
        stream_frames(streams.get_round(message_id)),
        media_type="text/event-stream",
        headers={"Cache-Control": "private, no-store", "X-Accel-Buffering": "no"},
    )
