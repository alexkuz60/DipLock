"""Pydantic-модели ответов DipLock (F4: контракт API вместо «сырых» dict)."""
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# Статусы фоновой задачи
JobState = Literal["queued", "running", "succeeded", "failed"]
# Тот же набор значениями: нужен там, где состояние приходит извне типа
# (восстановление задачи из файла `job_store`) и его надо сузить обратно к Literal.
JOB_STATES: tuple[JobState, ...] = ("queued", "running", "succeeded", "failed")


class TrajectoryPoint(BaseModel):
    """Одна точка траектории диполя: время + позиция/ориентация + качество."""

    time_ms: float = Field(description="Время от начала эпохи, мс")
    pos_head: list[float] = Field(description="Позиция в системе координат головы, мм")
    ori_head: list[float] = Field(description="Ориентация диполя (единичный вектор)")
    amplitude_nam: float = Field(description="Амплитуда, нАм")
    gof: float = Field(description="Goodness of fit, 0..1")
    mni_coords: list[float] | None = Field(default=None, description="Координаты MNI, мм")
    anatomical_structure: str | None = Field(
        default=None,
        description=(
            "Анатомическая структура по MNI-координате (aparc+aseg — тот же атлас, "
            "что у контуров срезов и быстрого расчёта); null — вне метки"
        ),
    )
    brodmann_area: str | None = Field(default=None, description="Поле Бродмана, например BA17-lh")


class DipoleFit(BaseModel):
    """Результат фитинга одной эпохи: траектория по времени + лучший кадр."""

    epoch_index: int
    n_time_points: int = 0
    trajectory: list[TrajectoryPoint] = Field(default_factory=list)
    best_fit: TrajectoryPoint | None = None
    error: str | None = Field(default=None, description="Ошибка фитинга эпохи (если была)")

    @field_validator("best_fit", mode="before")
    @classmethod
    def _empty_dict_to_none(cls, value: Any) -> Any:
        """Сервис отдаёт ``{}`` при пустой траектории — приводим к ``None``."""
        return None if value in ({}, "", []) else value


class BestFitDipole(BaseModel):
    """Компактный лучший диполь эпохи — для таблицы локализации и БД."""

    epoch_index: int | None = None
    time_ms: float | None = None
    mni_x: float | None = None
    mni_y: float | None = None
    mni_z: float | None = None
    amplitude_nam: float | None = None
    gof: float | None = None
    anatomical_roi: str | None = None
    brodmann_area: str | None = None


class EpochSummary(BaseModel):
    """Одна эпоха нарезки: окно, флаг отбраковки и мощности по диапазонам (F21).

    ``epoch_index`` — номер по порядку в сессии (ключ связи с ``dipoles`` и
    ``best_fit_dipoles``), он же ``epochs.epoch_index`` в БД. ``band_powers``
    пуст у эпох, отброшенных reject-фильтром: их PSD не считался.
    """

    epoch_index: int
    start_time_sec: float = Field(description="Начало эпохи в записи, с")
    duration_ms: float
    has_artifact: bool = Field(description="Эпоха не прошла reject-фильтр (отброшена)")
    band_powers: dict[str, float] = Field(
        default_factory=dict,
        description="Мощности по диапазонам, ключи вида `alpha_power` (пусто у отброшенных)",
    )


class ArtifactTypes(BaseModel):
    """Счётчики артефактов по типам детекции."""

    zscore_outlier: int = 0
    peak_to_peak: int = 0
    flat_line: int = 0
    ica_eog: int = 0


# Тип артефакта и стадия предподготовки (срез 2.7): те же строки, что в UI
# (`shared/lib/artifacts.ts` и `shared/state/edfParams.ts` STAGE_PARAM_KEYS).
ArtifactKind = Literal["zscore_outlier", "peak_to_peak", "flat_line", "ica_eog"]
PreprocessStage = Literal["filter", "artifacts", "epochs"]


