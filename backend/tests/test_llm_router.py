"""Модельный роутер ИИ: хранение провайдеров, маскирование ключей, probe и chat.

Тесты идут на своей tmp-настройке: ``llm_router_config_path`` перенаправляется
в tmp_path, внешние вызовы подменяются ``httpx.MockTransport`` — сеть и
реальные провайдеры не используются.
"""

import json

import httpx
import pytest

from app.core.config import settings
from app.services import llm_router, routellm_catalog

PREFIX = "/api/v1/llm-router"
_TEST_KEY = "sk-secret-1234"


@pytest.fixture()
def router_config(tmp_path, monkeypatch):
    """Файл настроек роутера — в tmp_path: рабочий data/llm_router.json не трогаем."""
    path = tmp_path / "llm_router.json"
    monkeypatch.setattr(settings, "llm_router_config_path", str(path))
    return path


@pytest.fixture()
def catalog_cache():
    """Сброс кэша models.dev между тестами каталога RouteLLM."""
    routellm_catalog._catalog_cache = None
    yield
    routellm_catalog._catalog_cache = None


def _provider_payload(**overrides) -> dict:
    payload = {
        "id": None,
        "label": "Полная модель",
        "protocol": "openai",
        "base_url": "https://api.example.com/v1",
        "model": "big-model-1",
        "enabled": True,
        "api_key": _TEST_KEY,
    }
    payload.update(overrides)
    return payload


def _mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _ok_chat_handler(request: httpx.Request) -> httpx.Response:
    assert request.headers.get("Authorization") == f"Bearer {_TEST_KEY}"
    return httpx.Response(200, json={
        "choices": [{"message": {"content": "готов"}}],
    })


# ---------- хранение и маскирование ----------


def test_get_empty_router(client, router_config):
    """Пустой роутер: нет файла — нет провайдеров и маршрутов, ответ no-store."""
    result = client.get(PREFIX)
    assert result.status_code == 200, result.text
    assert result.json() == {
        "providers": [],
        "routes": {"chat": None, "chat_model": None, "transcribe": None},
    }
    assert "no-store" in result.headers["Cache-Control"]


def test_put_masks_key_and_persists(client, router_config):
    """PUT сохраняет ключ на сервере, GET отдаёт только маску (никогда ключ)."""
    created = client.put(PREFIX, json={"providers": [_provider_payload()], "routes": {}})
    assert created.status_code == 200, created.text
    provider = created.json()["providers"][0]
    assert provider["key_hint"] == "…1234"
    assert _TEST_KEY not in created.text

    listed = client.get(PREFIX)
    assert _TEST_KEY not in listed.text
    assert listed.json()["providers"][0]["id"] == provider["id"]

    # Ключ лежит в файле на сервере — источник истины для вызовов модели
    assert _TEST_KEY in router_config.read_text(encoding="utf-8")


def test_put_keeps_and_clears_key(client, router_config):
    """api_key=None — ключ не менять; '' — удалить ключ провайдера."""
    created = client.put(PREFIX, json={"providers": [_provider_payload()], "routes": {}})
    provider_id = created.json()["providers"][0]["id"]

    kept = client.put(PREFIX, json={
        "providers": [_provider_payload(id=provider_id, api_key=None, label="Новое имя")],
        "routes": {},
    })
    assert kept.status_code == 200, kept.text
    assert kept.json()["providers"][0]["key_hint"] == "…1234"
    assert kept.json()["providers"][0]["label"] == "Новое имя"

    cleared = client.put(PREFIX, json={
        "providers": [_provider_payload(id=provider_id, api_key="")],
        "routes": {},
    })
    assert cleared.json()["providers"][0]["key_hint"] is None
    assert _TEST_KEY not in router_config.read_text(encoding="utf-8")


def test_put_strips_key_whitespace(client, router_config):
    """Ключ из буфера с пробелом и переводом строки хранится без обрамления."""
    created = client.put(PREFIX, json={
        "providers": [_provider_payload(api_key=f"  {_TEST_KEY} \n")],
        "routes": {},
    })
    assert created.status_code == 200, created.text
    assert created.json()["providers"][0]["key_hint"] == llm_router.key_hint(_TEST_KEY)
    stored = json.loads(router_config.read_text(encoding="utf-8"))
    assert stored["providers"][0]["api_key"] == _TEST_KEY

    blank = client.put(PREFIX, json={
        "providers": [_provider_payload(api_key="   \n")],
        "routes": {},
    })
    assert blank.status_code == 200, blank.text
    assert blank.json()["providers"][0]["key_hint"] is None


@pytest.mark.asyncio
async def test_read_state_strips_legacy_key_whitespace(router_config, monkeypatch):
    """Старый файл с хвостовым пробелом в ключе читается очищенным — вызов проходит."""
    router_config.write_text(json.dumps({
        "version": 1,
        "providers": [{
            "id": "legacy-1",
            "label": "P",
            "protocol": "openai",
            "base_url": "https://api.example.com/v1",
            "model": "m1",
            "enabled": True,
            "api_key": f"{_TEST_KEY} ",
            "extra": None,
        }],
        "routes": {},
    }), encoding="utf-8")

    state = await llm_router.get_state()
    assert state.providers[0].api_key == _TEST_KEY

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(_ok_chat_handler))
    ok = await llm_router.probe("legacy-1", "chat")
    assert ok.ok is True, ok.error


