"""Модельный роутер ИИ: провайдеры внешних API и маршруты chat/transcribe.

Локальные урезанные модели (llama.cpp) отклонены 10.10.2026 как советники
Консилиума: работа идёт с полноценными моделями через внешние API (правила —
`docs/rules/consilium.md` §5). Хранилище — JSON-файл на сервере
(``settings.llm_router_config_path``): ключи не возвращаются в UI (только маска
``key_hint``), не попадают в тексты ошибок и логи. Правка настроек ничего не
отправляет наружу — внешний запрос выполняется только явным действием
(``probe`` или будущий ответ советника Т3).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import httpx

from app.core.config import settings

LlmProtocol = Literal["openai", "anthropic"]
LlmRouteKey = Literal["chat", "transcribe"]

_ROUTE_KEYS: tuple[str, ...] = ("chat", "transcribe")
_ANTHROPIC_VERSION = "2023-06-01"
_PROBE_PROMPT = "Ответь одним словом: готов"
_MAX_ERROR_CHARS = 200
_MAX_PROVIDERS = 20

# Сериализация записи файла: параллельные PUT не должны терять чужие правки.
_lock = asyncio.Lock()


class LlmRouterError(Exception):
    """Ошибка роутера с текстом для UI: без ключей и чувствительных данных."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Provider:
    """Провайдер внешнего API модели (ключ — только серверная сторона)."""

    id: str
    label: str
    protocol: LlmProtocol
    base_url: str
    model: str
    enabled: bool
    api_key: str | None


@dataclass(frozen=True)
class RouterState:
    """Полное состояние роутера: провайдеры (с ключами) и назначение маршрутов."""

    providers: tuple[Provider, ...] = ()
    routes: dict[str, str | None] = field(
        default_factory=lambda: {"chat": None, "transcribe": None},
    )


@dataclass(frozen=True)
class ProviderDraft:
    """Черновик провайдера из формы PUT: ``api_key=None`` — ключ не менять."""

    id: str | None
    label: str
    protocol: LlmProtocol
    base_url: str
    model: str
    enabled: bool
    api_key: str | None


@dataclass(frozen=True)
class ProbeResult:
    """Итог проверки связи: без содержимого ответов и ключей."""

    ok: bool
    latency_ms: float | None
    model: str | None
    error: str | None


@dataclass(frozen=True)
class ChatResult:
    """Ответ модели одного вызова (примитив для будущих советников Т3)."""

    text: str
    provider_id: str
    model: str
    latency_ms: float


def key_hint(api_key: str | None) -> str | None:
    """Маска ключа для UI (``…abcd``); None — ключ не задан. Сам ключ не отдаётся."""
    if not api_key:
        return None
    return f"…{api_key[-4:]}" if len(api_key) >= 4 else "…"


def _config_path() -> Path:
    return Path(settings.llm_router_config_path)


def _client() -> httpx.AsyncClient:
    """HTTP-клиент одного вызова (тесты подменяют на MockTransport)."""
    return httpx.AsyncClient(timeout=settings.llm_request_timeout_s)


def _sanitize(text: str, api_key: str | None) -> str:
    """Убрать ключ из текста ошибки и усечь её до читаемого размера."""
    if api_key:
        text = text.replace(api_key, "…")
    text = text.strip()
    return text[:_MAX_ERROR_CHARS] if len(text) > _MAX_ERROR_CHARS else text


def _read_state() -> RouterState:
    """Прочитать файл настроек: отсутствующий файл — пустой роутер."""
    path = _config_path()
    if not path.exists():
        return RouterState()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise LlmRouterError("Файл настроек модельного роутера повреждён", 500) from exc
    except OSError as exc:
        raise LlmRouterError("Не удалось прочитать настройки модельного роутера", 500) from exc
    providers = tuple(
        Provider(
            id=str(item.get("id", "")),
            label=str(item.get("label", "")),
            protocol=item.get("protocol", "openai"),
            base_url=str(item.get("base_url", "")),
            model=str(item.get("model", "")),
            enabled=bool(item.get("enabled", True)),
            api_key=(str(item["api_key"]) if item.get("api_key") else None),
        )
        for item in raw.get("providers", [])
    )
    routes: dict[str, str | None] = {"chat": None, "transcribe": None}
    for key, value in dict(raw.get("routes", {})).items():
        if key in routes:
            routes[key] = str(value) if value else None
    return RouterState(providers=providers, routes=routes)