class ArtifactZoneOut(BaseModel):
    """Зона артефакта для слоёв вьюера: интервал + затронутые каналы.

    Плоская проекция аннотаций MNE: ``onset``/``duration``/``description`` плюс
    каналы, по которым сработал детектор (для тултипа зоны). Каналы могут быть
    пустыми, если детектор не сопоставил аннотацию с конкретным каналом
    (например, ICA находит компоненты, а не каналы).
    """

    kind: ArtifactKind
    onset_sec: float
    duration_sec: float
    channels: list[str] = Field(default_factory=list)


class ChannelQcOut(BaseModel):
    """QC-строка канала (шаг 0.4): сколько времени канал был в зонах артефактов.

    Считается из зон стадии ``artifacts`` (слияние интервалов, без ``ica_eog``);
    статус «ок/внимание/плохо» выводит UI по порогам ``qc_*_share`` из конфига.
    """

    channel: str
    artifact_sec: float = Field(description="Секунд в зонах артефактов (интервалы слиты)")
    artifact_share: float = Field(description="Доля времени записи в зонах (0..1)")
    by_kind: dict[str, float] = Field(
        default_factory=dict, description="Секунды по типам артефактов (для тултипа)"
    )


class PreprocessResult(BaseModel):
    """Результат задачи предподготовки записи (стадия ``preprocess``).

    Стадии раздельные (``filter`` / ``artifacts`` / ``epochs``): каждая считает
    свой слот и не обесценивает результаты других. В ответе заполняются только
    поля, относящиеся к запрошенной стадии, остальные остаются пустыми.

    Треки приходят из ``GET /recordings/{id}/signals`` и здесь не дублируются —
    это десятки тысяч точек на канал (docs/ui.md §8).
    """

    recording_id: str
    stage: PreprocessStage

    # Стадия `filter`: какие параметры фильтра/референса зафиксированы
    channels: list[str] = Field(default_factory=list, description="Каналы после монтажа 10-20")
    band_hz: list[float] | None = Field(
        default=None, description="Полоса пропускания после предподготовки, Гц (None — без фильтра)"
    )
    notch_hz: float | None = Field(default=None, description="Частота notch-фильтра, Гц (None — выключен)")
    reference: str = Field(default="average", description="Референс: average | custom")
    sfreq: float = 0.0
    duration_sec: float = 0.0

    # Стадия `artifacts`: зоны для слоёв вьюера (срез 2.6)
    artifacts: list[ArtifactZoneOut] = Field(default_factory=list)
    artifact_types: ArtifactTypes = Field(default_factory=ArtifactTypes)
    ica_applied: bool = False
    channel_qc: list[ChannelQcOut] = Field(
        default_factory=list,
        description="QC-сводка по каналам: доля времени в зонах (иконки состояния вьюера)",
    )
    qc_warn_share: float = Field(
        default=0.05, description="Порог «внимание» для доли времени в артефактах"
    )
    qc_bad_share: float = Field(
        default=0.20, description="Порог «плохо» для доли времени в артефактах"
    )

    # Стадия `epochs`: сетка эпох и отброшенные reject-фильтром
    epoch_length_ms: float = 0.0
    n_epochs_total: int = 0
    n_epochs_used: int = 0
    rejected_epochs: list[int] = Field(
        default_factory=list, description="Индексы эпох, отброшенных reject-фильтром"
    )

    warnings: list[str] = Field(default_factory=list)
    duration_sec_calc: float = Field(default=0.0, description="Длительность расчёта, сек")


class ChannelMixOut(BaseModel):
    """Виртуальный канал записи: микс каналов группы (срез 5+).

    Раздел «ЭЭГ» считает спектрограмму по одному каналу, а смотреть по 18
    электродам — 18 задач; микс отвечает на вопрос «что в этой области/полушарии».
    Состав приходит из паспорта записи, чтобы UI не повторял разбор имён 10-20
    (`services/channel_mix.py` — единственный источник правил группировки).
    """

    id: str = Field(description="Идентификатор канала для формы расчёта (mix:frontal)")
    label: str = Field(description="Русская подпись для списка каналов («Лобные»)")
    group: str = Field(description="Код группы: all | left | right | frontal | …")
    channels: list[str] = Field(
        default_factory=list, description="Каналы записи, попавшие в микс (порядок монтажа)"
    )