def test_legacy_systemone_provider_does_not_break_panel(client, router_config):
    """Строка удалённого протокола ``systemone`` в файле — не 500, а пропуск строки.

    Режим «Исследование» снят 23.11.2026, но в ``data/llm_router.json`` могли
    остаться провайдеры с этим протоколом: панель обязана открыться, а маршрут
    на пропущенного провайдера — стать пустым.
    """
    router_config.write_text(json.dumps({
        "version": 1,
        "providers": [
            {
                "id": "chat-1",
                "label": "Чат",
                "protocol": "openai",
                "base_url": "https://api.example.com/v1",
                "model": "m1",
                "enabled": True,
                "api_key": _TEST_KEY,
                "extra": None,
            },
            {
                "id": "jev-1",
                "label": "Jev",
                "protocol": "systemone",
                "base_url": "https://jev.example.com/api/v1/decide",
                "model": "jev-1.13.0",
                "enabled": True,
                "api_key": _TEST_KEY,
                "extra": None,
            },
        ],
        "routes": {"chat": "chat-1", "chat_model": "m1", "decide": "jev-1"},
    }), encoding="utf-8")

    result = client.get(PREFIX)
    assert result.status_code == 200, result.text
    body = result.json()
    assert [item["id"] for item in body["providers"]] == ["chat-1"]
    assert body["routes"]["chat"] == "chat-1"
    assert body["routes"]["chat_model"] == "m1"

    router_config.write_text(json.dumps({
        "version": 1,
        "providers": [],
        "routes": {"chat": "jev-1", "chat_model": "jev-1.13.0"},
    }), encoding="utf-8")
    orphan = client.get(PREFIX)
    assert orphan.status_code == 200, orphan.text
    assert orphan.json()["routes"]["chat"] is None
    assert orphan.json()["routes"]["chat_model"] is None


def test_put_empty_model_is_russian_400(client, router_config):
    """Пустая модель — русский 400, а не английский 422: текст виден в панели."""
    result = client.put(PREFIX, json={
        "providers": [_provider_payload(model="")],
        "routes": {},
    })
    assert result.status_code == 400
    assert "Модель" in result.json()["detail"]

    blank_label = client.put(PREFIX, json={
        "providers": [_provider_payload(label="")],
        "routes": {},
    })
    assert blank_label.status_code == 400
    assert "имя провайдера" in blank_label.json()["detail"].lower()


def test_put_duplicate_endpoint_is_rejected(client, router_config):
    """Две строки на один адрес — ошибка с именем существующей строки."""
    result = client.put(PREFIX, json={
        "providers": [
            _provider_payload(label="RouteLLM (Abacus.AI)"),
            _provider_payload(label="RouteLLM копия", api_key=""),
        ],
        "routes": {},
    })
    assert result.status_code == 400
    detail = result.json()["detail"]
    assert "RouteLLM (Abacus.AI)" in detail
    assert "одну строку" in detail


def test_put_unknown_provider_conflict(client, router_config):
    """Неизвестный id — 409 (устаревшая копия настроек), не молчаливое создание."""
    result = client.put(PREFIX, json={
        "providers": [_provider_payload(id="missing-id")],
        "routes": {},
    })
    assert result.status_code == 409
    assert "обновите настройки" in result.json()["detail"]


def test_put_rejects_bad_base_url(client, router_config):
    """Адрес без http(s) — 400 с текстом для UI, файл не перезаписан."""
    result = client.put(PREFIX, json={
        "providers": [_provider_payload(base_url="ftp://example.com")],
        "routes": {},
    })
    assert result.status_code == 400
    assert "http://" in result.json()["detail"]
    assert not router_config.exists()


def test_put_routes_validation(client, router_config):
    """Маршруты: только существующие провайдеры; transcribe — только openai."""
    created = client.put(PREFIX, json={
        "providers": [_provider_payload(protocol="anthropic", base_url="https://api.anthropic.com/v1")],
        "routes": {"chat": "nope"},
    })
    assert created.status_code == 400
    assert "удалённого провайдера" in created.json()["detail"]

    created = client.put(PREFIX, json={
        "providers": [_provider_payload(protocol="anthropic", base_url="https://api.anthropic.com/v1")],
        "routes": {},
    })
    provider_id = created.json()["providers"][0]["id"]
    bad = client.put(PREFIX, json={
        "providers": [_provider_payload(id=provider_id, protocol="anthropic", base_url="https://api.anthropic.com/v1")],
        "routes": {"transcribe": provider_id},
    })
    assert bad.status_code == 400
    assert "openai" in bad.json()["detail"]


def test_validation_error_does_not_echo_key(client, router_config):
    """422 формы не эхо-передаёт api_key (PrivateRoute): маскирование не только в GET."""
    result = client.post(f"{PREFIX}/probe", json={
        "provider_id": "x" * 100,  # > max_length=64
        "route": "chat",
        "api_key": _TEST_KEY,
    })
    assert result.status_code == 422
    assert _TEST_KEY not in result.text
    assert "input" not in result.json()["detail"][0]
    assert "no-store" in result.headers["Cache-Control"]


