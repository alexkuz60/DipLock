"""HTTP-контракт модельного роутера ИИ: работа выполняется сервисом ``llm_router``.

Панель «Модельный роутер ИИ» раздела «Настройки»: провайдеры внешних API
полноценных моделей (llama.cpp отклонён 10.10.2026) и маршруты
``chat``/``transcribe``. Ответы приватные ``no-store``; ключи API в контракте
не участвуют — наружу идёт только маска ``key_hint``.
"""

from fastapi import APIRouter, HTTPException, Response

from app.api.private import PrivateRoute
from app.schemas.llm_router import (
    LlmProbeOut,
    LlmProbeRequest,
    LlmProviderOut,
    LlmRouterOut,
    LlmRouterUpdate,
    LlmRoutes,
)
from app.services import llm_router
from app.services.llm_router import LlmRouterError, Provider, RouterState

_NO_STORE = {"Cache-Control": "private, no-store"}

router = APIRouter(prefix="/llm-router", tags=["Настройки ИИ"], route_class=PrivateRoute)


def _provider_out(provider: Provider) -> LlmProviderOut:
    """Собрать контракт провайдера: ключ заменён маской (домен → Pydantic)."""
    return LlmProviderOut(
        id=provider.id,
        label=provider.label,
        protocol=provider.protocol,
        base_url=provider.base_url,
        model=provider.model,
        enabled=provider.enabled,
        key_hint=llm_router.key_hint(provider.api_key),
        extra=provider.extra,
    )


def _router_out(state: RouterState) -> LlmRouterOut:
    return LlmRouterOut(
        providers=[_provider_out(provider) for provider in state.providers],
        routes=LlmRoutes(
            chat=state.routes.get("chat"),
            transcribe=state.routes.get("transcribe"),
        ),
    )


@router.get(
    "",
    response_model=LlmRouterOut,
    summary="Модельный роутер ИИ: провайдеры и маршруты",
)
async def get_llm_router(response: Response) -> LlmRouterOut:
    """Состояние роутера: без ключей, только маски; файл настроек — на сервере."""
    response.headers["Cache-Control"] = _NO_STORE["Cache-Control"]
    try:
        state = await llm_router.get_state()
    except LlmRouterError as exc:
        raise HTTPException(exc.status, str(exc), headers=_NO_STORE) from None
    return _router_out(state)


@router.put(
    "",
    response_model=LlmRouterOut,
    summary="Сохранить провайдеров и маршруты",
)
async def put_llm_router(payload: LlmRouterUpdate, response: Response) -> LlmRouterOut:
    """Полная замена списка провайдеров и маршрутов; ``api_key=None`` — не менять."""
    response.headers["Cache-Control"] = _NO_STORE["Cache-Control"]
    drafts = [
        llm_router.ProviderDraft(
            id=item.id,
            label=item.label,
            protocol=item.protocol,
            base_url=item.base_url,
            model=item.model,
            enabled=item.enabled,
            api_key=item.api_key,
            extra=item.extra,
        )
        for item in payload.providers
    ]
    try:
        state = await llm_router.apply_update(
            drafts,
            {"chat": payload.routes.chat, "transcribe": payload.routes.transcribe},
        )
    except LlmRouterError as exc:
        raise HTTPException(exc.status, str(exc), headers=_NO_STORE) from None
    return _router_out(state)


@router.post(
    "/probe",
    response_model=LlmProbeOut,
    summary="Проверка связи с провайдером (нейтральный запрос)",
)
async def probe_llm_provider(payload: LlmProbeRequest, response: Response) -> LlmProbeOut:
    """Нейтральная проба без материалов дела: ошибка провайдера — в поле error."""
    response.headers["Cache-Control"] = _NO_STORE["Cache-Control"]
    try:
        result = await llm_router.probe(payload.provider_id, payload.route)
    except LlmRouterError as exc:
        raise HTTPException(exc.status, str(exc), headers=_NO_STORE) from None
    return LlmProbeOut(
        ok=result.ok,
        provider_id=payload.provider_id,
        route=payload.route,
        model=result.model,
        latency_ms=result.latency_ms,
        error=result.error,
    )