class RecordingMeta(BaseModel):
    """Паспорт загруженной для просмотра записи EDF (просмотр ≠ обработка)."""

    recording_id: str
    filename: str
    n_channels: int = Field(description="Число каналов в файле")
    channels: list[str] = Field(
        default_factory=list,
        description="Каналы, сопоставленные с монтажом 10-20 (в порядке монтажа)",
    )
    mixes: list[ChannelMixOut] = Field(
        default_factory=list,
        description=(
            "Виртуальные каналы «ЭЭГ» (миксы групп). Пустые группы не предлагаются: "
            "в записи нет таких электродов"
        ),
    )
    unmatched_channels: list[str] = Field(
        default_factory=list, description="Каналы файла, не вошедшие в монтаж 10-20"
    )
    sfreq: float = Field(description="Частота дискретизации, Гц")
    duration_sec: float
    units_autoscaled: bool = Field(
        description="Применён авто-пересчёт единиц (файл без physical dimension)"
    )
    edf_units: str | None = Field(
        default=None, description="Явные единицы из EDF_UNITS; None = автоопределение"
    )
    warnings: list[str] = Field(default_factory=list)
    created_at: datetime = Field(
        description="Время сессии просмотра; при повторной загрузке того же файла освежается"
    )
    deduplicated: bool = Field(
        default=False,
        description=(
            "Файл уже был загружен ранее: открыта существующая запись, копия не создана. "
            "Заполняется только ответом POST /recordings"
        ),
    )


class RecordingSignalsHeader(BaseModel):
    """Заголовок бинарного ответа ``GET /recordings/{id}/signals``.

    Ответ — не JSON, а компактный контейнер float32 (иначе 64k точек × 18
    каналов не влезают в разумный payload):

    ``magic 'DPS1'`` | ``uint32 LE len(header)`` | ``header`` (JSON UTF-8) |
    ``payload`` float32 LE, channel-major: для каждого канала из ``channels``
    сначала ``min`` (только при ``decimated``), затем ``max``.

    Минимумы и максимумы считаются по временным корзинам (огибающая), поэтому
    пики артефактов не теряются при прореживании — это требование вьюера
    (docs/ui.md §8). При ``decimated=false`` каждая корзина содержит один
    отсчёт и ``min`` не передаётся: ``min == max``.
    """

    recording_id: str
    level: int = Field(description="Уровень пирамиды (множитель зума ×1…×16)")
    channels: list[str] = Field(description="Каналы в порядке отрисовки (как в паспорте записи)")
    sfreq: float = Field(description="Частота дискретизации огибающей, Гц")
    duration_sec: float
    n_points: int = Field(description="Точек на канал (по одной корзине)")
    decimated: bool = Field(description="true — корзинное усреднение min/max")
    arrays_per_channel: int = Field(description="1 = только max, 2 = min и max")
    dtype: Literal["float32"] = "float32"
    byte_order: Literal["little"] = "little"
    layout: Literal["channel-major"] = "channel-major"


