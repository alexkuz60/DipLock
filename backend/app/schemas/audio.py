"""Контракт «Нейромузыки»: POST /audio/render, статус рендера, sidecar.

Рендер — экспериментальный синхронный процесс с **in-memory статусом** (ТЗ
фазы 1: без журнала/кэшей/БД): ``POST`` запускает рендер и возвращает
``render_id``, клиент поллит статус (проценты по трекам) и забирает WAV и
sidecar по отдельным GET. Состояния живут в памяти процесса и убираются по
TTL — история и очередь задач тут не участвуют.
"""
from typing import Literal

from pydantic import BaseModel, Field

from app.services.audio_render.loudness import (
    LOUDNESS_PHON_DEFAULT,
    LOUDNESS_PHON_MAX,
    LOUDNESS_PHON_MIN,
)
from app.services.audio_render.mix import (
    BOOST_DEFAULT_DB,
    BOOST_MAX_DB,
    BOOST_MIN_DB,
    GAIN_MAX_DB,
    GAIN_MIN_DB,
)

AudioRenderState = Literal["running", "succeeded", "failed"]


class AudioRenderRequest(BaseModel):
    """Тело ``POST /api/v1/audio/render``: запись, гейны, boost, психоакустика."""

    recording_id: str = Field(description="Идентификатор записи из реестра просмотра")
    gains_db: dict[str, float] = Field(
        default_factory=dict,
        description=(
            f"Пользовательские гейны полос, dB (ключи — freq_bands); "
            f"диапазон {GAIN_MIN_DB:g}…{GAIN_MAX_DB:g}, по умолчанию 0"
        ),
    )
    boost_db: float = Field(
        default=BOOST_DEFAULT_DB,
        description=(
            f"Базовое усиление полосовых стерео-треков, dB (целевой RMS "
            f"−18 + boost); диапазон {BOOST_MIN_DB:g}…{BOOST_MAX_DB:g}, "
            f"по умолчанию {BOOST_DEFAULT_DB:g} (приёмка 05.10.2026)"
        ),
    )
    loudness_phon: float | None = Field(
        default=LOUDNESS_PHON_DEFAULT,
        description=(
            "Опорный уровень психоакустической компенсации ISO 226:2003, фон — "
            "статические смещения целевого RMS полос для равной субъективной "
            f"громкости; диапазон {LOUDNESS_PHON_MIN:g}…{LOUDNESS_PHON_MAX:g}, "
            f"по умолчанию {LOUDNESS_PHON_DEFAULT:g}; null — выключить "
            "(чистый RMS без поправок)"
        ),
    )
    loudness_autobase: bool = Field(
        default=True,
        description=(
            "Стратегия A: при включённой компенсации база рендера ограничивается "
            "потолком «ямы» (θ/α/β выравниваются по перцептиву, boost срезается "
            "до запаса потолка); false — «максимум громкости» (база −18+boost, "
            "треки crest-limited)"
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