# ---------- probe ----------


@pytest.mark.asyncio
async def test_probe_chat_ok_and_error(router_config, monkeypatch):
    """Probe шлёт нейтральный запрос; ошибка провайдера честная и без ключа."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1", model="m1", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(_ok_chat_handler))
    ok = await llm_router.probe(provider_id, "chat")
    assert ok.ok is True
    assert ok.model == "m1"
    assert ok.latency_ms is not None and ok.latency_ms >= 0

    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": f"oops {_TEST_KEY}"}})

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(failing))
    failed = await llm_router.probe(provider_id, "chat")
    assert failed.ok is False
    assert "Провайдер ответил 500" in (failed.error or "")
    assert _TEST_KEY not in (failed.error or "")


async def test_probe_auth_errors_carry_actionable_hint(router_config, monkeypatch):
    """403 Invalid API Key и «User not logged in» объясняют, что делать, без ключа."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://routellm.abacus.ai/v1", model="route-llm", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id

    def invalid(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "Invalid API Key"})

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(invalid))
    bad_key = await llm_router.probe(provider_id, "chat")
    assert bad_key.ok is False
    assert "route-llm-apis" in (bad_key.error or "")
    assert _TEST_KEY not in (bad_key.error or "")

    def anonymous(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "User not logged in"})

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(anonymous))
    no_key = await llm_router.probe(provider_id, "chat")
    assert no_key.ok is False
    assert "не сохранён" in (no_key.error or "")


@pytest.mark.asyncio
async def test_probe_requires_enabled_provider(router_config):
    """Неизвестный/выключенный провайдер — ошибка использования, не вызов модели."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1", model="m1", enabled=False,
            api_key=None,
        )],
        {},
    )
    with pytest.raises(llm_router.LlmRouterError):
        await llm_router.probe("missing", "chat")
    with pytest.raises(llm_router.LlmRouterError):
        await llm_router.probe(state.providers[0].id, "chat")


@pytest.mark.asyncio
async def test_probe_transcribe_uses_models_endpoint(router_config, monkeypatch):
    """Probe распознавания проверяет ключ/адрес списком моделей (openai)."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="ASR", protocol="openai",
            base_url="https://api.example.com/v1", model="whisper-1", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id
    await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=provider_id, label="ASR", protocol="openai",
            base_url="https://api.example.com/v1", model="whisper-1", enabled=True,
            api_key=None,
        )],
        {"transcribe": provider_id},
    )

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json={"data": []})

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    result = await llm_router.probe(provider_id, "transcribe")
    assert result.ok is True
    assert seen == ["/v1/models"]


# ---------- chat ----------


@pytest.mark.asyncio
async def test_chat_resolves_route_openai_and_anthropic(router_config):
    """chat() идёт по маршруту: Bearer для openai, x-api-key для anthropic."""
    created = await llm_router.apply_update(
        [
            llm_router.ProviderDraft(
                id=None, label="O", protocol="openai",
                base_url="https://api.example.com/v1", model="m-open", enabled=True,
                api_key=_TEST_KEY,
            ),
            llm_router.ProviderDraft(
                id=None, label="A", protocol="anthropic",
                base_url="https://api.anthropic.com/v1", model="m-ant", enabled=True,
                api_key="ant-key-9876",
            ),
        ],
        {},
    )
    openai_id = created.providers[0].id
    anthropic_id = created.providers[1].id

    captured: dict[str, httpx.Request] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured[request.url.path] = request
        if request.url.path.endswith("/messages"):
            return httpx.Response(200, json={"content": [{"text": "из anthropic"}]})
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "из openai"}}],
        })

    client = _mock_client(handler)
    await llm_router.apply_update(
        [
            llm_router.ProviderDraft(
                id=openai_id, label="O", protocol="openai",
                base_url="https://api.example.com/v1", model="m-open", enabled=True,
                api_key=None,
            ),
            llm_router.ProviderDraft(
                id=anthropic_id, label="A", protocol="anthropic",
                base_url="https://api.anthropic.com/v1", model="m-ant", enabled=True,
                api_key=None,
            ),
        ],
        {"chat": openai_id},
    )
    result = await llm_router.chat(
        [{"role": "user", "content": "привет"}], client=client,
    )
    assert result.text == "из openai"
    assert result.provider_id == openai_id
    request = captured["/v1/chat/completions"]
    assert request.headers["Authorization"] == f"Bearer {_TEST_KEY}"
    assert b"m-open" in request.content

    await llm_router.apply_update(
        [
            llm_router.ProviderDraft(
                id=openai_id, label="O", protocol="openai",
                base_url="https://api.example.com/v1", model="m-open", enabled=True,
                api_key=None,
            ),
            llm_router.ProviderDraft(
                id=anthropic_id, label="A", protocol="anthropic",
                base_url="https://api.anthropic.com/v1", model="m-ant", enabled=True,
                api_key=None,
            ),
        ],
        {"chat": anthropic_id},
    )
    result = await llm_router.chat(
        [{"role": "user", "content": "привет"}], client=client,
    )
    assert result.text == "из anthropic"
    request = captured["/v1/messages"]
    assert request.headers["x-api-key"] == "ant-key-9876"
    assert b"m-ant" in request.content


