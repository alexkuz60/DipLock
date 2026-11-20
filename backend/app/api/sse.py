"""Кадры SSE из RAM-журнала стриминга ответов моделей (общие для Консилиума и чата)."""

import asyncio
from collections.abc import AsyncIterator

from app.schemas.consilium import ConsiliumStreamEvent
from app.services.consilium import streams

_SSE_PING_S = 15.0


def sse_frame(event: ConsiliumStreamEvent) -> str:
    """Один фрейм SSE: тип события и JSON-данные (без обрезки дельт)."""
    return f"event: {event.type}\ndata: {event.model_dump_json()}\n\n"


async def stream_frames(progress: streams.RoundProgress | None) -> AsyncIterator[str]:
    """Кадры SSE из журнала потока (механизм 0011); позднему подписчику — round_done."""
    if progress is None:
        yield sse_frame(ConsiliumStreamEvent(type="round_done"))
        return
    sent = 0
    while True:
        progress.changed.clear()
        while sent < len(progress.log):
            yield sse_frame(progress.log[sent])
            sent += 1
        if progress.finished:
            if progress.error:
                yield sse_frame(ConsiliumStreamEvent(type="error", error=progress.error))
            yield sse_frame(
                ConsiliumStreamEvent(type="round_done", error=progress.error),
            )
            return
        try:
            await asyncio.wait_for(progress.changed.wait(), timeout=_SSE_PING_S)
        except TimeoutError:
            yield sse_frame(ConsiliumStreamEvent(type="ping"))
