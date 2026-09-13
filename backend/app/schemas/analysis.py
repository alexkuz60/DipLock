"""Pydantic-модели ответов DipLock (F4: контракт API вместо «сырых» dict)."""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# Статусы фоновой задачи
JobState = Literal["queued", "running", "succeeded", "failed"]


class TrajectoryPoint(BaseModel):
    """Одна точка траектории диполя: время + позиция/ориентация + качество."""

    time_ms: float = Field(description="Время от начала эпохи, мс")
    pos_head: List[float] = Field(description="Позиция в системе координат головы, мм")
    ori_head: List[float] = Field(description="Ориентация диполя (единичный вектор)")
    amplitude_nam: float = Field(description="Амплитуда, нАм")
    gof: float = Field(description="Goodness of fit, 0..1")
    mni_coords: Optional[List[float]] = Field(default=None, description="Координаты MNI, мм")
    anatomical_structure: Optional[str] = Field(default=None, description="Анатомическая область (aparc.a2009s)")
    brodmann_area: Optional[str] = Field(default=None, description="Поле Бродмана, например BA17-lh")


class DipoleFit(BaseModel):
    """Результат фитинга одной эпохи: траектория по времени + лучший кадр."""

    epoch_index: int
    n_time_points: int = 0
    trajectory: List[TrajectoryPoint] = Field(default_factory=list)
    best_fit: Optional[TrajectoryPoint] = None
    error: Optional[str] = Field(default=None, description="Ошибка фитинга эпохи (если была)")

    @field_validator("best_fit", mode="before")
    @classmethod
    def _empty_dict_to_none(cls, value: Any) -> Any:
        """Сервис отдаёт ``{}`` при пустой траектории — приводим к ``None``."""
        return None if value in ({}, "", []) else value


class BestFitDipole(BaseModel):
    """Компактный лучший диполь эпохи — для таблицы локализации и БД."""

    epoch_index: Optional[int] = None
    time_ms: Optional[float] = None
    mni_x: Optional[float] = None
    mni_y: Optional[float] = None
    mni_z: Optional[float] = None
    amplitude_nam: Optional[float] = None
    gof: Optional[float] = None
    anatomical_roi: Optional[str] = None
    brodmann_area: Optional[str] = None


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
    channels: List[str] = Field(default_factory=list)


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
    channels: List[str] = Field(default_factory=list, description="Каналы после монтажа 10-20")
    band_hz: Optional[List[float]] = Field(
        default=None, description="Полоса пропускания после предподготовки, Гц (None — без фильтра)"
    )
    notch_hz: Optional[float] = Field(default=None, description="Частота notch-фильтра, Гц (None — выключен)")
    reference: str = Field(default="average", description="Референс: average | custom")
    sfreq: float = 0.0
    duration_sec: float = 0.0

    # Стадия `artifacts`: зоны для слоёв вьюера (срез 2.6)
    artifacts: List[ArtifactZoneOut] = Field(default_factory=list)
    artifact_types: ArtifactTypes = Field(default_factory=ArtifactTypes)
    ica_applied: bool = False

    # Стадия `epochs`: сетка эпох и отброшенные reject-фильтром
    epoch_length_ms: float = 0.0
    n_epochs_total: int = 0
    n_epochs_used: int = 0
    rejected_epochs: List[int] = Field(
        default_factory=list, description="Индексы эпох, отброшенных reject-фильтром"
    )

    warnings: List[str] = Field(default_factory=list)
    duration_sec_calc: float = Field(default=0.0, description="Длительность расчёта, сек")


class RecordingMeta(BaseModel):
    """Паспорт загруженной для просмотра записи EDF (просмотр ≠ обработка)."""

    recording_id: str
    filename: str
    n_channels: int = Field(description="Число каналов в файле")
    channels: List[str] = Field(
        default_factory=list,
        description="Каналы, сопоставленные с монтажом 10-20 (в порядке монтажа)",
    )
    unmatched_channels: List[str] = Field(
        default_factory=list, description="Каналы файла, не вошедшие в монтаж 10-20"
    )
    sfreq: float = Field(description="Частота дискретизации, Гц")
    duration_sec: float
    units_autoscaled: bool = Field(
        description="Применён авто-пересчёт единиц (файл без physical dimension)"
    )
    edf_units: Optional[str] = Field(
        default=None, description="Явные единицы из EDF_UNITS; None = автоопределение"
    )
    warnings: List[str] = Field(default_factory=list)
    created_at: datetime


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
    channels: List[str] = Field(description="Каналы в порядке отрисовки (как в паспорте записи)")
    sfreq: float = Field(description="Частота дискретизации огибающей, Гц")
    duration_sec: float
    n_points: int = Field(description="Точек на канал (по одной корзине)")
    decimated: bool = Field(description="true — корзинное усреднение min/max")
    arrays_per_channel: int = Field(description="1 = только max, 2 = min и max")
    dtype: Literal["float32"] = "float32"
    byte_order: Literal["little"] = "little"
    layout: Literal["channel-major"] = "channel-major"