@pytest.mark.asyncio
async def test_chat_unassigned_route(router_config):
    """Неназначенный маршрут — честная ошибка, без обращения к сети."""
    with pytest.raises(llm_router.LlmRouterError) as exc:
        await llm_router.chat([{"role": "user", "content": "x"}])
    assert "не назначен" in str(exc.value)


@pytest.mark.asyncio
async def test_state_survives_reload(router_config):
    """Файл — источник истины: повторное чтение находит тех же провайдеров."""
    saved = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1", model="m1", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    reread = await llm_router.get_state()
    assert [p.id for p in reread.providers] == [p.id for p in saved.providers]
    assert reread.providers[0].api_key == _TEST_KEY
    assert reread.routes == saved.routes


# ---------- дополнительные параметры (DeepSeek thinking/reasoning_effort) ----------


@pytest.mark.asyncio
async def test_extra_merged_into_request_body(router_config, monkeypatch):
    """extra дополняет тело запроса; stream остаётся за роутером (не отправляется)."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="DeepSeek", protocol="openai",
            base_url="https://api.deepseek.com", model="deepseek-flash", enabled=True,
            api_key=_TEST_KEY,
            extra={"thinking": {"type": "enabled"}, "reasoning_effort": "high"},
        )],
        {},
    )
    provider_id = state.providers[0].id
    assert state.providers[0].extra == {
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
    }

    captured: dict[str, bytes] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "готов"}}],
        })

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    result = await llm_router.probe(provider_id, "chat")
    assert result.ok is True

    body = json.loads(captured["body"])
    assert body["model"] == "deepseek-flash"
    assert body["thinking"] == {"type": "enabled"}
    assert body["reasoning_effort"] == "high"
    # Бюджет пробы достаточно велик для thinking-режима (не 8 токенов)
    assert body["max_tokens"] >= 256
    assert "stream" not in body


def test_extra_reserved_keys_rejected(client, router_config):
    """model/messages/stream задаются роутером — в extra их быть не должно."""
    result = client.put(PREFIX, json={
        "providers": [_provider_payload(extra={"stream": True})],
        "routes": {},
    })
    assert result.status_code == 400
    assert "stream" in result.json()["detail"]
    assert not router_config.exists()


def test_extra_none_keeps_and_empty_clears(client, router_config):
    """extra=None — не менять; {} — убрать дополнительные параметры."""
    created = client.put(PREFIX, json={
        "providers": [_provider_payload(extra={"reasoning_effort": "high"})],
        "routes": {},
    })
    provider_id = created.json()["providers"][0]["id"]
    assert created.json()["providers"][0]["extra"] == {"reasoning_effort": "high"}

    kept = client.put(PREFIX, json={
        "providers": [_provider_payload(id=provider_id, extra=None, label="P2")],
        "routes": {},
    })
    assert kept.json()["providers"][0]["extra"] == {"reasoning_effort": "high"}

    cleared = client.put(PREFIX, json={
        "providers": [_provider_payload(id=provider_id, extra={})],
        "routes": {},
    })
    assert cleared.json()["providers"][0]["extra"] is None


# ---------- chat-probe (пробы советника, §10) ----------


def _capture_chat_handler(store: list[dict]):
    """Обработчик MockTransport: записывает тела вызовов и отвечает текстом модели."""

    def handler(request: httpx.Request) -> httpx.Response:
        store.append(json.loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "Замечено: учебный пик."}}],
        })

    return handler


@pytest.mark.asyncio
async def test_chat_probe_scenarios_send_synthetic_messages(router_config, monkeypatch):
    """Пробы §10: каждый сценарий уходит своей синтетической постановкой (без материалов дела)."""
    assert [s.key for s in llm_router.CHAT_PROBE_SCENARIOS] == [
        "dialog", "role", "insufficient", "leading",
    ]
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1", model="m1", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id
    bodies: list[dict] = []
    monkeypatch.setattr(
        llm_router, "_client", lambda: _mock_client(_capture_chat_handler(bodies)),
    )

    for scenario in llm_router.CHAT_PROBE_SCENARIOS:
        result = await llm_router.chat_probe(provider_id, scenario.key)
        assert result.ok is True, result.error
        assert result.scenario == scenario.key
        assert result.text == "Замечено: учебный пик."
        assert result.latency_ms is not None and result.latency_ms >= 0

    assert [body["messages"] for body in bodies] == [
        list(scenario.messages) for scenario in llm_router.CHAT_PROBE_SCENARIOS
    ]
    assert all(body["max_tokens"] == settings.llm_probe_max_tokens for body in bodies)


@pytest.mark.asyncio
async def test_chat_probe_error_is_honest_and_usage_errors_raise(router_config, monkeypatch):
    """Ошибка провайдера — ok=False без ключа; чужой сценарий/провайдер — ошибка использования."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1", model="m1", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id

    def failing(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": f"oops {_TEST_KEY}"}})

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(failing))
    failed = await llm_router.chat_probe(provider_id, "dialog")
    assert failed.ok is False
    assert "Провайдер ответил 500" in (failed.error or "")
    assert _TEST_KEY not in (failed.error or "")
    assert failed.text is None

    with pytest.raises(llm_router.LlmRouterError):
        await llm_router.chat_probe(provider_id, "nope")  # type: ignore[arg-type]
    with pytest.raises(llm_router.LlmRouterError):
        await llm_router.chat_probe("missing", "dialog")


