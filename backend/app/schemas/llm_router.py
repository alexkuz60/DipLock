"""Контракт модельного роутера ИИ: ``GET/PUT /api/v1/llm-router``, ``POST .../probe``.

Раздел «Настройки» → панель «Модельный роутер ИИ»: провайдеры внешних API
полноценных моделей и маршруты ``chat``/``transcribe`` (источник истины —
сервер, ``services/llm_router.py``). Ключи API в контракте **не участвуют**:
наружу отдаётся только маска ``key_hint`` (правила — ``docs/rules/consilium.md`` §5).
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

LlmProtocol = Literal["openai", "anthropic"]
LlmRouteKey = Literal["chat", "transcribe"]


class LlmProviderIn(BaseModel):
    """Провайдер из формы PUT (``api_key=None`` — ключ не менять)."""

    id: str | None = Field(
        default=None,
        max_length=64,
        description="Id существующего провайдера; None — новый (id назначит сервер)",
    )
    label: str = Field(min_length=1, max_length=80, description="Человеческое имя провайдера")
    protocol: LlmProtocol = Field(
        description="openai — совместимый /chat/completions; anthropic — Messages API",
    )
    base_url: str = Field(
        min_length=8,
        max_length=300,
        description=(
            "Адрес API как у провайдера (с /v1 или без — роутер дописывает только "
            "/chat/completions или /messages): https://api.deepseek.com, "
            "https://api.openai.com/v1, https://api.anthropic.com/v1"
        ),
    )
    model: str = Field(min_length=1, max_length=120, description="Идентификатор модели провайдера")
    enabled: bool = Field(default=True, description="Выключенный провайдер не вызывается")
    api_key: str | None = Field(
        default=None,
        max_length=500,
        description="None — не менять; '' — удалить ключ; иначе заменить (хранится только на сервере)",
    )
    extra: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Дополнительные параметры тела запроса (например, "
            '{"thinking": {"type": "enabled"}, "reasoning_effort": "high"} для '
            "DeepSeek); None — не менять; {} — убрать. model/messages/stream "
            "задаются роутером"
        ),
    )


class LlmProviderOut(BaseModel):
    """Провайдер для UI: без ключа, только его маска."""

    id: str
    label: str
    protocol: LlmProtocol
    base_url: str
    model: str
    enabled: bool
    key_hint: str | None = Field(
        default=None,
        description="Маска ключа (…abcd); None — ключ не задан",
    )
    extra: dict[str, Any] | None = Field(
        default=None,
        description="Дополнительные параметры тела запроса (как сохранены); None — нет",
    )


class LlmRoutes(BaseModel):
    """Назначение маршрутов на провайдеров (пер-ролевые маршруты — в Т4)."""

    chat: str | None = Field(default=None, description="Провайдер советников (Т3); None — не назначен")
    transcribe: str | None = Field(
        default=None,
        description="Провайдер распознавания (Т2); только protocol=openai; None — не назначен",
    )


class LlmRouterUpdate(BaseModel):
    """``PUT /api/v1/llm-router``: полная замена списка провайдеров и маршрутов."""

    providers: list[LlmProviderIn] = Field(max_length=20, description="Все провайдеры роутера")
    routes: LlmRoutes = Field(default_factory=LlmRoutes)


class LlmRouterOut(BaseModel):
    """``GET /api/v1/llm-router`` — состояние роутера (ключи заменены масками)."""

    providers: list[LlmProviderOut]
    routes: LlmRoutes


class LlmProbeRequest(BaseModel):
    """``POST /api/v1/llm-router/probe``: нейтральная проверка связи с провайдером."""

    provider_id: str = Field(min_length=1, max_length=64)
    route: LlmRouteKey = Field(default="chat", description="Какой маршрут проверять")


class LlmProbeOut(BaseModel):
    """Итог проверки: честная ошибка вместо ложного успеха."""

    ok: bool
    provider_id: str
    route: LlmRouteKey
    model: str | None = Field(default=None, description="Модель провайдера")
    latency_ms: float | None = Field(default=None, description="Задержка вызова, мс")
    error: str | None = Field(default=None, description="Текст для UI; None при успехе")