def _write_state(state: RouterState) -> None:
    """Атомарно записать состояние (tmp + replace): файл не бывает полувалидным."""
    payload = {
        "version": 1,
        "providers": [
            {
                "id": provider.id,
                "label": provider.label,
                "protocol": provider.protocol,
                "base_url": provider.base_url,
                "model": provider.model,
                "enabled": provider.enabled,
                "api_key": provider.api_key,
            }
            for provider in state.providers
        ],
        "routes": dict(state.routes),
    }
    path = _config_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        raise LlmRouterError("Не удалось сохранить настройки модельного роутера", 500) from exc


async def get_state() -> RouterState:
    """Текущее состояние роутера (провайдеры с ключами — внутренний уровень)."""
    return await asyncio.to_thread(_read_state)


def _merge_provider(draft: ProviderDraft, known: dict[str, Provider]) -> Provider:
    """Собрать провайдера из черновика: семантика ключа None — не менять."""
    if draft.api_key is None:
        api_key = known[draft.id].api_key if draft.id in known else None
    else:
        api_key = draft.api_key or None
    if draft.id is None:
        return Provider(
            id=uuid.uuid4().hex[:12],
            label=draft.label,
            protocol=draft.protocol,
            base_url=draft.base_url,
            model=draft.model,
            enabled=draft.enabled,
            api_key=api_key,
        )
    if draft.id not in known:
        raise LlmRouterError(
            "Провайдер не найден — обновите настройки и сохраните снова",
            409,
        )
    return Provider(
        id=draft.id,
        label=draft.label,
        protocol=draft.protocol,
        base_url=draft.base_url,
        model=draft.model,
        enabled=draft.enabled,
        api_key=api_key,
    )


def _apply_update_sync(
    drafts: list[ProviderDraft],
    routes: dict[str, str | None],
) -> RouterState:
    """Валидация и полная замена провайдеров/маршрутов (работа PUT)."""
    if len(drafts) > _MAX_PROVIDERS:
        raise LlmRouterError(f"Слишком много провайдеров: не больше {_MAX_PROVIDERS}")
    current = _read_state()
    known = {provider.id: provider for provider in current.providers}

    providers: list[Provider] = []
    seen_ids: set[str] = set()
    for draft in drafts:
        label = draft.label.strip()
        base_url = draft.base_url.strip().rstrip("/")
        model = draft.model.strip()
        if not label or not model:
            raise LlmRouterError("Имя провайдера и модель обязательны")
        if not (base_url.startswith("http://") or base_url.startswith("https://")):
            raise LlmRouterError("Адрес API должен начинаться с http:// или https://")
        provider = _merge_provider(
            ProviderDraft(
                id=draft.id,
                label=label,
                protocol=draft.protocol,
                base_url=base_url,
                model=model,
                enabled=draft.enabled,
                api_key=draft.api_key,
            ),
            known,
        )
        if provider.id in seen_ids:
            raise LlmRouterError("Провайдеры не должны повторяться")
        seen_ids.add(provider.id)
        providers.append(provider)

    by_id = {provider.id: provider for provider in providers}
    new_routes: dict[str, str | None] = {"chat": None, "transcribe": None}
    for key in _ROUTE_KEYS:
        target = routes.get(key)
        if target is None:
            continue
        if target not in by_id:
            raise LlmRouterError("Маршрут назначен на удалённого провайдера — выберите заново")
        if key == "transcribe" and by_id[target].protocol != "openai":
            raise LlmRouterError(
                "Маршрут распознавания поддерживает только совместимый (openai) API",
            )
        new_routes[key] = target

    state = RouterState(providers=tuple(providers), routes=new_routes)
    _write_state(state)
    return state


async def apply_update(
    drafts: list[ProviderDraft],
    routes: dict[str, str | None],
) -> RouterState:
    """Сохранить провайдеров и маршруты (PUT): полная замена списка."""
    async with _lock:
        return await asyncio.to_thread(_apply_update_sync, drafts, routes)


def _provider_error(response: httpx.Response, api_key: str | None) -> str:
    """Короткий текст ошибки провайдера для UI: статус + сообщение, без ключа."""
    detail = ""
    try:
        body = response.json()
        error = body.get("error") if isinstance(body, dict) else None
        if isinstance(error, dict):
            detail = str(error.get("message", ""))
        elif isinstance(error, str):
            detail = error
        elif isinstance(body, dict):
            detail = str(body.get("detail", ""))
    except ValueError:
        detail = ""
    if not detail:
        detail = f"HTTP {response.status_code}"
    return _sanitize(f"Провайдер ответил {response.status_code}: {detail}", api_key)


def _extract_text(protocol: LlmProtocol, data: dict) -> str:
    """Достать текст из ответа модели; отсутствие текста — честная ошибка."""
    try:
        if protocol == "anthropic":
            text = data["content"][0]["text"]
        else:
            text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmRouterError("Провайдер вернул ответ без текста модели") from exc
    if not isinstance(text, str) or not text.strip():
        raise LlmRouterError("Провайдер вернул пустой ответ модели")
    return text


