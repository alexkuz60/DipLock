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


class AudioKeySegment(BaseModel):
    """Сегмент карты аккордов (VAMP Chordino, ``key_track`` кадров «Эмо»).

    ``label`` — точное имя аккорда от Chordino («C», «Am», «G7», «Dm6»,
    «Ebm6», «Gaug»), заполняется в таблицу аккордов и оверлеи как есть.
    ``key_code`` — код тональности для вращения звезды: **только корневая
    нота + лад** (1…12 — мажор C…B, 13…24 — минор Cm…Bm); уточнения
    интервалов в имени аккорда (7, 6, dim, aug …) игнорируются («C7» →
    C мажор, «Dm6» → D минор). «N» (нет аккорда) сегментом не становится.
    """

    t_sec: float = Field(description="Начало сегмента аккорда, с")
    key_code: int = Field(
        ge=1,
        le=24,
        description=(
            "Код тональности для звезды: корневая нота + лад, "
            "1…12 мажор (C…B), 13…24 минор (Cm…Bm)"
        ),
    )
    label: str = Field(description="Точное имя аккорда Chordino, например «G7», «Ebm6»")


class AudioTempoSegment(BaseModel):
    """Оценка темпа микса (VAMP Tempo and Beat Tracker, ``tempo_track`` кадров «Эмо»).

    Вывод ``tempo`` плагина — «locked tempo estimates»: по одной оценке на
    строку CSV, значение — темп в bpm. Для кадра анимации берётся значение
    темпа его временного диапазона (несколько оценок в диапазоне → среднее,
    спецификация владельца 09.10.2026).
    """

    t_sec: float = Field(description="Момент оценки темпа, с")
    bpm: float = Field(gt=0.0, description="Темп, bpm (> 0)")


class AudioEmoSegment(BaseModel):
    """Сегмент трека (VAMP Segmenter, ``segment_track`` кадров «Эмо», «ЕмоЛаб»).

    Начало однородного сегмента аудиотрека: ``segment_type`` — тип сегмента
    (целое 1…12, при параметре `nSegmentTypes` = 8 — 1…8), ``name`` — имя
    сегмента (метка плагина A, B, … по типу: 1 → A, 2 → B, …). Данные для
    визуально-слухового контроля анализа (таблица в «Опциях», вертикали с
    метками поверх волны и на «Эмограмме»); в расчётах пока не участвуют.
    """

    t_sec: float = Field(ge=0.0, description="Начало сегмента, с")
    name: str = Field(description="Имя сегмента (A, B, C… — метка VAMP Segmenter)")
    segment_type: int = Field(
        ge=1, le=12,
        description="Тип сегмента QM Segmenter: 1…12 (при nSegmentTypes = 8 — 1…8)",
    )


class AudioEmoFrame(BaseModel):
    """Один кадр анимации радара «Эмо» (слайд полигона со своим вектором Доминанты)."""

    t_sec: float = Field(
        description="Время начала окна FFT кадра, с (k × hop_samples / fs_audio)",
    )
    rays: list[float] = Field(
        min_length=7,
        max_length=7,
        description=(
            "Длины 7 лучей полигона, % радиуса (0…100), порядок полос "
            "BAND_ORDER (δ…γ-high); значения — линейная шкала по пику трека: "
            "100·raw/global_max (масштаб радара 0..1 = проценты / 100)"
        ),
    )


