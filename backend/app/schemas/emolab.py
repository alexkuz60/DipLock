"""Контракт API «ЕмоЛаб»: анализ внешнего аудиотрека (шаг 1, 20.10.2026).

Кадры «Эмо» (ФФТ-лучи + карты темпа/аккордов) отдаются существующим
контрактом ``AudioEmoOut`` (``schemas/audio.py``) — тот же payload, что у
рендера «Нейромузыки», чтобы фронтенд-звезда-полигон переиспользовался без
правок. Здесь только жизненный цикл анализа: старт и статус поллинга
(по образцу ``AudioRenderStart``/``AudioRenderStatus``).
"""
from typing import Literal

from pydantic import BaseModel, Field

# Статусы анализа трека (те же, что у рендера, — единый язык UI).
EmoTrackStatusName = Literal["running", "succeeded", "failed"]


class EmoAnalyzeOut(BaseModel):
    """Ответ ``POST /emolab/analyze`` (202): анализ запущен либо уже посчитан."""

    track_id: str = Field(
        description="Идентификатор трека: sha256 содержимого файла (хвост 32 символов)",
    )
    status: EmoTrackStatusName = "running"
    cached: bool = Field(
        default=False,
        description=(
            "true — результат взят из дискового кэша (тот же файл уже "
            "проанализирован), расчёт не запускался, status сразу succeeded"
        ),
    )
    filename: str = Field(
        default="", description="Имя исходного файла (как загрузил пользователь)",
    )
    duration_s: float = Field(
        gt=0.0, description="Длительность трека, с (из заголовка файла)",
    )


class EmoTrackStatus(BaseModel):
    """``GET /emolab/{track_id}/status``: проценты и шаг анализа (поллинг UI)."""

    track_id: str
    status: EmoTrackStatusName
    stage: str = Field(description="Текущий шаг, например «Карта темпа (VAMP)»")
    pct: float = Field(ge=0.0, le=1.0, description="Готовность 0..1")
    message: str = ""
    error: str | None = Field(default=None, description="Текст ошибки (status=failed)")
    filename: str = ""
    duration_s: float | None = Field(
        default=None,
        description="Длительность трека, с (из манифеста кэша; null пока идёт анализ)",
    )