class PipelineInfo(BaseModel):
    """Провенанс результата: чем и с какими параметрами посчитано (F16)."""

    app_version: str
    mne_version: str
    numpy_version: str
    python_version: str
    epoch_length_ms: float
    freq_band: str
    single_freq: Optional[float] = None
    dipole_fit_decim: int
    dipole_fit_max_epochs: int
    z_threshold: float
    pp_threshold_uv: float
    reject_threshold_uv: float
    ica_requested: bool = False
    ica_applied: bool = Field(default=False, description="ICA реально применена (нужны EOG-каналы)")
    edf_units: Optional[str] = Field(default=None, description="None = автоопределение единиц")
    duration_sec: float = Field(default=0.0, description="Длительность расчёта, сек")
    created_at: datetime = Field(default_factory=datetime.utcnow)


class SurfaceRef(BaseModel):
    """Ссылка на статический меш (F6): тяжёлые данные не вкладываются в ответ."""

    version: str = Field(description="Версия ассета (для кэша/ETag)")
    url: str = Field(description="GET-эндпоинт меша fsaverage")
    brodmann_url: str = Field(description="GET-эндпоинт индексов вершин полей Бродмана")


class HemiMesh(BaseModel):
    """Меш одного полушария (децимированный для frontend)."""

    vertices: List[List[float]]
    faces: List[List[int]]
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
    vertices: List[int]
    n_vertices: int


class BrodmannIndexOut(BaseModel):
    """GET /api/v1/surface/brodmann — все поля Бродмана (тяжёлый ассет)."""

    version: str
    areas: Dict[str, BrodmannAreaOut]


class BrodmannLabelsOut(BaseModel):
    """GET /api/v1/brodmann-labels — только имена меток (лёгкий ответ для UI)."""

    brodmann_areas: List[str]
    count: int
    version: str


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
    frequency_powers: Dict[str, float]
    surface: SurfaceRef
    dipoles: List[DipoleFit]
    best_fit_dipoles: List[BestFitDipole]
    results_file: str
    pipeline: PipelineInfo


class JobCreated(BaseModel):
    """202-ответ POST /api/v1/jobs."""

    job_id: str
    status: JobState
    poll_url: str
    result_url: Optional[str] = None


class JobStatus(BaseModel):
    """GET /api/v1/jobs/{job_id} — состояние задачи (этап + прогресс 0..1)."""

    job_id: str
    kind: str = Field(description="Тип задачи: analyze | preprocess")
    status: JobState
    stage: str = Field(description="Текущий этап пайплайна")
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    message: str = ""
    filename: Optional[str] = None
    session_id: Optional[str] = None
    created_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    elapsed_sec: Optional[float] = None
    error: Optional[str] = None
    result_url: Optional[str] = None


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
    trimesh_version: Optional[str] = None
    subjects_dir: str
    fsaverage_trans: str
    upload_dir: str
    results_dir: str
    cache_dir: str
    database_backend: str
    surface_version: str
    surface_url: str
    standard_channels: List[str]
    epoch_lengths_ms: List[float]
    freq_bands: Dict[str, List[float]]
    signal_levels: List[int] = Field(
        default_factory=list, description="Уровни пирамиды сигналов для вьюера (×1…×16)"
    )
    signal_base_points: int = Field(
        default=4000, description="Точек на канал на уровне ×1 (2 × ширина вьюпорта)"
    )
    artifact_thresholds: ArtifactThresholds
    dipole_fit_decim: int
    dipole_fit_max_epochs: int
    max_concurrent_jobs: int
    cors_origins: List[str]