class AudioEmoOut(BaseModel):
    """``GET /audio/render/{id}/emo``: кадры анимации радара «Эмо».

    Окно FFT 32768 (2^15), сдвиг 32000 сэмплов (перекрытие 768): кадр k ↔
    время k · 2/3 с — сетка синхронизации анимации с плеером и (в дальнейшем)
    дипольными эпохами. Лучи — **линейная шкала по пику трека**
    (``schema_version`` 8): ``pct = 100·raw/global_max`` (масштаб радара
    0..1 = проценты / 100); доминанта считается в UI из
    лучей **после вращения полигона**. ``schema_version`` 3 (09.10.2026):
    ``key_track`` — сегменты тональности микса для вращения звезды.
    ``schema_version`` 4 (09.10.2026): ``tempo_track`` —
    оценки темпа микса (VAMP Tempo and Beat Tracker) для темп-коррекции
    радара. ``schema_version`` 5 (21.10.2026): ``segment_track`` — сегменты
    трека (VAMP Segmenter, «ЕмоЛаб») для визуально-слухового контроля (в
    расчётах не участвуют). ``schema_version`` 6 (21.10.2026): карта
    аккордов — VAMP Chordino «Chord Estimate» взамен QM Key Detector:
    ``label`` — точное имя аккорда («G7», «Ebm6»), ``key_code`` — только
    корневая нота + лад для звезды. ``schema_version`` 7 (22.10.2026): ФФТ —
    rfft без зеркала выше Найквиста, окно Блекмена-Харриса (``window``).
    ``schema_version`` 8 (22.10.2026, решение совещания): счётчики — суммы
    блоков, лучи — линейная шкала по пику трека (``normalization`` =
    ``peak_linear``) взамен децибельной (20·log10 перекомпрессировал
    динамику), ``db_floor`` упразднён. ``schema_version`` 9 (23.10.2026,
    сверка со старым EmoLab): схема счётчиков — сплошная сборка от
    DC-бина блоками ширин 1, 2, 4 … 8192. ``schema_version`` 10 (23.10.2026,
    консультация по октавным спектрам): блоки — ровные октавные диапазоны
    от DC-бина (ширины 2, 2, 4, 8 … 8192, границы на степенях двойки),
    счётчик k = энергия блоков k и k+7 — ``sqrt(Σ|Z|²)`` (мощности
    аддитивны, корень один на счётчик) взамен сумм амплитуд: на розовом
    шуме энергия октав равномерна, лучи без веера ≈8×. Данные — из
    ``emo.json`` кэша рендера; рендеры до среза «Эмо» добиваются
    расчётом из ``master.wav``.
    """

    schema_version: int = Field(
        default=10,
        description=(
            "Версия контракта emo.json (2 — дБ-шкала лучей, 3 — + key_track, "
            "4 — + tempo_track, 5 — + segment_track, 6 — аккорды Chordino, "
            "7 — ФФТ v7: rfft без зеркала выше Найквиста + окно Блекмена-Харриса, "
            "8 — суммы блоков и линейная шкала по пику трека peak_linear "
            "вместо децибельной, db_floor упразднён, "
            "9 — двухзаходная схема счётчиков от DC-бина: блоки ширин "
            "1, 2, 4 … 8192, счётчик k = блок k + блок k+7, блок 14 "
            "добирает до Найквиста, "
            "10 — октавные блоки ширин 2, 2, 4, 8 … 8192 от DC-бина и "
            "энергетические суммы sqrt(Σ|Z|²) взамен сумм амплитуд)"
        ),
    )
    fs_audio: int = Field(description="Частота дискретизации микса, Гц (48000)")
    fft_size: int = Field(description="Размер окна FFT, сэмплов (32768 = 2^15)")
    hop_samples: int = Field(description="Сдвиг окна между кадрами, сэмплов (32000)")
    overlap_samples: int = Field(description="Перекрытие окон, сэмплов (768)")
    window: str = Field(
        default="blackman_harris",
        description=(
            "Окно аподизации ФФТ — Блекмена-Харриса (4-членное, боковые "
            "лепестки ≈ −92 дБ): минимизация утечки спектра; применяется к "
            "кадру до FFT"
        ),
    )
    normalization: Literal["peak_linear"] = Field(
        description=(
            "Шкала лучей: линейная по пику всего трека — проценты = "
            "100·сырой счётчик / global_max (масштаб радара 0..1 = проценты "
            "/ 100; логарифмирование не применяется)"
        ),
    )
    global_max: float = Field(
        description="Пиковый референс 100 % R — глобальный максимум сырых счётчиков",
    )
    duration_s: float = Field(description="Длительность микса, с")
    frame_count: int = Field(ge=0, description="Число кадров (длина frames)")
    frames: list[AudioEmoFrame] = Field(description="Кадры по возрастанию t_sec")
    key_track: list[AudioKeySegment] | None = Field(
        default=None,
        description=(
            "Карта аккордов микса (VAMP Chordino) для вращения звезды: угол "
            "кадра — из активного сегмента по корневой ноте + ладу, знак — "
            "мажор + (против часовой), минор − (по часовой); null — инструмент "
            "недоступен, вращение нулевое"
        ),
    )
    key_source: str | None = Field(
        default=None,
        description="Идентификатор источника key_track (vamp:nnls-chroma:chordino:simplechord)",
    )
    tempo_track: list[AudioTempoSegment] | None = Field(
        default=None,
        description=(
            "Оценки темпа микса (VAMP Tempo and Beat Tracker, вывод tempo) "
            "для темп-коррекции радара: темп кадра — значение его временного "
            "диапазона (несколько оценок → среднее); null — инструмент "
            "недоступен, коррекция нулевая"
        ),
    )
    tempo_source: str | None = Field(
        default=None,
        description=(
            "Идентификатор источника tempo_track "
            "(vamp:qm-vamp-plugins:qm-tempotracker:tempo)"
        ),
    )
    segment_track: list[AudioEmoSegment] | None = Field(
        default=None,
        description=(
            "Сегменты трека (VAMP Segmenter) для визуально-слухового контроля "
            "анализа: таблица сегментов в «Опциях», вертикали с метками имён "
            "(A, B, C…) поверх волны плеера и на «Эмограмме»; в расчётах "
            "пока не участвуют; null — инструмент недоступен"
        ),
    )
    segment_source: str | None = Field(
        default=None,
        description=(
            "Идентификатор источника segment_track "
            "(vamp:qm-vamp-plugins:qm-segmenter:segmentation)"
        ),
    )
