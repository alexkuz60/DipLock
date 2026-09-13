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
    artifact_thresholds: ArtifactThresholds
    dipole_fit_decim: int
    dipole_fit_max_epochs: int
    max_concurrent_jobs: int
    cors_origins: List[str]