class SpectrogramGridHeader(BaseModel):
    """Заголовок бинарного ответа ``GET /recordings/{id}/spectrogram/{job}/grid.bin``.

    Спектрограмма — **сетка чисел**, а не картинка: клиент рисует её сам (палитра,
    окно дБ и сглаживание — параметры просмотра, а не расчёта). Container:

    ``magic 'DPS2'`` | ``uint32 LE len(header)`` | ``header`` (JSON UTF-8) |
    ``payload`` float32 LE, frequency-major: для каждой частоты из ``freqs``
    подряд идут значения по временам из ``times``.

    Значения — уровень в дБ (20·lg амплитуды, мкВ), шкала привязана к ``db_max``
    и ``db_min`` (потолок и пол) — они же нужны клиенту, чтобы перевести окно
    отображения в цвета.
    """

    recording_id: str
    channel: str = Field(description="Канал, по которому посчитана спектрограмма")
    window_ms: float = Field(description="Длина окна STFT, мс")
    overlap_pct: float = Field(description="Перекрытие окон, %")
    fmax_hz: float = Field(description="Верхняя частота сетки, Гц")
    sfreq: float = Field(description="Частота дискретизации сигнала, Гц")
    n_fft: int = Field(description="Длина окна FFT, отсчётов")
    n_freqs: int = Field(description="Строк сетки (частоты)")
    n_times: int = Field(description="Столбцов сетки (времена)")
    db_min: float = Field(description="Пол шкалы, дБ (шум вне сигнала)")
    db_max: float = Field(description="Потолок шкалы, дБ (99.9-й процентиль)")
    dtype: Literal["float32"] = "float32"
    byte_order: Literal["little"] = "little"
    layout: Literal["frequency-major"] = "frequency-major"


class PipelineInfo(BaseModel):
    """Провенанс результата: чем и с какими параметрами посчитано (F16)."""

    app_version: str
    mne_version: str
    numpy_version: str
    python_version: str
    epoch_length_ms: float
    freq_band: str
    single_freq: float | None = None
    dipole_fit_decim: int
    dipole_fit_max_epochs: int
    z_threshold: float
    pp_threshold_uv: float
    reject_threshold_uv: float
    ica_requested: bool = False
    ica_applied: bool = Field(default=False, description="ICA реально применена (нужны EOG-каналы)")
    edf_units: str | None = Field(default=None, description="None = автоопределение единиц")
    duration_sec: float = Field(default=0.0, description="Длительность расчёта, сек")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SurfaceRef(BaseModel):
    """Ссылка на статический меш (F6): тяжёлые данные не вкладываются в ответ."""

    version: str = Field(description="Версия ассета (для кэша/ETag)")
    url: str = Field(description="GET-эндпоинт меша fsaverage")
    brodmann_url: str = Field(description="GET-эндпоинт индексов вершин полей Бродмана")


class HemiMesh(BaseModel):
    """Меш одного полушария (децимированный для frontend)."""

    vertices: list[list[float]]
    faces: list[list[int]]
    vertex_count: int
    face_count: int


class SurfaceOut(BaseModel):
    """GET /api/v1/surface — меш fsaverage без тяжёлых BA-индексов."""

    version: str
    lh: HemiMesh
    rh: HemiMesh
    n_brodmann_areas: int = 0
    brodmann_url: str = ""


class BrodmannAreaOut(BaseModel):
    """Индексы вершин одного поля Бродмана."""

    name: str
    hemi: str
    vertices: list[int]
    n_vertices: int


class BrodmannIndexOut(BaseModel):
    """GET /api/v1/surface/brodmann — все поля Бродмана (тяжёлый ассет)."""

    version: str
    areas: dict[str, BrodmannAreaOut]


class BrodmannLabelsOut(BaseModel):
    """GET /api/v1/brodmann-labels — только имена меток (лёгкий ответ для UI)."""

    brodmann_areas: list[str]
    count: int
    version: str


class MriPlaneOut(BaseModel):
    """Плоскость срезов МРТ: ось наведения, диапазон значений и число срезов."""

    axis: str = Field(description="Ось MNI, по которой наводится срез (x/y/z)")
    range_mm: list[float] = Field(description="Диапазон значений среза, мм")
    count: int = Field(description="Число срезов на сетке тома")


class MriSliceRef(BaseModel):
    """Ссылка на срезы МРТ (для ``/meta``): считается без сборки тома, O(1)."""

    version: str = Field(description="Версия ассета — для кэша картинок и ETag")
    slice_url: str = Field(description="Базовый URL срезов: ``/slice/{plane}/{mm}.png``")
    spacing_mm: float = Field(description="Шаг сетки срезов, мм")


