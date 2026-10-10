"""Модельный роутер ИИ: хранение провайдеров, маскирование ключей, probe и chat.

Тесты идут на своей tmp-настройке: ``llm_router_config_path`` перенаправляется
в tmp_path, внешние вызовы подменяются ``httpx.MockTransport`` — сеть и
реальные провайдеры не используются.
"""

import json

import httpx
import pytest

from app.core.config import settings
from app.services import llm_router

PREFIX = "/api/v1/llm-router"
_TEST_KEY = "sk-secret-1234"


@pytest.fixture()
def router_config(tmp_path, monkeypatch):
    """Файл настроек роутера — в tmp_path: рабочий data/llm_router.json не трогаем."""
    path = tmp_path / "llm_router.json"
    monkeypatch.setattr(settings, "llm_router_config_path", str(path))
    return path


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
        "routes": {"chat": None, "transcribe": None},
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