@pytest.mark.asyncio
async def test_chat_probe_requires_enabled_provider(router_config):
    """Выключенный провайдер — ошибка использования, модель не вызывается."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1", model="m1", enabled=False,
            api_key=None,
        )],
        {},
    )
    with pytest.raises(llm_router.LlmRouterError):
        await llm_router.chat_probe(state.providers[0].id, "role")


def test_chat_probe_route_and_422_without_echo(client, router_config, monkeypatch):
    """POST /chat-probe: ответ модели в контракте; неизвестный сценарий — 422 без эха ключа."""
    created = client.put(PREFIX, json={"providers": [_provider_payload()], "routes": {}})
    provider_id = created.json()["providers"][0]["id"]
    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(_ok_chat_handler))

    result = client.post(f"{PREFIX}/chat-probe", json={
        "provider_id": provider_id,
        "scenario": "insufficient",
    })
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["ok"] is True
    assert body["scenario"] == "insufficient"
    assert body["text"] == "готов"
    assert body["latency_ms"] is not None
    assert _TEST_KEY not in result.text
    assert "no-store" in result.headers["Cache-Control"]

    bad = client.post(f"{PREFIX}/chat-probe", json={
        "provider_id": provider_id,
        "scenario": "nope",
        "api_key": _TEST_KEY,
    })
    assert bad.status_code == 422
    assert _TEST_KEY not in bad.text


# ---------- список моделей через запятую (перебор пробами) ----------


def _model_aware_handler(request: httpx.Request) -> httpx.Response:
    """Ответ зависит от модели из тела: m-404 не существует, остальные отвечают."""
    model = json.loads(request.content)["model"]
    if model == "m-404":
        return httpx.Response(404, json={"error": {"message": f"модель не найдена {_TEST_KEY}"}})
    return httpx.Response(200, json={
        "choices": [{"message": {"content": f"из {model}"}}],
    })


@pytest.mark.asyncio
async def test_probe_iterates_model_list(router_config, monkeypatch):
    """Несколько моделей через запятую: проба перебирает каждую по отдельности."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-ok, m-404, m-ok2", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id
    assert state.providers[0].model == "m-ok, m-404, m-ok2"
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["model"])
        return _model_aware_handler(request)

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    result = await llm_router.probe(provider_id, "chat")
    assert seen == ["m-ok", "m-404", "m-ok2"]  # каждая модель — отдельный запрос
    assert [item.model for item in result.models] == ["m-ok", "m-404", "m-ok2"]
    assert [item.ok for item in result.models] == [True, False, True]
    assert result.ok is True  # ключ принят: провайдер ответил рабочими моделями
    assert result.model == "m-ok"  # сводка — первая успешная
    assert "m-404" in (result.error or "")
    assert _TEST_KEY not in (result.error or "")


@pytest.mark.asyncio
async def test_probe_all_models_failed_is_not_ok(router_config, monkeypatch):
    """Ни одна модель не ответила — проба честно не ok, ошибки в перечне."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-404, m-404b", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "Invalid model"}})

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    result = await llm_router.probe(provider_id, "chat")
    assert result.ok is False
    assert result.model is None
    assert "m-404" in (result.error or "") and "m-404b" in (result.error or "")


@pytest.mark.asyncio
async def test_chat_probe_iterates_model_list(router_config, monkeypatch):
    """Пробы советника (§10) идут перебором моделей: текст и задержка каждой."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-ok, m-404", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id
    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(_model_aware_handler))
    result = await llm_router.chat_probe(provider_id, "dialog")
    assert [item.model for item in result.models] == ["m-ok", "m-404"]
    assert result.models[0].ok is True
    assert result.models[0].text == "из m-ok"
    assert result.models[1].ok is False
    assert "Провайдер ответил 404" in (result.models[1].error or "")
    assert result.ok is False
    assert result.text == "из m-ok"  # сводка — ответ первой успешной модели