async def _chat_completion(
    provider: Provider,
    messages: list[dict[str, str]],
    *,
    max_tokens: int,
    client: httpx.AsyncClient | None = None,
) -> ChatResult:
    """Один вызов чата провайдера (openai или anthropic) без утечки ключа."""
    http = client or _client()
    headers = {"content-type": "application/json"}
    if provider.protocol == "anthropic":
        headers["anthropic-version"] = _ANTHROPIC_VERSION
        if provider.api_key:
            headers["x-api-key"] = provider.api_key
        url = f"{provider.base_url}/messages"
    else:
        if provider.api_key:
            headers["Authorization"] = f"Bearer {provider.api_key}"
        url = f"{provider.base_url}/chat/completions"
    body = {"model": provider.model, "max_tokens": max_tokens, "messages": messages}

    started = time.perf_counter()
    try:
        response = await http.post(url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise LlmRouterError(
            _sanitize(f"Провайдер недоступен: {exc}", provider.api_key),
        ) from None
    latency_ms = (time.perf_counter() - started) * 1000
    if response.status_code != 200:
        raise LlmRouterError(_provider_error(response, provider.api_key))
    try:
        data = response.json()
    except ValueError as exc:
        raise LlmRouterError("Провайдер вернул не JSON") from exc
    if not isinstance(data, dict):
        raise LlmRouterError("Провайдер вернул неожиданный формат ответа")
    return ChatResult(
        text=_extract_text(provider.protocol, data),
        provider_id=provider.id,
        model=provider.model,
        latency_ms=latency_ms,
    )


async def _models_probe(
    provider: Provider,
    client: httpx.AsyncClient | None = None,
) -> ProbeResult:
    """Проверка ключа/адреса списком моделей (маршрут transcribe, protocol openai)."""
    http = client or _client()
    headers = {"accept": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    started = time.perf_counter()
    try:
        response = await http.get(f"{provider.base_url}/models", headers=headers)
    except httpx.HTTPError as exc:
        return ProbeResult(
            ok=False,
            latency_ms=None,
            model=provider.model,
            error=_sanitize(f"Провайдер недоступен: {exc}", provider.api_key),
        )
    latency_ms = (time.perf_counter() - started) * 1000
    if response.status_code != 200:
        return ProbeResult(
            ok=False,
            latency_ms=latency_ms,
            model=provider.model,
            error=_provider_error(response, provider.api_key),
        )
    return ProbeResult(ok=True, latency_ms=latency_ms, model=provider.model, error=None)


def _find_provider(state: RouterState, provider_id: str) -> Provider:
    for provider in state.providers:
        if provider.id == provider_id:
            return provider
    raise LlmRouterError("Провайдер не найден — обновите настройки", 404)


async def probe(
    provider_id: str,
    route: LlmRouteKey,
    *,
    client: httpx.AsyncClient | None = None,
) -> ProbeResult:
    """Нейтральная проверка связи (без материалов дела): «Ответь одним словом: готов»."""
    provider = _find_provider(await get_state(), provider_id)
    if not provider.enabled:
        raise LlmRouterError("Провайдер выключен — включите его в настройках")
    if route == "transcribe":
        if provider.protocol != "openai":
            return ProbeResult(
                ok=False,
                latency_ms=None,
                model=provider.model,
                error="Маршрут распознавания через Anthropic пока не поддерживается",
            )
        return await _models_probe(provider, client)
    try:
        result = await _chat_completion(
            provider,
            [{"role": "user", "content": _PROBE_PROMPT}],
            max_tokens=8,
            client=client,
        )
    except LlmRouterError as exc:
        return ProbeResult(ok=False, latency_ms=None, model=provider.model, error=str(exc))
    return ProbeResult(ok=True, latency_ms=result.latency_ms, model=result.model, error=None)


async def chat(
    messages: list[dict[str, str]],
    *,
    route: LlmRouteKey = "chat",
    max_tokens: int = 1024,
    client: httpx.AsyncClient | None = None,
) -> ChatResult:
    """Вызов модели по маршруту: примитив советников (Т3), без инструментов и очереди."""
    state = await get_state()
    target = state.routes.get(route)
    if target is None:
        raise LlmRouterError("Маршрут ИИ не назначен в модельном роутере")
    provider = _find_provider(state, target)
    if not provider.enabled:
        raise LlmRouterError("Провайдер маршрута выключен — включите его в настройках")
    return await _chat_completion(provider, messages, max_tokens=max_tokens, client=client)