class MriSlicesOut(BaseModel):
    """GET /api/v1/surface/mri — метаданные срезов МРТ (T1) на MNI-сетке."""

    version: str
    encoding: str = Field(description="Формат картинки среза (png-gray8-alpha)")
    spacing_mm: float
    bounds: dict[str, list[float]] = Field(description="Границы тома по осям MNI, мм")
    intensity_window: list[float] = Field(
        description="Окно яркости: перцентили внутри маски мозга, в единицах тома"
    )
    planes: dict[str, MriPlaneOut] = Field(description="Плоскости: axial/sagittal/coronal")
    slice_url: str


class ContourShapeOut(BaseModel):
    """Контур одной метки на срезе: полигоны в мм MNI по осям плоскости."""

    id: str = Field(description="Идентификатор метки: имя структуры атласа или поле (`BA17-lh`)")
    name: str = Field(description="Короткое имя метки как в атласе (без перевода)")
    label: str = Field(description="Подпись для UI (русская, где есть перевод)")
    hulls: list[list[list[float]]] = Field(
        description=(
            "Замкнутые полигоны [горизонталь_мм, вертикаль_мм] среза; "
            "дырки — отдельные полигоны, заливка по правилу even-odd"
        )
    )
    area_mm2: float = Field(description="Площадь главного (внешнего) полигона, мм²")


class ContourSliceOut(BaseModel):
    """GET /api/v1/surface/contours/{plane}/{mm} — контуры одного среза."""

    version: str = Field(description="Версия ассета — для ETag и `?v=` в UI")
    plane: str = Field(description="Плоскость: axial/sagittal/coronal")
    axis: str = Field(description="Ось MNI, по которой наведён срез (x/y/z)")
    mm: float = Field(description="Фактическое значение среза после квантования сеткой")
    spacing_mm: float = Field(description="Шаг сетки контуров, мм")
    method: str = Field(
        description=(
            "Метод разметки полей Бродмана: `nearest_cortex_vertex` — производная "
            "разметка объёма коры (метки PALS живут на поверхности, а не в объёме)"
        )
    )
    structures: list[ContourShapeOut] = Field(default_factory=list)
    areas: list[ContourShapeOut] = Field(default_factory=list)


class ContoursRef(BaseModel):
    """Ссылка на контуры для ``/meta``: считается без сборки объёмов, O(1)."""

    version: str = Field(description="Версия ассета атласа")
    url: str = Field(description="Базовый URL контуров: ``{url}/{plane}/{mm}``")
    spacing_mm: float = Field(description="Шаг сетки контуров, мм")
    method: str = Field(description="Метод разметки полей Бродмана (производная разметка)")


class ContoursOut(BaseModel):
    """GET /api/v1/surface/contours — метаданные контуров атласа."""

    version: str
    encoding: str = Field(description="Формат контуров (json-paths)")
    spacing_mm: float
    simplify_mm: float = Field(description="Допуск упрощения контуров, мм")
    min_area_mm2: float = Field(description="Минимальная площадь метки на срезе, мм²")
    method: str
    bounds: dict[str, list[float]] = Field(description="Границы сетки по осям MNI, мм")
    planes: dict[str, MriPlaneOut] = Field(description="Плоскости: axial/sagittal/coronal")
    n_structures: int = Field(description="Меток анатомических структур в атласе")
    n_areas: int = Field(description="Полей Бродмана в атласе")
    url: str


# --- Спектр по диапазонам (срез 3.4) ---