@pytest.mark.asyncio
async def test_chat_uses_first_model_of_list(router_config, monkeypatch):
    """Маршрут chat использует первую модель списка кандидатов."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-first, m-second", enabled=True,
            api_key=_TEST_KEY,
        )],
        {"chat": None},
    )
    provider_id = state.providers[0].id
    await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=provider_id, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-first, m-second", enabled=True,
            api_key=None,
        )],
        {"chat": provider_id},
    )
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["model"])
        return _model_aware_handler(request)

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    result = await llm_router.chat([{"role": "user", "content": "привет"}])
    assert seen == ["m-first"]
    assert result.model == "m-first"


def test_model_list_normalized_and_validated(client, router_config):
    """Список моделей через запятую: нормализация пустых элементов и отказ на мусор."""
    created = client.put(PREFIX, json={
        "providers": [_provider_payload(model=" m-a ,, m-b ")],
        "routes": {},
    })
    assert created.status_code == 200, created.text
    assert created.json()["providers"][0]["model"] == "m-a, m-b"

    bad = client.put(PREFIX, json={
        "providers": [_provider_payload(model=" , ")],
        "routes": {},
    })
    assert bad.status_code == 400
    assert "модели" in bad.json()["detail"]


def test_long_model_list_is_accepted(client, router_config):
    """Список моделей длиннее прежних 120 символов сохраняется (случай 23.11.2026)."""
    models = [
        "route-llm",
        "route-llm-code",
        "gemini-decision-1",
        "abacusai/Smaug-Flash",
        "route-llm-code-low",
        "claude-sonnet-4-5-20250929",
        "deepseek-ai/DeepSeek-V4-Pro-0813",
    ]
    raw = ", ".join(models)
    assert len(raw) > 120
    result = client.put(PREFIX, json={
        "providers": [_provider_payload(model=raw)],
        "routes": {},
    })
    assert result.status_code == 200, result.text
    assert result.json()["providers"][0]["model"] == raw


def test_model_list_too_long_is_russian_400(client, router_config):
    """Список моделей сверх предела — русский 400, а не английский 422 схемы."""
    raw = ", ".join(["m" * 150] * 10)
    result = client.put(PREFIX, json={
        "providers": [_provider_payload(model=raw)],
        "routes": {},
    })
    assert result.status_code == 400
    assert "Слишком длинный список моделей" in result.json()["detail"]


# ---------- выбор модели маршрута chat (chat_model) ----------


@pytest.mark.asyncio
async def test_chat_model_route_picks_selected_model(router_config, monkeypatch):
    """Модель маршрута chat выбирается из списка: chat() работает именно ей."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-first, m-second", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id
    await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=provider_id, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-first, m-second", enabled=True,
            api_key=None,
        )],
        {"chat": provider_id, "chat_model": "m-second"},
    )
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["model"])
        return _model_aware_handler(request)

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    result = await llm_router.chat([{"role": "user", "content": "привет"}])
    assert seen == ["m-second"]
    assert result.model == "m-second"


@pytest.mark.asyncio
async def test_chat_explicit_provider_model_override(router_config, monkeypatch):
    """Назначение модели роли переопределяет маршрут, чужая модель не подменяется."""
    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-first, m-second", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    provider_id = state.providers[0].id
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content)["model"])
        return _model_aware_handler(request)

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    result = await llm_router.chat(
        [{"role": "user", "content": "привет"}],
        provider_id=provider_id, model="m-first",
    )
    assert result.model == "m-first"
    assert seen == ["m-first"]
    with pytest.raises(llm_router.LlmRouterError, match="не входит в список"):
        await llm_router.chat(
            [{"role": "user", "content": "привет"}],
            provider_id=provider_id, model="m-unknown",
        )


def test_chat_model_route_validation(client, router_config):
    """Модель маршрута chat: только из списка провайдера и только с провайдером."""
    orphan = client.put(PREFIX, json={
        "providers": [_provider_payload(model="m-a, m-b")],
        "routes": {"chat": None, "chat_model": "m-b"},
    })
    assert orphan.status_code == 400
    assert "провайдера" in orphan.json()["detail"]

    created = client.put(PREFIX, json={
        "providers": [_provider_payload(model="m-a, m-b")],
        "routes": {},
    })
    provider_id = created.json()["providers"][0]["id"]

    bad = client.put(PREFIX, json={
        "providers": [_provider_payload(id=provider_id, model="m-a, m-b", api_key=None)],
        "routes": {"chat": provider_id, "chat_model": "m-x"},
    })
    assert bad.status_code == 400
    assert "список моделей" in bad.json()["detail"]

    good = client.put(PREFIX, json={
        "providers": [_provider_payload(id=provider_id, model="m-a, m-b", api_key=None)],
        "routes": {"chat": provider_id, "chat_model": "m-b"},
    })
    assert good.status_code == 200, good.text
    assert good.json()["routes"] == {
        "chat": provider_id,
        "chat_model": "m-b",
        "transcribe": None,
    }


# ---------- thinking-модели: рассуждение, бюджет токенов, обрезка ----------


