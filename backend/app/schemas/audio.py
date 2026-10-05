"""Контракт «Нейромузыки»: POST /audio/render, статус рендера, sidecar.

Рендер — экспериментальный синхронный процесс с **in-memory статусом** (ТЗ
фазы 1: без журнала/кэшей/БД): ``POST`` запускает рендер и возвращает
``render_id``, клиент поллит статус (проценты по трекам) и забирает WAV и
sidecar по отдельным GET. Состояния живут в памяти процесса и убираются по
TTL — история и очередь задач тут не участвуют.
"""
from typing import Literal

from pydantic import BaseModel, Field

from app.services.audio_render.mix import GAIN_MAX_DB, GAIN_MIN_DB

AudioRenderState = Literal["running", "succeeded", "failed"]


class AudioRenderRequest(BaseModel):
    """Тело ``POST /api/v1/audio/render``: запись и гейны полос (ТЗ M4)."""

    recording_id: str = Field(description="Идентификатор записи из реестра просмотра")
    gains_db: dict[str, float] = Field(
        default_factory=dict,
        description=(
            f"Пользовательские гейны полос, dB (ключи — freq_bands); "
            f"диапазон {GAIN_MIN_DB:g}…{GAIN_MAX_DB:g}, по умолчанию 0"
        ),
    )


class AudioRenderStart(BaseModel):
    """Ответ ``POST /audio/render`` (202): рендер запущен, поллите статус."""

    render_id: str
    status: AudioRenderState = "running"


class AudioRenderStatus(BaseModel):
    """``GET /audio/render/{id}/status``: проценты и шаг пайплайна (ТЗ M5)."""

    render_id: str
    status: AudioRenderState
    stage: str = Field(description="Текущий шаг, например «Полоса alpha (3/7)»")
    pct: float = Field(ge=0.0, le=1.0, description="Готовность 0..1")
    message: str = ""
    error: str | None = Field(default=None, description="Текст ошибки (status=failed)")
    tracks: list[str] = Field(default_factory=list, description="Готовые треки (после успеха)")
