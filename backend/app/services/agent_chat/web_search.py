"""Веб-поиск Архивариуса и машинный перевод найденного на русский.

Поиск — HTML-выдача DuckDuckGo (ключ не нужен), разбор стандартной библиотекой
``HTMLParser``. Перевод — отдельный явный шаг через модельный роутер: каждый
заголовок и фрагмент переводятся отдельным вызовом, ошибки пофреймовые и
честные. Запрос уходит поисковику, текст — провайдеру модели; материалы дела
автоматически не отправляются (правила — ``docs/rules/consilium.md`` §0.10).
"""

from __future__ import annotations

import asyncio
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx

from app.core.config import settings
from app.services import llm_router
from app.services.agent_chat.roles import AgentChatError

_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_TRANSLATE_PROMPT = (
    "Переведи на русский язык заголовок и фрагмент найденного материала. "
    "Не добавляй пояснений и не сокращай смысл; сохрани имена, числа и ссылки. "
    "Ответь ровно двумя строками:\n"
    "ЗАГОЛОВОК: <перевод заголовка>\n"
    "ФРАГМЕНТ: <перевод фрагмента>\n\n"
    "Заголовок: {title}\nФрагмент: {snippet}"
)
_TITLE_RE = re.compile(r"^\s*ЗАГОЛОВОК\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_SNIPPET_RE = re.compile(r"^\s*ФРАГМЕНТ\s*:\s*(.+)$", re.IGNORECASE | re.MULTILINE)


def _client() -> httpx.AsyncClient:
    """HTTP-клиент поиска (тесты подменяют на MockTransport)."""
    return httpx.AsyncClient(
        timeout=settings.agent_web_search_timeout_s,
        follow_redirects=True,
        headers={"User-Agent": _USER_AGENT},
    )


def _decode_url(href: str) -> str:
    """Развернуть редирект DuckDuckGo ``/l/?uddg=...`` в исходный адрес."""
    if not href:
        return ""
    if href.startswith("//"):
        href = f"https:{href}"
    parsed = urlparse(href)
    if parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg")
        if target:
            return unquote(target[0])
    return href


class _DuckParser(HTMLParser):
    """Разбор HTML-выдачи DuckDuckGo: заголовок-ссылка и следующий фрагмент."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self._mode: str | None = None
        self._href = ""
        self._buffer: list[str] = []
        self._current: dict[str, str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """Начало ссылки результата или фрагмента — сброс предыдущего буфера."""
        if tag != "a":
            return
        values = dict(attrs)
        classes = (values.get("class") or "").split()
        if "result__a" in classes:
            self._flush()
            self._mode = "title"
            self._href = values.get("href") or ""
            self._buffer = []
        elif "result__snippet" in classes:
            self._flush()
            self._mode = "snippet"
            self._buffer = []

    def handle_data(self, data: str) -> None:
        """Текст внутри выбранной ссылки."""
        if self._mode:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        """Конец ссылки закрывает текущий фрагмент."""
        if tag == "a" and self._mode:
            self._flush()

    def close(self) -> None:
        """Закрыть парсер, дописав последний фрагмент."""
        super().close()
        self._flush()

    def _flush(self) -> None:
        """Сохранить накопленный заголовок или фрагмент."""
        if not self._mode:
            return
        text = " ".join("".join(self._buffer).split())
        if self._mode == "title":
            url = _decode_url(self._href)
            self._current = {"title": text, "url": url, "snippet": ""}
            if text and url.startswith("http"):
                self.results.append(self._current)
        elif self._mode == "snippet" and self._current is not None:
            self._current["snippet"] = text
        self._mode = None
        self._buffer = []


def parse_results(html: str, limit: int) -> list[dict[str, str]]:
    """Разобрать HTML-выдачу в список ``{title, url, snippet}`` без дублей."""
    parser = _DuckParser()
    parser.feed(html)
    parser.close()
    seen: set[str] = set()
    results: list[dict[str, str]] = []
    for item in parser.results:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        results.append(item)
        if len(results) >= limit:
            break
    return results


async def search(
    query: str,
    *,
    limit: int | None = None,
    client: httpx.AsyncClient | None = None,
) -> tuple[list[dict[str, str]], str]:
    """Найти материалы в интернете; пустая выдача — не ошибка, а честный ноль."""
    count = limit or settings.agent_web_search_limit
    own_client = client is None
    http = client or _client()
    try:
        try:
            response = await http.post(
                settings.agent_web_search_url,
                data={"q": query},
            )
        except httpx.HTTPError as exc:
            raise AgentChatError(
                502, f"Поисковик недоступен: {str(exc)[:200]}",
            ) from None
        if response.status_code >= 400:
            raise AgentChatError(
                502, f"Поисковик ответил {response.status_code} — попробуйте позже",
            )
        return parse_results(response.text, count), "duckduckgo"
    finally:
        if own_client:
            await http.aclose()


def _parse_translation(text: str) -> tuple[str | None, str | None]:
    """Разобрать две строки перевода; нераспознанное — целиком во фрагмент."""
    title = _TITLE_RE.search(text)
    snippet = _SNIPPET_RE.search(text)
    if title or snippet:
        return (
            title.group(1).strip() if title else None,
            snippet.group(1).strip() if snippet else None,
        )
    cleaned = " ".join(text.split())
    return None, cleaned or None


async def _translate_one(
    item: dict[str, str],
    *,
    provider_id: str | None,
    model: str | None,
    client: httpx.AsyncClient | None,
) -> dict[str, str | None]:
    """Перевод одного материала; ошибка не роняет остальные."""
    prompt = _TRANSLATE_PROMPT.format(
        title=item.get("title", ""), snippet=item.get("snippet", ""),
    )
    try:
        result = await llm_router.chat(
            [{"role": "user", "content": prompt}],
            max_tokens=settings.agent_web_search_translate_max_tokens,
            provider_id=provider_id,
            model=model,
            client=client,
        )
    except Exception as exc:
        return {
            **item, "title_ru": None, "snippet_ru": None,
            "error": str(exc) or type(exc).__name__,
        }
    title_ru, snippet_ru = _parse_translation(result.text or "")
    if not title_ru and not snippet_ru:
        return {
            **item, "title_ru": None, "snippet_ru": None,
            "error": "Модель вернула пустой перевод",
        }
    return {**item, "title_ru": title_ru, "snippet_ru": snippet_ru, "error": None}


async def translate(
    results: list[dict[str, Any]],
    *,
    provider_id: str | None = None,
    model: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, Any]]:
    """Перевести материалы на русский параллельно (не больше четырёх вызовов)."""
    if not results:
        return []
    if provider_id is None:
        state = await llm_router.get_state()
        if state.routes.get("chat") is None:
            raise AgentChatError(
                400, "Маршрут chat не назначен — перевод недоступен (настройки роутера)",
            )
    semaphore = asyncio.Semaphore(4)

    async def one(item: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            return await _translate_one(
                {key: str(value or "") for key, value in item.items()},
                provider_id=provider_id, model=model, client=client,
            )

    return list(await asyncio.gather(*(one(item) for item in results)))
