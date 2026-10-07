"""Контракт «Нейромузыки»: POST /audio/render, статус рендера, список готовых, sidecar.

Рендер — синхронный процесс со статусом в памяти: ``POST`` запускает рендер
(либо мгновенно отдаёт кэш-попадание — поле ``cached``) и возвращает
``render_id``, клиент поллит статус (проценты по трекам) и забирает WAV и
sidecar по отдельным GET. Готовые артефакты живут на диске
(``services/audio_render/store.py``): статус переживает TTL памяти и
рестарт сервера, повторный POST тех же параметров не пересчитывает.
Список готовых рендеров записи — ``GET /audio/renders`` (дисковый манифест).
"""
from typing import Literal

from pydantic import BaseModel, Field

from app.services.audio_render.core import PITCH_STEPS
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


class AudioRenderParams(BaseModel):
    """Параметры рендера: тело POST (с ``recording_id``) и эхо в манифесте списка."""

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
    octave_shift: int = Field(
        default=PITCH_STEPS,
        description=(
            "Транспонирование партитуры, октав (5/6/7 → ×32/×64/×128, дефолт "
            f"{PITCH_STEPS}): число квадратов фазы ядра; выбор 5/6/7 — "
            "эксперимент 06.10.2026, невалидное значение — 400"
        ),
    )
    variant: str = Field(
        default="express",
        description=(
            "Вариант рендера: «express» (Экспресс — шины L/C/R, 7 треков, "
            "дефолт) или «montage» (Монтаж — 4 ряда схемы × 7 полос = 28 "
            "рядовых треков для 3D-обработки); иное значение — 400"
        ),
    )


class AudioRenderRequest(AudioRenderParams):
    """Тело ``POST /api/v1/audio/render``: запись + параметры рендера."""

    recording_id: str = Field(description="Идентификатор записи из реестра просмотра")


class AudioRenderStart(BaseModel):
    """Ответ ``POST /audio/render`` (202): рендер запущен либо уже посчитан."""

    render_id: str
    status: AudioRenderState = "running"
    cached: bool = Field(
        default=False,
        description=(
            "true — результат взят из дискового кэша (те же параметры уже "
            "посчитаны), конвейер не запускался, status сразу succeeded"
        ),
    )


class AudioRenderInfo(BaseModel):
    """Один готовый рендер в списке ``GET /audio/renders`` (дисковый манифест)."""

    render_id: str = Field(description="Ключ рендера (= sig параметров)")
    created_at: float = Field(description="Момент завершения рендера (unix, с)")
    duration_s: float = Field(description="Длительность записи, с")
    bands: list[str] = Field(description="Полосы, по которым есть треки")
    params: AudioRenderParams = Field(description="Параметры, которыми рендерен")
    bytes_total: int = Field(description="Суммарный размер файлов рендера, байт")
    message: str = Field(default="", description="Итоговое сообщение рендера")


class AudioRenderListOut(BaseModel):
    """``GET /audio/renders``: готовые рендеры записи (журнал обработанных)."""

    recording_id: str
    renders: list[AudioRenderInfo] = Field(
        default_factory=list,
        description="Свежие сверху; пусто — запись ещё не рендерили",
    )


class AudioRenderStatus(BaseModel):
    """``GET /audio/render/{id}/status``: проценты и шаг пайплайна (ТЗ M5)."""

    render_id: str
    status: AudioRenderState
    stage: str = Field(description="Текущий шаг, например «Полоса alpha (3/7)»")
    pct: float = Field(ge=0.0, le=1.0, description="Готовность 0..1")
    message: str = ""
    error: str | None = Field(default=None, description="Текст ошибки (status=failed)")
    tracks: list[str] = Field(default_factory=list, description="Готовые треки (после успеха)")
    variant: str = Field(
        default="express",
        description=(
            "Вариант рендера: «montage» — файлы треков отдаются как "
            "track/{row}/{band}.wav по списку rows; «express» — track/{band}.wav"
        ),
    )
    rows: list[str] = Field(
        default_factory=list,
        description="Для «Монтажа»: id рядов, по которым есть треки (иначе пусто)",
    )


class AudioIrPresetOut(BaseModel):
    """Один пресет IR в каталоге ``GET /audio/ir`` (селект «Помещение» UI)."""

    id: str = Field(description="Идентификатор пресета (путь файла IR в кэше)")
    label: str = Field(description="Человекочитаемое имя для селекта")
    description: str = Field(description="Краткое описание акустики пресета")
    tags: list[str] = Field(default_factory=list, description="Метки («комната», «эксперимент»)")


class AudioIrCatalogOut(BaseModel):
    """``GET /audio/ir``: каталог IR-пресетов для real-time реверберации плеера."""

    presets: list[AudioIrPresetOut] = Field(
        default_factory=list,
        description="Пресеты в порядке показа UI; WAV каждого — GET /audio/ir/{id}.wav",
    )


class AudioBakeRequest(BaseModel):
    """Тело ``POST /audio/render/{id}/bake``: параметры 3D-цепочки для запекания.

    Диапазоны те же, что держит UI «Пространства» (width до 150 % — дальше
    звучит как фазовый сдвиг); валидация 400 с текстом для UI — в роуте (A1).
    """

    width_pct: float = Field(
        default=100.0,
        description="Ширина стереобазы, % (0…150, 100 — без изменения)",
    )
    spread_pct: float = Field(
        default=100.0,
        description="Разброс источников по дуге/модулям, % (0…100, 100 — полный)",
    )
    wet_pct: float = Field(
        default=25.0,
        description="Влажность общей Convolver, % (0…100, 0 — сухая сцена)",
    )
    ir: str = Field(
        default="room_small",
        description="Пресет IR из GET /audio/ir (в т.ч. brainroom_*); неизвестный — 400",
    )


class AudioBakeStart(BaseModel):
    """Ответ ``POST …/bake`` (202): запекание запущено либо уже посчитано."""

    bake_id: str
    status: AudioRenderState = "running"
    cached: bool = Field(
        default=False,
        description=(
            "true — байты взяты из дискового кэша (те же параметры цепочки), "
            "расчёт не запускался, status сразу succeeded"
        ),
    )


class AudioBakeStatus(BaseModel):
    """``GET …/bake/{bake_id}/status``: проценты и шаг запекания (поллинг UI)."""

    bake_id: str
    render_id: str
    status: AudioRenderState
    stage: str = Field(description="Текущий шаг, например «Панорама: стем 3/7»")
    pct: float = Field(ge=0.0, le=1.0, description="Готовность 0..1")
    message: str = ""
    error: str | None = Field(default=None, description="Текст ошибки (status=failed)")
    bytes_total: int = Field(default=0, description="Размер готового WAV, байт (после успеха)")
