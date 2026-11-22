"""Каталог RouteLLM: модели провайдера, стоимость, модальности и лимиты токенов.

Источник истины по списку моделей — ``GET {base_url}/models`` выбранного
провайдера. Поля стоимости/модальностей/лимитов провайдер отдаёт не всегда,
поэтому ответ дополняется публичным каталогом models.dev (кэш в памяти с TTL).
Остаток кредитов RouteLLM через inference-API недоступен: публичного эндпоинта
баланса нет, панель показывает честную ссылку на Billing (правила —
``docs/rules/consilium.md`` §5).
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import settings
from app.schemas.llm_router import (
    RouteLlmCreditsOut,
    RouteLlmModelOut,
    RouteLlmModelsOut,
)
from app.services import llm_router
from app.services.llm_router import LlmRouterError, Provider

_MAX_ERROR_CHARS = 200
_BILLING_URL = "https://abacus.ai/help/howTo/chatllm/faqs/billing"
_CREDITS_NOTE = (
    "RouteLLM не отдаёт остаток кредитов через inference-API: публичного "
    "эндпоинта баланса нет. Остаток смотрите в Abacus.AI → Billing and Invoices."
)

# Кэш каталога models.dev: (момент загрузки, разобранный JSON).
_catalog_cache: tuple[float, dict[str, Any]] | None = None
_catalog_lock = asyncio.Lock()


def _sanitize(text: str, api_key: str | None) -> str:
    """Убрать ключ из текста ошибки и усечь её до читаемого размера."""
    if api_key:
        text = text.replace(api_key, "...")
    text = text.strip()
    return text[:_MAX_ERROR_CHARS] if len(text) > _MAX_ERROR_CHARS else text


def _client() -> httpx.AsyncClient:
    """HTTP-клиент одного вызова (тесты подменяют на MockTransport)."""
    return httpx.AsyncClient(timeout=settings.llm_request_timeout_s)


def _as_int(value: Any) -> int | None:
    """Целое из числа или строки; иначе None (без выдумывания)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _as_float(value: Any) -> float | None:
    """Число из числа или строки; иначе None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _as_list(value: Any) -> list[str]:
    """Список строк из списка или одиночной строки."""
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return []


def _nested(data: dict[str, Any], *keys: str) -> Any:
    """Первое непустое значение по цепочке ключей."""
    for key in keys:
        value = data.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _provider_model(item: dict[str, Any]) -> RouteLlmModelOut | None:
    """Нормализовать одну модель из ответа ``/models`` (форматы OpenAI и Abacus)."""
    model_id = _nested(item, "id", "model", "name")
    if not isinstance(model_id, str) or not model_id.strip():
        return None
    limit_raw = item.get("limit")
    limit: dict[str, Any] = limit_raw if isinstance(limit_raw, dict) else {}
    pricing_raw = item.get("pricing")
    pricing: dict[str, Any] = pricing_raw if isinstance(pricing_raw, dict) else {}
    cost_raw = item.get("cost")
    cost: dict[str, Any] = cost_raw if isinstance(cost_raw, dict) else {}
    modalities = item.get("modalities")
    if isinstance(modalities, dict):
        modalities_input = _as_list(modalities.get("input"))
        modalities_output = _as_list(modalities.get("output"))
    else:
        modalities_input = _as_list(modalities)
        modalities_output = []
    return RouteLlmModelOut(
        id=model_id.strip(),
        name=_nested(item, "name", "display_name"),
        context=_as_int(_nested(
            item, "context_window", "context_length", "max_context_tokens",
        )) or _as_int(limit.get("context")),
        output=_as_int(_nested(
            item, "max_output_tokens", "max_tokens", "output_tokens",
        )) or _as_int(limit.get("output")),
        cost_input=_as_float(_nested(pricing, "input", "prompt")) or _as_float(
            _nested(cost, "input", "prompt"),
        ),
        cost_output=_as_float(_nested(pricing, "output", "completion")) or _as_float(
            _nested(cost, "output", "completion"),
        ),
        modalities_input=modalities_input,
        modalities_output=modalities_output,
        reasoning=item.get("reasoning") if isinstance(item.get("reasoning"), bool) else None,
        tool_call=(
            item.get("tool_call") if isinstance(item.get("tool_call"), bool)
            else item.get("function_calling") if isinstance(item.get("function_calling"), bool)
            else None
        ),
        source="provider",
    )


def _catalog_key(base_url: str, catalog: dict[str, Any]) -> str | None:
    """Ключ провайдера в models.dev по хосту ``base_url``."""
    host = (urlparse(base_url).hostname or "").lower()
    if not host:
        return None
    if "abacus" in host and "abacus" in catalog:
        return "abacus"
    for key, entry in catalog.items():
        if not isinstance(entry, dict):
            continue
        api_host = (urlparse(str(entry.get("api") or "")).hostname or "").lower()
        if api_host and (api_host == host or host.endswith(f".{api_host}")):
            return key
    return None


def _match_catalog(
    model: RouteLlmModelOut,
    models: dict[str, Any],
) -> tuple[str, dict[str, Any]] | None:
    """Найти модель в каталоге: id, canonical id, суффикс id или имя."""
    if model.id in models and isinstance(models[model.id], dict):
        return model.id, models[model.id]
    wanted = model.id.lower()
    for key, entry in models.items():
        if not isinstance(entry, dict):
            continue
        canonical = str(entry.get("canonical_model_id") or "").lower()
        if canonical and (canonical == wanted or canonical.endswith(f"/{wanted}")):
            return key, entry
        if key.lower().endswith(f"/{wanted}") or wanted.endswith(f"/{key.lower()}"):
            return key, entry
    if model.name:
        name = "".join(ch for ch in model.name.lower() if ch.isalnum())
        for key, entry in models.items():
            if not isinstance(entry, dict):
                continue
            entry_name = "".join(
                ch for ch in str(entry.get("name") or "").lower() if ch.isalnum()
            )
            if name and name == entry_name:
                return key, entry
    return None


def _enrich(model: RouteLlmModelOut, entry: dict[str, Any]) -> RouteLlmModelOut:
    """Дополнить модель полями каталога, не затирая данные провайдера."""
    limit_raw = entry.get("limit")
    limit: dict[str, Any] = limit_raw if isinstance(limit_raw, dict) else {}
    cost_raw = entry.get("cost")
    cost: dict[str, Any] = cost_raw if isinstance(cost_raw, dict) else {}
    modalities_raw = entry.get("modalities")
    modalities: dict[str, Any] = modalities_raw if isinstance(modalities_raw, dict) else {}
    enriched = model.model_copy(update={
        "name": model.name or entry.get("name"),
        "context": model.context if model.context is not None else _as_int(limit.get("context")),
        "output": model.output if model.output is not None else _as_int(limit.get("output")),
        "cost_input": (
            model.cost_input if model.cost_input is not None else _as_float(cost.get("input"))
        ),
        "cost_output": (
            model.cost_output if model.cost_output is not None else _as_float(cost.get("output"))
        ),
        "modalities_input": model.modalities_input or _as_list(modalities.get("input")),
        "modalities_output": model.modalities_output or _as_list(modalities.get("output")),
        "reasoning": (
            model.reasoning if model.reasoning is not None
            else entry.get("reasoning") if isinstance(entry.get("reasoning"), bool) else None
        ),
        "tool_call": (
            model.tool_call if model.tool_call is not None
            else entry.get("tool_call") if isinstance(entry.get("tool_call"), bool) else None
        ),
    })
    return enriched.model_copy(update={"source": "both"})


async def _load_catalog(client: httpx.AsyncClient) -> dict[str, Any] | None:
    """Публичный каталог models.dev с кэшем в памяти; ошибка — None (не 500)."""
    global _catalog_cache
    now = time.monotonic()
    if _catalog_cache is not None and now - _catalog_cache[0] < settings.routellm_catalog_ttl_s:
        return _catalog_cache[1]
    async with _catalog_lock:
        now = time.monotonic()
        if _catalog_cache is not None and now - _catalog_cache[0] < settings.routellm_catalog_ttl_s:
            return _catalog_cache[1]
        try:
            response = await client.get(
                settings.routellm_catalog_url,
                timeout=settings.routellm_catalog_timeout_s,
            )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        _catalog_cache = (time.monotonic(), data)
        return data


def _models_url(provider: Provider) -> str:
    """Адрес списка моделей: ``/models`` от base_url без хвостового слэша."""
    return f"{provider.base_url.rstrip('/')}/models"


def _headers(provider: Provider) -> dict[str, str]:
    """Заголовки каталога: Bearer для OpenAI, x-api-key для Anthropic."""
    if provider.protocol == "anthropic":
        return {
            "x-api-key": provider.api_key or "",
            "anthropic-version": "2023-06-01",
        }
    return {"Authorization": f"Bearer {provider.api_key or ''}"}


def _parse_models(data: Any) -> list[RouteLlmModelOut]:
    """Список моделей из ответа провайдера (``data``/``models``/массив)."""
    if isinstance(data, dict):
        raw = data.get("data")
        if raw is None:
            raw = data.get("models")
    else:
        raw = data
    if not isinstance(raw, list):
        raise LlmRouterError("Провайдер вернул неожиданный формат каталога моделей", 502)
    models: list[RouteLlmModelOut] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        model = _provider_model(item)
        if model is None or model.id in seen:
            continue
        seen.add(model.id)
        models.append(model)
    return models


async def list_models(
    provider_id: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> RouteLlmModelsOut:
    """Каталог моделей провайдера с обогащением из models.dev и честными кредитами."""
    state = await llm_router.get_state()
    provider = next((item for item in state.providers if item.id == provider_id), None)
    if provider is None:
        raise LlmRouterError("Провайдер не найден — обновите настройки", 404)
    if not provider.enabled:
        raise LlmRouterError("Провайдер выключен — включите его в настройках")
    if provider.protocol == "systemone":
        raise LlmRouterError("Каталог моделей доступен только для OpenAI/Anthropic-провайдеров")
    if not provider.api_key:
        raise LlmRouterError("У провайдера не задан ключ API — сохраните его в настройках")

    own_client = client is None
    http = client or _client()
    warnings: list[str] = []
    try:
        try:
            response = await http.get(_models_url(provider), headers=_headers(provider))
        except httpx.HTTPError as exc:
            raise LlmRouterError(
                f"Каталог моделей недоступен: {_sanitize(str(exc), provider.api_key)}", 502,
            ) from None
        if response.status_code >= 400:
            text = _sanitize(response.text, provider.api_key)
            raise LlmRouterError(
                f"Провайдер отклонил запрос каталога ({response.status_code}): {text}", 502,
            )
        try:
            models = _parse_models(response.json())
        except ValueError:
            raise LlmRouterError("Провайдер вернул не JSON в каталоге моделей", 502) from None

        catalog = await _load_catalog(http)
        if catalog is None:
            warnings.append(
                "Каталог models.dev недоступен: стоимость, модальности и лимиты "
                "показаны только те, что вернул провайдер",
            )
        else:
            key = _catalog_key(provider.base_url, catalog)
            entry = catalog.get(key) if key else None
            entries = entry.get("models") if isinstance(entry, dict) else None
            if not isinstance(entries, dict):
                warnings.append(
                    "Провайдер не найден в каталоге models.dev: часть полей может быть пустой",
                )
            else:
                enriched: list[RouteLlmModelOut] = []
                for model in models:
                    match = _match_catalog(model, entries)
                    enriched.append(_enrich(model, match[1]) if match else model)
                models = enriched
        if not models:
            warnings.append("Провайдер не вернул ни одной модели")
    finally:
        if own_client:
            await http.aclose()

    return RouteLlmModelsOut(
        provider_id=provider.id,
        provider_label=provider.label,
        models=models,
        credits=RouteLlmCreditsOut(
            available=False,
            note=_CREDITS_NOTE,
            billing_url=_BILLING_URL,
        ),
        warnings=warnings,
        fetched_at=datetime.now(UTC),
    )