@pytest.mark.asyncio
async def test_chat_probe_reports_reasoning_and_truncation(router_config, monkeypatch):
    """Пустой content при reasoning/бюджете — честные ошибки; обрезка — флаг truncated."""

    def thinking_handler(request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        if model == "m-think":  # бюджет ушёл на рассуждение, итог пуст
            return httpx.Response(200, json={
                "choices": [{
                    "finish_reason": "length",
                    "message": {"content": "", "reasoning_content": "А" * 500},
                }],
            })
        if model == "m-reason":  # только рассуждение, стоп штатный
            return httpx.Response(200, json={
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"content": None, "reasoning": "Б" * 300},
                }],
            })
        if model == "m-empty":  # пусто и без рассуждения
            return httpx.Response(200, json={
                "choices": [{"finish_reason": "stop", "message": {"content": ""}}],
            })
        return httpx.Response(200, json={  # текст есть, но обрезан по бюджету
            "choices": [{
                "finish_reason": "length",
                "message": {"content": "част"},
            }],
        })

    state = await llm_router.apply_update(
        [llm_router.ProviderDraft(
            id=None, label="P", protocol="openai",
            base_url="https://api.example.com/v1",
            model="m-think, m-reason, m-empty, m-cut", enabled=True,
            api_key=_TEST_KEY,
        )],
        {},
    )
    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(thinking_handler))
    result = await llm_router.chat_probe(state.providers[0].id, "role")
    by_model = {item.model: item for item in result.models}

    think = by_model["m-think"]
    assert think.ok is False
    assert "бюджет" in (think.error or "").lower()
    assert "500" in (think.error or "")  # размер рассуждения в тексте ошибки

    reason = by_model["m-reason"]
    assert reason.ok is False
    assert "рассуждение" in (reason.error or "")

    empty = by_model["m-empty"]
    assert empty.ok is False
    assert "пустой ответ" in (empty.error or "")

    cut = by_model["m-cut"]
    assert cut.ok is True
    assert cut.text == "част"
    assert cut.truncated is True  # обрезка видна, а не «тихий» обрыв текста

    assert result.ok is False
    assert result.model == "m-cut"  # сводка — по первой успешной модели
    assert result.truncated is True


def test_extract_completion_truncation_flags():
    """Признак обрезки: finish_reason=length / stop_reason=max_tokens — truncated."""
    text, truncated = llm_router._extract_completion(
        "openai",
        {"choices": [{"finish_reason": "length", "message": {"content": "част"}}]},
    )
    assert (text, truncated) == ("част", True)
    text, truncated = llm_router._extract_completion(
        "anthropic",
        {"content": [{"text": "част"}], "stop_reason": "max_tokens"},
    )
    assert (text, truncated) == ("част", True)
    text, truncated = llm_router._extract_completion(
        "openai",
        {"choices": [{"finish_reason": "stop", "message": {"content": "целиком"}}]},
    )
    assert (text, truncated) == ("целиком", False)


# ---------- стриминг ответа (срез 0011) ----------


def _sse_body(frames: list[dict]) -> bytes:
    """Тело SSE-ответа провайдера: фреймы `data:` + завершающий [DONE]."""
    lines = [f"data: {json.dumps(frame)}\n" for frame in frames]
    lines.append("data: [DONE]\n")
    return "".join(lines).encode("utf-8")


async def _chat_state() -> llm_router.RouterState:
    provider = llm_router.Provider(
        id="prov", label="P", protocol="openai",
        base_url="https://api.example.com/v1", model="m1",
        enabled=True, api_key=_TEST_KEY,
    )
    return llm_router.RouterState(
        providers=(provider,), routes={"chat": "prov", "chat_model": None, "transcribe": None},
    )


@pytest.mark.asyncio
async def test_chat_stream_openai_deltas(monkeypatch):
    """Стрим openai: дельты уходят в on_delta и складываются в текст без обрезки."""
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, content=_sse_body([
            {"choices": [{"delta": {"content": "При"}}]},
            {"choices": [{"delta": {"content": " вет"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        ]))

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    monkeypatch.setattr(llm_router, "get_state", _chat_state)
    seen: list[str] = []
    result = await llm_router.chat(
        [{"role": "user", "content": "привет"}], on_delta=seen.append,
    )

    assert bodies[0]["stream"] is True
    assert seen == ["При", " вет"]
    assert result.text == "При вет"
    assert result.truncated is False


@pytest.mark.asyncio
async def test_chat_stream_anthropic_deltas(monkeypatch):
    """Стрим anthropic: content_block_delta → дельты, message_delta → stop_reason."""
    async def anthropic_state() -> llm_router.RouterState:
        provider = llm_router.Provider(
            id="prov", label="P", protocol="anthropic",
            base_url="https://api.example.com", model="m1",
            enabled=True, api_key=_TEST_KEY,
        )
        return llm_router.RouterState(
            providers=(provider,), routes={"chat": "prov", "chat_model": None, "transcribe": None},
        )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-api-key") == _TEST_KEY
        return httpx.Response(200, content=_sse_body([
            {"type": "message_start", "message": {}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "раз"}},
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "-два"}},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
        ]))

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    monkeypatch.setattr(llm_router, "get_state", anthropic_state)
    seen: list[str] = []
    result = await llm_router.chat(
        [{"role": "user", "content": "привет"}], on_delta=seen.append,
    )

    assert seen == ["раз", "-два"]
    assert result.text == "раз-два"
    assert result.truncated is False