class SpectrumBandOut(BaseModel):
    """Мощность одного ритма (δ…γ) с ссылкой на топокарту.

    Мощность — **интеграл PSD по диапазону, мкВ²** (N15): физически сравнимая
    величина между диапазонами разной ширины (среднее PSD, мкВ²/Гц, таким не
    является). Топокарта диапазона строится тем же интегралом по каналам.
    """

    name: str = Field(description="Ключ диапазона из `freq_bands` (delta…gamma)")
    fmin: float
    fmax: float
    power_uv2: float | None = Field(
        default=None,
        description="Интеграл PSD по диапазону, мкВ²; None — частоты не попали в полосу фильтра",
    )
    relative_power: float | None = Field(
        default=None,
        description="Доля диапазона в интеграле всего спектра, 0..1 (N16); None — не измерено",
    )
    median_power_uv2: float | None = Field(
        default=None, description="Медиана мощности диапазона по эпохам, мкВ² (N16)"
    )
    q25_power_uv2: float | None = Field(
        default=None, description="25-й перцентиль мощности по эпохам, мкВ²"
    )
    q75_power_uv2: float | None = Field(
        default=None, description="75-й перцентиль мощности по эпохам, мкВ²"
    )
    topomap_url: str | None = Field(
        default=None, description="URL топокарты диапазона (PNG, ETag); None — не построена"
    )


class SpectrumResult(BaseModel):
    """Результат задачи спектра записи (``kind=spectrum``).

    PSD считается по эпохам записи (Welch) и отдаётся **числами** — UI сам
    рисует гистограмму по диапазонам. Топокарты — только картинки (PNG),
    пиксели UI не считает: то же правило, что для срезов МРТ (срез 3.2).
    """

    recording_id: str
    channels: list[str] = Field(description="Каналы, попавшие в расчёт (порядок монтажа)")
    missed_channels: list[str] = Field(
        default_factory=list, description="Каналы без позиции в монтаже — в топокарту не входят"
    )
    sfreq: float
    epoch_length_ms: float
    n_epochs: int = Field(description="Сколько эпох попало в PSD")
    n_fft: int = Field(description="Длина окна Welch, отсчётов")
    filter_band_hz: list[float] | None = Field(
        default=None, description="Полоса фильтра, на которой считался спектр; None — без фильтра"
    )
    notch_hz: float | None = None
    reject_threshold_uv: float = Field(
        default=150.0, description="Порог reject эпох: входит в URL/ETag топокарты"
    )
    freqs: list[float] = Field(description="Частоты PSD, Гц")
    psd_mean_uv2: list[float] = Field(description="PSD, усреднённый по каналам, мкВ²/Гц")
    bands: list[SpectrumBandOut] = Field(default_factory=list)
    iaf_hz: float | None = Field(
        default=None,
        description="Индивидуальная пиковая α-частота (IAF), Гц (N16); None — мало бинов в полосе α",
    )
    theta_beta_ratio: float | None = Field(
        default=None,
        description="Индекс θ/β по интегральным мощностям (N16); None — θ или β не измерены",
    )
    theta_alpha_beta_ratio: float | None = Field(
        default=None,
        description="Индекс (θ+α)/β по интегральным мощностям (N16); None — диапазоны не измерены",
    )
    topomap_version: str = Field(description="Версия топокарт (в URL — против «залипания» кэша)")
    warnings: list[str] = Field(default_factory=list)
    duration_sec_calc: float = 0.0


# --- Быстрый расчёт диполей (срез 3.4) ---

class DipoleScanPointOut(BaseModel):
    """Один диполь быстрого расчёта (одна эпоха → одна точка в импульсе GFP).

    Быстрый режим жертвует точностью ради времени: для эпохи берётся **один**
    отсчёт (пик GFP) и положение диполя ищется перебором узлов объёмной сетки
    на сферической модели головы — без BEM и без `mne.fit_dipole`.
    """

    epoch_index: int
    time_ms: float = Field(description="Время пика GFP внутри эпохи, мс")
    head_coords: list[float] = Field(description="Позиция в системе координат головы, мм")
    mni_coords: list[float] | None = Field(
        default=None, description="MNI (мм); None — fsaverage недоступен, точка не наводится"
    )
    moment: list[float] = Field(description="Единичный вектор момента диполя (направление)")
    amplitude_nam: float = Field(description="Амплитуда момента, нА·м")
    gof: float = Field(description="Goodness of fit, 0..1")
    brodmann_area: str | None = Field(default=None, description="Поле Бродмана, например BA17-lh")
    anatomical_structure: str | None = Field(
        default=None,
        description=(
            "Анатомическая структура по MNI-координате (aparc+aseg — тот же атлас, "
            "что и контуры срезов); None — координат/метки нет"
        ),
    )


