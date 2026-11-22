"""Поиск по библиотеке знаний: TF-IDF всегда, эмбеддинги — когда доступны.

Лексический поиск работает без сети (``scikit-learn`` уже в зависимостях) и
служит честным основанием: если провайдер эмбеддингов недоступен, поиск не
падает, а возвращает TF-IDF-результаты с пометкой режима. Семантический
поиск — косинус между вектором запроса и векторами фрагментов.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import httpx

from app.core.config import settings
from app.services import llm_router


@dataclass(frozen=True)
class SearchHit:
    """Найденный фрагмент: документ, номер, заголовок, текст и оценка."""

    chunk_id: str
    document_id: str
    ordinal: int
    heading: str | None
    page_from: int | None
    text: str
    score: float


def _tfidf_scores(query: str, texts: list[str]) -> list[float]:
    """Косинус TF-IDF запроса к каждому тексту; пустой запрос — нули."""
    if not texts or not query.strip():
        return [0.0] * len(texts)
    from sklearn.feature_extraction.text import TfidfVectorizer

    vectorizer = TfidfVectorizer(
        lowercase=True,
        ngram_range=(1, 2),
        sublinear_tf=True,
        min_df=1,
    )
    try:
        matrix = vectorizer.fit_transform([query, *texts])
    except ValueError:
        return [0.0] * len(texts)
    query_vector = matrix[0]
    scores: list[float] = []
    for row in range(1, matrix.shape[0]):
        scores.append(float(query_vector.multiply(matrix[row]).sum()))
    return scores


def cosine(left: list[float], right: list[float]) -> float:
    """Косинус двух векторов; нулевой вектор даёт 0."""
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    norm_left = math.sqrt(sum(a * a for a in left))
    norm_right = math.sqrt(sum(b * b for b in right))
    if norm_left == 0 or norm_right == 0:
        return 0.0
    return dot / (norm_left * norm_right)


async def _embedding_provider() -> tuple[llm_router.Provider, str] | None:
    """Провайдер и модель эмбеддингов: явная настройка или маршрут ``chat``."""
    state = await llm_router.get_state()
    provider_id = state.routes.get("chat")
    if provider_id is None:
        return None
    try:
        provider = next(p for p in state.providers if p.id == provider_id)
    except StopIteration:
        return None
    if not provider.enabled:
        return None
    model = settings.knowledge_embedding_model or provider.model.split(",")[0].strip()
    if not model:
        return None
    return provider, model


async def embed_texts(
    texts: list[str],
    *,
    client: httpx.AsyncClient | None = None,
) -> list[list[float]] | None:
    """Векторы текстов через ``POST {base_url}/embeddings``; None — недоступно.

    Недоступность провайдера, ошибка ответа или неожиданная форма данных —
    ``None``: вызывающий код остаётся на TF-IDF и честно сообщает режим.
    """
    if not texts:
        return []
    resolved = await _embedding_provider()
    if resolved is None:
        return None
    provider, model = resolved
    own = client is None
    http = client or llm_router._client()
    vectors: list[list[float]] = []
    batch = settings.knowledge_embedding_batch
    try:
        for start in range(0, len(texts), batch):
            part = texts[start : start + batch]
            response = await http.post(
                f"{provider.base_url.rstrip('/')}/embeddings",
                headers={
                    "Authorization": f"Bearer {provider.api_key or ''}",
                    "Content-Type": "application/json",
                },
                json={"model": model, "input": part},
            )
            if response.status_code >= 400:
                return None
            data = response.json()
            rows = data.get("data")
            if not isinstance(rows, list) or len(rows) != len(part):
                return None
            for row in rows:
                vector = row.get("embedding") if isinstance(row, dict) else None
                if not isinstance(vector, list) or not vector:
                    return None
                vectors.append([float(value) for value in vector])
    except (httpx.HTTPError, ValueError, TypeError):
        return None
    finally:
        if own:
            await http.aclose()
    return vectors


def rank(
    query: str,
    rows: list[tuple[str, str, int, str | None, int | None, str, list[float] | None]],
    *,
    query_vector: list[float] | None,
    limit: int,
) -> tuple[list[SearchHit], str]:
    """Смешивает TF-IDF и косинус эмбеддингов; возвращает хиты и режим поиска.

    ``rows`` — ``(chunk_id, document_id, ordinal, heading, page_from, text,
    embedding)``. Режим ``hybrid`` — есть векторы запроса и фрагментов,
    ``tfidf`` — только лексика (провайдер эмбеддингов недоступен).
    """
    texts = [row[5] for row in rows]
    lexical = _tfidf_scores(query, texts)
    has_vectors = query_vector is not None and any(row[6] for row in rows)
    hits: list[SearchHit] = []
    for index, row in enumerate(rows):
        semantic = 0.0
        if has_vectors and row[6]:
            semantic = cosine(query_vector or [], row[6] or [])
        score = 0.5 * lexical[index] + 0.5 * semantic if has_vectors else lexical[index]
        if score <= 0:
            continue
        hits.append(
            SearchHit(
                chunk_id=row[0],
                document_id=row[1],
                ordinal=row[2],
                heading=row[3],
                page_from=row[4],
                text=row[5],
                score=round(score, 6),
            ),
        )
    hits.sort(key=lambda hit: hit.score, reverse=True)
    return hits[:limit], "hybrid" if has_vectors else "tfidf"