@pytest.mark.asyncio
async def test_chat_stream_reasoning_only_is_honest(monkeypatch):
    """Стрим с одним рассуждением thinking-модели — честная ошибка, не пустота."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_sse_body([
            {"choices": [{"delta": {"reasoning_content": "думаю-думаю"}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]},
        ]))

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    monkeypatch.setattr(llm_router, "get_state", _chat_state)
    with pytest.raises(llm_router.LlmRouterError, match="рассуждении"):
        await llm_router.chat(
            [{"role": "user", "content": "привет"}], on_delta=lambda _: None,
        )


@pytest.mark.asyncio
async def test_chat_stream_http_error_is_honest(monkeypatch):
    """Ошибка провайдера в стриме честная и без ключа в тексте."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"message": f"oops {_TEST_KEY}"}})

    monkeypatch.setattr(llm_router, "_client", lambda: _mock_client(handler))
    monkeypatch.setattr(llm_router, "get_state", _chat_state)
    with pytest.raises(llm_router.LlmRouterError) as excinfo:
        await llm_router.chat(
            [{"role": "user", "content": "привет"}], on_delta=lambda _: None,
        )
    assert "Провайдер ответил 500" in str(excinfo.value)
    assert _TEST_KEY not in str(excinfo.value)


# ---------- каталог RouteLLM ----------

_CATALOG = {
    "abacus": {
        "id": "abacus",
        "api": "https://routellm.abacus.ai/v1",
        "models": {
            "claude-opus-4-6": {
                "id": "claude-opus-4-6",
                "name": "Claude Opus 4.6",
                "modalities": {"input": ["text", "image"], "output": ["text"]},
                "limit": {"context": 1_000_000, "output": 128_000},
                "cost": {"input": 5, "output": 25},
                "reasoning": True,
                "tool_call": True,
            },
        },
    },
}


def _catalog_handler(request: httpx.Request) -> httpx.Response:
    """MockTransport: /models провайдера и публичный каталог models.dev."""
    if "models.dev" in str(request.url):
        return httpx.Response(200, json=_CATALOG)
    assert request.headers.get("Authorization") == f"Bearer {_TEST_KEY}"
    return httpx.Response(200, json={"data": [{"id": "claude-opus-4-6"}]})


def _create_routellm(client, **overrides) -> str:
    payload = _provider_payload(
        label="RouteLLM",
        base_url="https://routellm.abacus.ai/v1",
        model="claude-opus-4-6",
    )
    payload.update(overrides)
    created = client.put(PREFIX, json={"providers": [payload], "routes": {}})
    assert created.status_code == 200, created.text
    return created.json()["providers"][0]["id"]


def test_routellm_models_enriches_from_catalog(client, router_config, catalog_cache, monkeypatch):
    """Каталог: модель провайдера дополнена стоимостью, модальностями и лимитами."""
    provider_id = _create_routellm(client)
    monkeypatch.setattr(
        routellm_catalog, "_client", lambda: _mock_client(_catalog_handler),
    )
    result = client.get(f"{PREFIX}/routellm/models", params={"provider_id": provider_id})
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["provider_label"] == "RouteLLM"
    model = body["models"][0]
    assert model["id"] == "claude-opus-4-6"
    assert model["source"] == "both"
    assert model["context"] == 1_000_000
    assert model["output"] == 128_000
    assert model["cost_input"] == 5.0
    assert model["cost_output"] == 25.0
    assert model["modalities_input"] == ["text", "image"]
    assert model["reasoning"] is True
    assert body["credits"]["available"] is False
    assert "Billing" in body["credits"]["note"]
    assert body["credits"]["billing_url"].startswith("https://abacus.ai/")
    assert _TEST_KEY not in result.text


def test_routellm_models_catalog_unavailable_warns(
    client, router_config, catalog_cache, monkeypatch,
):
    """models.dev недоступен: честное предупреждение, поля провайдера сохранены."""
    provider_id = _create_routellm(client)

    def handler(request: httpx.Request) -> httpx.Response:
        if "models.dev" in str(request.url):
            return httpx.Response(503, text="down")
        return httpx.Response(200, json={"data": [{"id": "claude-opus-4-6"}]})

    monkeypatch.setattr(routellm_catalog, "_client", lambda: _mock_client(handler))
    result = client.get(f"{PREFIX}/routellm/models", params={"provider_id": provider_id})
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["models"][0]["source"] == "provider"
    assert any("models.dev" in item for item in body["warnings"])


def test_routellm_models_requires_key_and_enabled(client, router_config, catalog_cache):
    """Без ключа и у выключенного провайдера каталог не запрашивается."""
    no_key = _create_routellm(client, api_key="")
    result = client.get(f"{PREFIX}/routellm/models", params={"provider_id": no_key})
    assert result.status_code == 400
    assert "ключ" in result.json()["detail"]

    disabled = _create_routellm(client, enabled=False)
    result = client.get(f"{PREFIX}/routellm/models", params={"provider_id": disabled})
    assert result.status_code == 400
    assert "выключен" in result.json()["detail"]


def test_routellm_models_provider_error_sanitized(
    client, router_config, catalog_cache, monkeypatch,
):
    """Ошибка провайдера не эхом отдаёт ключ API."""
    provider_id = _create_routellm(client)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text=f"bad key {_TEST_KEY}")

    monkeypatch.setattr(routellm_catalog, "_client", lambda: _mock_client(handler))
    result = client.get(f"{PREFIX}/routellm/models", params={"provider_id": provider_id})
    assert result.status_code == 502
    assert _TEST_KEY not in result.text
    assert "401" in result.json()["detail"]