class DipoleScanResult(BaseModel):
    """Результат задачи быстрого расчёта диполей (``kind=dipoles``)."""

    recording_id: str
    method: str = Field(description="Метод расчёта: `fast_grid` — перебор сетки, сферическая модель")
    channels: list[str]
    sfreq: float
    epoch_length_ms: float
    reject_threshold_uv: float
    filter_band_hz: list[float] | None = None
    notch_hz: float | None = None
    n_epochs_total: int = Field(description="Сколько эпох нарезано (включая отброшенные)")
    n_epochs_used: int = Field(description="Сколько эпох прошло reject-фильтр")
    grid_mm: float = Field(description="Шаг объёмной сетки поиска, мм")
    points: list[DipoleScanPointOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    duration_sec_calc: float = 0.0


class SpectrogramResult(BaseModel):
    """Результат задачи спектрограммы канала (``kind=spectrogram``).

    Считается STFT (короткое окно + перекрытие) по **одному** каналу записи —
    это то, что рисует раздел «ЭЭГ» под треком. Сетка значений приходит не в
    JSON, а бинарным контейнером (``SpectrogramGridHeader``, ``grid_url``):
    строк на частоты × столбцов на времена слишком много для JSON-ответа.
    """

    recording_id: str
    channel: str = Field(description="Канал, по которому посчитана спектрограмма")
    channels: list[str] = Field(default_factory=list, description="Каналы записи, попавшие в расчёт")
    mix_channels: list[str] = Field(
        default_factory=list,
        description=(
            "Электроды, усреднённые в виртуальном канале (mix:*); пусто — "
            "спектрограмма обычного канала"
        ),
    )
    sfreq: float
    duration_sec: float = Field(description="Длительность записи, с")
    window_ms: float = Field(description="Длина окна STFT, мс")
    overlap_pct: float = Field(description="Перекрытие окон, %")
    fmax_hz: float = Field(description="Верхняя частота сетки, Гц")
    n_fft: int = Field(description="Длина окна FFT, отсчётов")
    filter_band_hz: list[float] | None = Field(
        default=None, description="Полоса фильтра, на которой считалась спектрограмма; None — без фильтра"
    )
    notch_hz: float | None = None
    freqs: list[float] = Field(description="Частоты сетки (строки), Гц")
    times: list[float] = Field(description="Времена центров окон (столбцы), с")
    reference: str = Field(
        default="average",
        description="Ссылка, на которой считалась спектрограмма (нужна ленивому пересчёту сетки, A11)",
    )
    reference_channels: list[str] = Field(
        default_factory=list,
        description="Каналы своей ссылки; пусто — средняя по каналам",
    )
    db_min: float = Field(description="Пол шкалы, дБ")
    db_max: float = Field(description="Потолок шкалы, дБ")
    grid_url: str = Field(description="URL бинарной сетки (float32, frequency-major)")
    grid_version: str = Field(description="Отпечаток расчёта: входит в URL/ETag сетки")
    warnings: list[str] = Field(default_factory=list)
    duration_sec_calc: float = 0.0


class AnalyzeResponse(BaseModel):
    """POST /api/v1/analyze (и результат job) — итог полного пайплайна."""

    session_id: str
    filename: str
    n_channels: int
    sfreq: float
    duration_sec: float
    epoch_length_ms: float
    freq_band: str
    n_epochs_total: int = Field(description="Сколько эпох нарезано (включая отброшенные)")
    n_epochs_used: int = Field(description="Сколько эпох прошло reject-фильтр")
    n_epochs_dropped: int = Field(default=0, description="Отброшено reject-фильтром")
    n_artifacts: int
    artifact_types: ArtifactTypes
    frequency_powers: dict[str, float]
    surface: SurfaceRef
    dipoles: list[DipoleFit]
    best_fit_dipoles: list[BestFitDipole]
    epochs: list[EpochSummary] = Field(
        default_factory=list,
        description=(
            "Все нарезанные эпохи (включая отброшенные) — источник строк таблицы `epochs` "
            "и связи `dipoles.epoch_id` в БД (F21)"
        ),
    )
    n_dipole_fit: int = Field(default=0, description="Сколько эпох дало хотя бы один диполь (F18)")
    n_dipole_errors: int = Field(default=0, description="Сколько эпох точного фитинга упало (F18)")
    dipole_error_samples: list[str] = Field(
        default_factory=list, description="Первые тексты ошибок фитинга (до 5): счётчик без текста не помогает"
    )
    warnings: list[str] = Field(
        default_factory=list, description="Предупреждения пайплайна: клиент обязан показать их пользователю"
    )
    results_file: str
    pipeline: PipelineInfo


class JobCreated(BaseModel):
    """202-ответ POST /api/v1/jobs."""

    job_id: str
    status: JobState
    poll_url: str
    result_url: str | None = None


class JobStatus(BaseModel):
    """GET /api/v1/jobs/{job_id} — состояние задачи (этап + прогресс 0..1)."""

    job_id: str
    kind: str = Field(description="Тип задачи: analyze | preprocess | spectrum | dipoles")
    status: JobState
    stage: str = Field(description="Текущий этап пайплайна")
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    message: str = ""
    epochs_done: int = Field(default=0, description="Сколько эпох уже обработано (детальный прогресс)")
    epochs_total: int = Field(default=0, description="Сколько эпох в текущем этапе (0 — этап без эпох)")
    filename: str | None = None
    session_id: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    elapsed_sec: float | None = None
    error: str | None = None
    error_traceback: str | None = Field(
        default=None, description="Хвост traceback при провале задачи (для разворота в UI, N31)"
    )
    result_url: str | None = None


class ArtifactThresholds(BaseModel):
    """Активные пороги детекции артефактов и reject-фильтра."""

    z_score_threshold: float
    peak_to_peak_threshold_uv: float
    flat_line_threshold_uv: float
    flat_line_min_duration_ms: float
    reject_threshold_uv: float


class MetaResponse(BaseModel):
    """GET /api/v1/meta — версия схемы, окружение и параметры (для UI и provenance)."""

    app: str
    app_version: str
    api_prefix: str
    schema_version: str = "1"
    python_version: str
    platform: str
    mne_version: str
    numpy_version: str
    scipy_version: str
    sqlalchemy_version: str
    trimesh_version: str | None = None
    subjects_dir: str
    fsaverage_trans: str
    upload_dir: str
    results_dir: str
    cache_dir: str
    database_backend: str
    surface_version: str
    surface_url: str
    standard_channels: list[str]
    epoch_lengths_ms: list[float]
    freq_bands: dict[str, list[float]]
    signal_levels: list[int] = Field(
        default_factory=list, description="Уровни пирамиды сигналов для вьюера (×1…×16)"
    )
    signal_base_points: int = Field(
        default=4000, description="Точек на канал на уровне ×1 (2 × ширина вьюпорта)"
    )
    artifact_thresholds: ArtifactThresholds
    dipole_fit_decim: int
    dipole_fit_max_epochs: int
    dipole_fit_n_jobs: int = Field(description="Потоков на эпоху в точном фитинге (F19)")
    dipole_fit_sec_per_point: float = Field(
        description="Оценка времени одной точки траектории, с — подсказка «сколько ждать» до запуска",
    )
    dipole_fit_experimental: bool = Field(
        description=(
            "Точный фитинг помечен экспериментальным: дефолты (все эпохи, decim=5) "
            "означают часы счёта, поэтому синхронный /analyze для него не рекомендуется"
        ),
    )
    max_concurrent_jobs: int
    cors_origins: list[str]
    mri_slices: MriSliceRef = Field(
        description="Срезы МРТ (T1) для проекций: версия, базовый URL, шаг сетки"
    )
    contours: ContoursRef = Field(
        description="Контуры атласа (структуры + поля Бродмана): версия, URL, метод"
    )

