"""Модельный роутер ИИ: провайдеры внешних API и маршруты chat/transcribe/decide.

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
from typing import Any, Literal

import httpx

from app.core.config import settings

LlmProtocol = Literal["openai", "anthropic", "systemone"]
LlmRouteKey = Literal["chat", "transcribe", "decide"]
# Сценарии пробы советника (§10 стратегии): русский диалог, роль/структура ответа,
# отказ при недостаточности данных, ненаводящие вопросы.
LlmChatProbeScenarioKey = Literal["dialog", "role", "insufficient", "leading"]

_ROUTE_KEYS: tuple[str, ...] = ("chat", "transcribe", "decide")
_ANTHROPIC_VERSION = "2023-06-01"
_PROBE_PROMPT = "Ответь одним словом: готов"
# Список моделей провайдера: id через запятую, пробы идут перебором по каждому.
_MAX_MODELS = 10
_MAX_MODEL_CHARS = 200
_MAX_ERROR_CHARS = 200
_MAX_PROVIDERS = 20
# Поля тела запроса, которые принадлежат роутеру, а не extra провайдера
# (state/questions — тело решающего классификатора systemone).
_RESERVED_BODY_KEYS: frozenset[str] = frozenset({"model", "messages", "stream", "state", "questions"})
_MAX_EXTRA_KEYS = 30
_MAX_EXTRA_CHARS = 4000

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
    extra: dict[str, Any] | None = None


@dataclass(frozen=True)
class RouterState:
    """Полное состояние роутера: провайдеры (с ключами) и назначение маршрутов."""

    providers: tuple[Provider, ...] = ()
    routes: dict[str, str | None] = field(
        default_factory=lambda: {
            "chat": None, "chat_model": None, "transcribe": None, "decide": None,
        },
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
    extra: dict[str, Any] | None = None


@dataclass(frozen=True)
class ProbeModelResult:
    """Итог проверки одной модели из списка провайдера (перебор пробой)."""

    model: str
    ok: bool
    latency_ms: float | None
    error: str | None


@dataclass(frozen=True)
class ProbeResult:
    """Итог проверки связи: без содержимого ответов и ключей.

    ``models`` — перебор моделей списка провайдера (пусто для transcribe:
    там проверяются ключ/адрес без конкретной модели).
    """

    ok: bool
    latency_ms: float | None
    model: str | None
    error: str | None
    models: tuple[ProbeModelResult, ...] = ()


@dataclass(frozen=True)
class ChatResult:
    """Ответ модели одного вызова (примитив для будущих советников Т3)."""

    text: str
    provider_id: str
    model: str
    latency_ms: float
    truncated: bool = False


@dataclass(frozen=True)
class ChatProbeScenario:
    """Сценарий пробы советника (§10): синтетический запрос, материалов дела нет."""

    key: LlmChatProbeScenarioKey
    title: str
    checks: str
    messages: tuple[dict[str, str], ...]


# Пробы §10: выбор модели для маршрута chat по четырём критериям стратегии.
# Промпты синтетические — никакие материалы дела, записи и имена не участвуют.
CHAT_PROBE_SCENARIOS: tuple[ChatProbeScenario, ...] = (
    ChatProbeScenario(
        key="dialog",
        title="Русский диалог",
        checks="Связный русский ответ на реплику и уточняющий вопрос без подсказки",
        messages=(
            {
                "role": "system",
                "content": "Ты — ассистент исследователя. Отвечай по-русски, живо и коротко.",
            },
            {
                "role": "user",
                "content": (
                    "Здравствуйте! Обсудим по-русски, как человек описывает своё состояние "
                    "после музыкальной пробы."
                ),
            },
            {"role": "assistant", "content": "Хорошо, слушаю. С чего начнём?"},
            {
                "role": "user",
                "content": (
                    "Что обычно стоит спросить у человека о его переживании, "
                    "не подсказывая ответ?"
                ),
            },
        ),
    ),
    ChatProbeScenario(
        key="role",
        title="Роль и структура ответа",
        checks=(
            "Роль советника и структура «замечено / возможное объяснение / "
            "чего не знаем / следующий шаг»"
        ),
        messages=(
            {
                "role": "system",
                "content": (
                    "Ты — методолог исследовательского консилиума. Отвечай строго по структуре: "
                    "«Замечено: …» / «Возможное объяснение: …» / «Чего не знаем: …» / "
                    "«Следующий шаг: …». Не выдумывай измерения; синтетические числа "
                    "помечены как учебные."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Учебные (синтетические) данные досье: запись 32 канала 10-20, спектр — "
                    "выраженный пик около 10 Гц в затылочных отведениях, GOF быстрого диполя "
                    "в α-полосе 78%, длина эпохи 2 с, 114 эпох. Вопрос исследователя: что уже "
                    "можно заметить и какой следующий шаг поможет разобраться?"
                ),
            },
        ),
    ),
    ChatProbeScenario(
        key="insufficient",
        title="Отказ при недостаточности данных",
        checks="Честный отказ и перечень недостающего вместо выдуманных выводов",
        messages=(
            {
                "role": "system",
                "content": (
                    "Ты — нейрофизиолог исследовательского консилиума. Если данных "
                    "недостаточно, прямо скажи об этом и перечисли, чего не хватает. "
                    "Не додумывай факты и не подменяй отсутствие данных нормой."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Досье пустое: измерений нет, рассказ добровольца не записан, "
                    "наблюдений исследователя нет. Что можно сказать о состоянии "
                    "добровольца по этим данным?"
                ),
            },
        ),
    ),
    ChatProbeScenario(
        key="leading",
        title="Ненаводящие вопросы",
        checks="Вопрос добровольцу без подсказки ожидаемого ответа",
        messages=(
            {
                "role": "system",
                "content": (
                    "Ты — психологический советник исследовательского консилиума. "
                    "Формулируй ненаводящие вопросы: не подсказывай ответ и не закладывай "
                    "ожидаемое переживание."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Предложи один вопрос добровольцу о том, как он переживал музыкальную "
                    "пробу. Вопрос должен допускать любой ответ, включая «ничего особенного»."
                ),
            },
        ),
    ),
)


@dataclass(frozen=True)
class ChatProbeModelResult:
    """Итог пробы советника (§10) для одной модели списка провайдера."""

    model: str
    ok: bool
    latency_ms: float | None
    text: str | None
    error: str | None
    truncated: bool = False


@dataclass(frozen=True)
class ChatProbeResult:
    """Итог пробы советника (§10): сводка + перебор моделей, без ключей."""

    ok: bool
    scenario: LlmChatProbeScenarioKey
    provider_id: str
    model: str | None
    latency_ms: float | None
    text: str | None
    error: str | None
    truncated: bool = False
    models: tuple[ChatProbeModelResult, ...] = ()


# --- Решающий классификатор (маршрут decide, System One): типизированные решения ---


@dataclass(frozen=True)
class DecideResult:
    """Типизированные решения одного вызова: choice/score/noul без свободного текста.

    ``answers`` — как в контракте Jev: ``{"имя": {"type": ..., ...}}``; вызывающий
    слой проверяет и сохраняет решения (файл задачи их не хранит).
    """

    answers: dict[str, Any]
    provider_id: str
    model: str
    latency_ms: float


@dataclass(frozen=True)
class DecideProbeModelResult:
    """Итог пробы решающего классификатора для одной модели списка провайдера."""

    model: str
    ok: bool
    latency_ms: float | None
    answers: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass(frozen=True)
class DecideProbeResult:
    """Итог пробы decide: синтетический state, материалы дела не отправляются."""

    ok: bool
    provider_id: str
    model: str | None
    latency_ms: float | None
    answers: dict[str, Any]
    error: str | None
    models: tuple[DecideProbeModelResult, ...] = ()


# Проба decide (§5.2): синтетическое описание — проверка протокола и русского
# языка инструкций; никакие материалы дела, записи и имена не участвуют.
DECIDE_PROBE_STATE = (
    "Учебное (синтетическое) описание досье: есть расчёт спектра с пиком около "
    "10 Гц и краткий рассказ человека о спокойном состоянии после музыкальной пробы."
)
DECIDE_PROBE_QUESTIONS: dict[str, dict[str, Any]] = {
    "probe_source": {
        "type": "choice",
        "instructions": "Какие источники описаны в учебном описании досье?",
        "criteria": {
            "measurements_and_report": "есть и измерения с расчётами, и рассказ человека",
            "measurements_only": "есть только измерения и расчёты",
            "report_only": "есть только рассказ человека",
            "nothing": "описание пустое",
        },
    },
    "probe_synthetic": {
        "type": "noul",
        "instructions": "Описание явно помечено как учебное (синтетическое)?",
    },
}


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
            extra=(item["extra"] if isinstance(item.get("extra"), dict) else None),
        )
        for item in raw.get("providers", [])
    )
    routes: dict[str, str | None] = {
        "chat": None, "chat_model": None, "transcribe": None, "decide": None,
    }
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
                "extra": provider.extra,
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


def _split_models(raw: str) -> tuple[str, ...]:
    """Список моделей провайдера: id через запятую, пустые элементы отброшены."""
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _validate_extra(extra: dict[str, Any]) -> None:
    """Дополнительные параметры: без зарезервированных ключей и гигантских тел."""
    reserved = _RESERVED_BODY_KEYS & set(extra)
    if reserved:
        raise LlmRouterError(
            "Параметры model/messages/stream задаются роутером — уберите их "
            "из дополнительных параметров",
        )
    if len(extra) > _MAX_EXTRA_KEYS:
        raise LlmRouterError(
            f"Слишком много дополнительных параметров: не больше {_MAX_EXTRA_KEYS}",
        )
    if len(json.dumps(extra, ensure_ascii=False)) > _MAX_EXTRA_CHARS:
        raise LlmRouterError("Дополнительные параметры слишком велики — сократите JSON")


def _merge_provider(draft: ProviderDraft, known: dict[str, Provider]) -> Provider:
    """Собрать провайдера из черновика: семантика None — не менять (ключ и extra)."""
    if draft.api_key is None:
        api_key = known[draft.id].api_key if draft.id in known else None
    else:
        api_key = draft.api_key or None
    if draft.extra is None:
        extra = known[draft.id].extra if draft.id in known else None
    else:
        extra = draft.extra or None
    if draft.id is None:
        return Provider(
            id=uuid.uuid4().hex[:12],
            label=draft.label,
            protocol=draft.protocol,
            base_url=draft.base_url,
            model=draft.model,
            enabled=draft.enabled,
            api_key=api_key,
            extra=extra,
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
        extra=extra,
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
        models = _split_models(model)
        if not models:
            raise LlmRouterError("Укажите id модели — можно несколько через запятую")
        if len(models) > _MAX_MODELS:
            raise LlmRouterError(f"Слишком много моделей: не больше {_MAX_MODELS}")
        if any(len(item) > _MAX_MODEL_CHARS for item in models):
            raise LlmRouterError("Слишком длинный id модели — сократите")
        model = ", ".join(models)  # нормализованный список кандидатов
        if not (base_url.startswith("http://") or base_url.startswith("https://")):
            raise LlmRouterError("Адрес API должен начинаться с http:// или https://")
        if draft.extra is not None:
            _validate_extra(draft.extra)
        provider = _merge_provider(
            ProviderDraft(
                id=draft.id,
                label=label,
                protocol=draft.protocol,
                base_url=base_url,
                model=model,
                enabled=draft.enabled,
                api_key=draft.api_key,
                extra=draft.extra,
            ),
            known,
        )
        if provider.id in seen_ids:
            raise LlmRouterError("Провайдеры не должны повторяться")
        seen_ids.add(provider.id)
        providers.append(provider)

    by_id = {provider.id: provider for provider in providers}
    new_routes: dict[str, str | None] = {
        "chat": None, "chat_model": None, "transcribe": None, "decide": None,
    }
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
        if key == "decide" and by_id[target].protocol != "systemone":
            raise LlmRouterError(
                "Маршрут решающего классификатора поддерживает только protocol=systemone (Jev)",
            )
        if key == "chat" and by_id[target].protocol == "systemone":
            raise LlmRouterError(
                "Маршрут chat не работает с решающим классификатором — выберите openai или anthropic",
            )
        new_routes[key] = target

    chat_model = (routes.get("chat_model") or "").strip() or None
    if chat_model is not None:
        chat_target = new_routes.get("chat")
        if chat_target is None:
            raise LlmRouterError("Модель маршрута chat выбрана без провайдера — назначьте провайдера")
        if chat_model not in _split_models(by_id[chat_target].model):
            raise LlmRouterError(
                "Модель маршрута chat не входит в список моделей провайдера — выберите заново",
            )
        new_routes["chat_model"] = chat_model

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


def _extract_completion(protocol: LlmProtocol, data: dict) -> tuple[str, bool]:
    """Достать текст ответа модели и признак обрезки по бюджету токенов.

    Thinking-модели отдают рассуждение отдельным полем (``reasoning_content``),
    а итоговый ``content`` может остаться пустым (бюджет ушёл на рассуждение) —
    такое мы не маскируем под ответ, а объясняем в тексте ошибки.
    """
    finish: str | None = None
    reasoning_chars = 0
    try:
        if protocol == "anthropic":
            text = data["content"][0]["text"]
            finish = data.get("stop_reason")
        else:
            choice = data["choices"][0]
            message = choice["message"]
            text = message["content"]
            finish = choice.get("finish_reason")
            for key in ("reasoning_content", "reasoning"):
                value = message.get(key)
                if isinstance(value, str):
                    reasoning_chars = max(reasoning_chars, len(value))
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmRouterError("Провайдер вернул ответ без текста модели") from exc
    truncated = finish in {"length", "max_tokens"}
    if isinstance(text, str) and text.strip():
        return text, truncated
    if truncated and reasoning_chars:
        raise LlmRouterError(
            f"Бюджет токенов исчерпан на рассуждении (thinking), "
            f"итоговый текст пуст (рассуждение {reasoning_chars} симв.)",
        )
    if truncated:
        raise LlmRouterError("Бюджет токенов исчерпан, итоговый текст пуст")
    if reasoning_chars:
        raise LlmRouterError(
            f"Модель вернула только рассуждение (thinking, {reasoning_chars} симв.), "
            "итоговый текст пуст",
        )
    raise LlmRouterError("Провайдер вернул пустой ответ модели")


async def _chat_completion(
    provider: Provider,
    messages: list[dict[str, str]],
    *,
    max_tokens: int,
    model: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> ChatResult:
    """Один вызов чата провайдера (openai или anthropic) без утечки ключа.

    ``model`` — конкретная модель из списка провайдера (пробы идут перебором);
    без неё уходит список как есть — только для одиночной модели.
    """
    http = client or _client()
    chosen = model or provider.model
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
    body: dict[str, Any] = {
        "model": chosen,
        "max_tokens": max_tokens,
        "messages": messages,
    }
    if provider.extra:
        # Зарезервированные ключи отсекаются и здесь: файл мог быть отредактирован вручную.
        body.update({
            key: value
            for key, value in provider.extra.items()
            if key not in _RESERVED_BODY_KEYS
        })

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
    text, truncated = _extract_completion(provider.protocol, data)
    return ChatResult(
        text=text,
        provider_id=provider.id,
        model=chosen,
        latency_ms=latency_ms,
        truncated=truncated,
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


def _probe_summary(results: list[ProbeModelResult]) -> ProbeResult:
    """Сводка перебора моделей: ok — все ответили, error — перечень не прошедших."""
    successes = [item for item in results if item.ok]
    failures = [item for item in results if not item.ok]
    if not failures:
        error = None
    elif len(results) == 1:
        error = failures[0].error
    else:
        error = "; ".join(f"«{item.model}»: {item.error}" for item in failures)
    latencies = [item.latency_ms for item in successes if item.latency_ms is not None]
    return ProbeResult(
        ok=not failures,
        latency_ms=min(latencies, default=None),
        model=successes[0].model if successes else None,
        error=error,
        models=tuple(results),
    )


async def probe(
    provider_id: str,
    route: LlmRouteKey,
    *,
    client: httpx.AsyncClient | None = None,
) -> ProbeResult:
    """Нейтральная проверка связи (без материалов дела): «Ответь одним словом: готов».

    Несколько моделей провайдера — перебором по каждой (отдельный результат).
    """
    if route == "decide":
        result = await decide_probe(provider_id, client=client)
        return ProbeResult(
            ok=result.ok,
            latency_ms=result.latency_ms,
            model=result.model,
            error=result.error,
            models=tuple(ProbeModelResult(
                model=item.model, ok=item.ok, latency_ms=item.latency_ms, error=item.error,
            ) for item in result.models),
        )
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
    models = _split_models(provider.model) or (provider.model,)

    async def _one(model: str) -> ProbeModelResult:
        """Проба одной модели списка; ошибка провайдера — в её строке результата."""
        try:
            result = await _chat_completion(
                provider,
                [{"role": "user", "content": _PROBE_PROMPT}],
                max_tokens=settings.llm_probe_max_tokens,
                model=model,
                client=client,
            )
        except LlmRouterError as exc:
            return ProbeModelResult(model=model, ok=False, latency_ms=None, error=str(exc))
        return ProbeModelResult(model=model, ok=True, latency_ms=result.latency_ms, error=None)

    # модели проверяются параллельно: перебор списка не ждёт по очереди
    results = list(await asyncio.gather(*(_one(model) for model in models)))
    return _probe_summary(results)


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
    models = _split_models(provider.model) or (provider.model,)
    chosen = state.routes.get("chat_model") if route == "chat" else None
    return await _chat_completion(
        provider,
        messages,
        max_tokens=max_tokens,
        # выбранная модель маршрута; без выбора — первая модель списка кандидатов
        model=chosen if chosen in models else models[0],
        client=client,
    )


def _extract_answers(data: dict) -> dict[str, Any]:
    """Типизированные решения из ответа; неожиданный формат — честная ошибка.

    Формат Jev: ``{"answers": {"имя": {"type": "choice"|"score"|"noul", ...}}}``;
    свободного текста нет, поэтому «пустой» или не-JSON ответ не маскируется
    под решение.
    """
    raw = data.get("answers")
    if not isinstance(raw, dict) or not raw:
        raise LlmRouterError("Решающий классификатор вернул ответ без решений")
    answers: dict[str, Any] = {}
    for name, item in raw.items():
        if not isinstance(item, dict) or item.get("type") not in {"choice", "score", "noul"}:
            raise LlmRouterError("Решающий классификатор вернул решения в неожиданном формате")
        answers[str(name)] = item
    return answers


async def _decide_completion(
    provider: Provider,
    state: str | dict[str, Any] | list[Any],
    questions: dict[str, dict[str, Any]],
    *,
    model: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> DecideResult:
    """Один вызов решающего классификатора (protocol systemone) без утечки ключа.

    В отличие от чата роутер **не дописывает путь**: для ``systemone`` поле
    ``base_url`` — полный адрес вызова, так как хосты Jev различаются путями
    (``/v1/systemone``, ``/api/v1/decide``).
    """
    http = client or _client()
    chosen = model or provider.model
    headers = {"content-type": "application/json"}
    if provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    body: dict[str, Any] = {"model": chosen, "state": state, "questions": questions}
    if provider.extra:
        # Зарезервированные ключи отсекаются и здесь: файл мог быть отредактирован вручную.
        body.update({
            key: value
            for key, value in provider.extra.items()
            if key not in _RESERVED_BODY_KEYS
        })

    started = time.perf_counter()
    try:
        response = await http.post(provider.base_url, json=body, headers=headers)
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
    return DecideResult(
        answers=_extract_answers(data),
        provider_id=provider.id,
        model=str(data.get("model") or chosen),
        latency_ms=latency_ms,
    )


async def decide(
    state: str | dict[str, Any] | list[Any],
    questions: dict[str, dict[str, Any]],
    *,
    client: httpx.AsyncClient | None = None,
) -> DecideResult:
    """Вызов решающего классификатора по маршруту ``decide`` (System One).

    Примитив для быстрых типизированных решений (триаж досье Консилиума):
    один round-trip на карту вопросов, без свободного текста в ответе.
    """
    router_state = await get_state()
    target = router_state.routes.get("decide")
    if target is None:
        raise LlmRouterError("Маршрут решающего классификатора не назначен в модельном роутере")
    provider = _find_provider(router_state, target)
    if not provider.enabled:
        raise LlmRouterError("Провайдер маршрута выключен — включите его в настройках")
    if provider.protocol != "systemone":
        raise LlmRouterError("Маршрут decide требует провайдера protocol=systemone")
    models = _split_models(provider.model) or (provider.model,)
    return await _decide_completion(
        provider, state, questions, model=models[0], client=client,
    )


async def decide_probe(
    provider_id: str,
    *,
    client: httpx.AsyncClient | None = None,
) -> DecideProbeResult:
    """Проба решающего классификатора: синтетический state, материалов дела нет.

    Проверяет протокол (типизированные ответы) и русский язык инструкций;
    ответы возвращаются для сверки и в историю дела не сохраняются.
    """
    provider = _find_provider(await get_state(), provider_id)
    if not provider.enabled:
        raise LlmRouterError("Провайдер выключен — включите его в настройках")
    if provider.protocol != "systemone":
        raise LlmRouterError(
            "Проба решающего классификатора доступна только для protocol=systemone",
        )
    models = _split_models(provider.model) or (provider.model,)

    async def _one(model: str) -> DecideProbeModelResult:
        """Проба одной модели списка; ошибка вызова — в её строке результата."""
        try:
            result = await _decide_completion(
                provider, DECIDE_PROBE_STATE, DECIDE_PROBE_QUESTIONS,
                model=model, client=client,
            )
        except LlmRouterError as exc:
            return DecideProbeModelResult(model=model, ok=False, latency_ms=None, error=str(exc))
        return DecideProbeModelResult(
            model=model, ok=True, latency_ms=result.latency_ms,
            answers=result.answers, error=None,
        )

    # модели проверяются параллельно: перебор списка не ждёт по очереди
    results = list(await asyncio.gather(*(_one(model) for model in models)))
    successes = [item for item in results if item.ok]
    failures = [item for item in results if not item.ok]
    first = successes[0] if successes else None
    if not failures:
        error = None
    elif len(results) == 1:
        error = failures[0].error
    else:
        error = "; ".join(f"«{item.model}»: {item.error}" for item in failures)
    latencies = [item.latency_ms for item in successes if item.latency_ms is not None]
    return DecideProbeResult(
        ok=not failures,
        provider_id=provider.id,
        model=first.model if first else None,
        latency_ms=min(latencies, default=None),
        answers=dict(first.answers) if first else {},
        error=error,
        models=tuple(results),
    )


def _find_scenario(key: LlmChatProbeScenarioKey) -> ChatProbeScenario:
    """Найти сценарий пробы; неизвестный ключ — ошибка использования."""
    for scenario in CHAT_PROBE_SCENARIOS:
        if scenario.key == key:
            return scenario
    raise LlmRouterError("Неизвестный сценарий пробы советника", 400)


async def chat_probe(
    provider_id: str,
    scenario_key: LlmChatProbeScenarioKey,
    *,
    client: httpx.AsyncClient | None = None,
) -> ChatProbeResult:
    """Проба советника (§10): синтетический сценарий на конкретном провайдере.

    Материалы дела не отправляются — промпты заданы сервером в ``CHAT_PROBE_SCENARIOS``.
    Ошибка вызова возвращается как ``ok=False`` (без ключа в тексте); неизвестный или
    выключенный провайдер — ошибка использования, как у ``probe``.
    """
    provider = _find_provider(await get_state(), provider_id)
    if not provider.enabled:
        raise LlmRouterError("Провайдер выключен — включите его в настройках")
    scenario = _find_scenario(scenario_key)
    models = _split_models(provider.model) or (provider.model,)

    async def _one(model: str) -> ChatProbeModelResult:
        """Проба одной модели списка; ошибка вызова — в её строке результата."""
        try:
            result = await _chat_completion(
                provider,
                list(scenario.messages),
                max_tokens=settings.llm_probe_max_tokens,
                model=model,
                client=client,
            )
        except LlmRouterError as exc:
            return ChatProbeModelResult(
                model=model, ok=False, latency_ms=None, text=None, error=str(exc),
            )
        return ChatProbeModelResult(
            model=model, ok=True, latency_ms=result.latency_ms,
            text=result.text, error=None, truncated=result.truncated,
        )

    # модели проверяются параллельно: перебор списка не ждёт по очереди
    results = list(await asyncio.gather(*(_one(model) for model in models)))
    successes = [item for item in results if item.ok]
    failures = [item for item in results if not item.ok]
    first = successes[0] if successes else None
    if not failures:
        error = None
    elif len(results) == 1:
        error = failures[0].error
    else:
        error = "; ".join(f"«{item.model}»: {item.error}" for item in failures)
    latencies = [item.latency_ms for item in successes if item.latency_ms is not None]
    return ChatProbeResult(
        ok=not failures,
        scenario=scenario.key,
        provider_id=provider.id,
        model=first.model if first else None,
        latency_ms=min(latencies, default=None),
        text=first.text if first else None,
        error=error,
        truncated=first.truncated if first else False,
        models=tuple(results),
    )