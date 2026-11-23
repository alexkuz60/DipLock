"""Контракт SSE-потока ответов ролевых агентов (``docs/rules/consilium.md`` §0.9).

Событие одно на все потоки: ``role_started``/``delta``/``role_done``/``error``/
``ping``; ``round_done`` закрывает поток. Модуль общий: его читают
``api/agent_chat.py`` и ``services/streams.py``.
"""

from typing import Literal

from pydantic import BaseModel

StreamEventType = Literal["role_started", "delta", "role_done", "round_done", "error", "ping"]
StreamRoleStatus = Literal["waiting", "streaming", "done", "failed"]


class StreamEvent(BaseModel):
    """Событие SSE-стрима: один фрейм `event:` + JSON.

    Обычный ``BaseModel`` (без ``str_strip_whitespace``): ``delta`` — кусочек
    текста как есть, обрезка краёв исказила бы склейку потока. Поля заполняются
    по типу события: ``delta`` — только у ``delta``, ``status`` — у смены
    состояния роли (``role_started``/``role_done``); ``error`` перед завершением
    потока закрывает его, поздних дельт после него нет.
    """

    type: StreamEventType
    role: str | None = None
    delta: str | None = None
    model: str | None = None
    status: StreamRoleStatus | None = None
    error: str | None = None
