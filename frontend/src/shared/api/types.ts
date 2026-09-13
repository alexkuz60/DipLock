/**
 * Типы контракта API DipLock.
 *
 * Источник истины — Pydantic-схемы бэкенда (`backend/app/schemas/analysis.py`).
 * Сейчас описаны вручную; следующий шаг — генерация из OpenAPI
 * (`openapi-typescript`), см. `docs/ui.md`.
 */

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed'

export type TrajectoryPoint = {
  time_ms: number
  pos_head: number[]
  ori_head: number[]
  amplitude_nam: number
  gof: number
  mni_coords: number[] | null
  anatomical_structure: string | null
  brodmann_area: string | null
}

export type DipoleFit = {
  epoch_index: number
  n_time_points: number
  trajectory: TrajectoryPoint[]
  best_fit: TrajectoryPoint | null
  error: string | null
}

export type BestFitDipole = {
  epoch_index: number | null
  time_ms: number | null
  mni_x: number | null
  mni_y: number | null
  mni_z: number | null
  amplitude_nam: number | null
  gof: number | null
  anatomical_roi: string | null
  brodmann_area: string | null
}

export type ArtifactTypes = {
  zscore_outlier: number
  peak_to_peak: number
  flat_line: number
  ica_eog: number
}

/** Паспорт загруженной для просмотра записи (срез 2.2, без обработки) */
export type RecordingMeta = {
  recording_id: string
  filename: string
  /** Число каналов в файле */
  n_channels: number
  /** Каналы, сопоставленные с монтажом 10-20 (порядок монтажа) */
  channels: string[]
  /** Каналы файла вне монтажа 10-20 */
  unmatched_channels: string[]
  sfreq: number
  duration_sec: number
  /** Применён авто-пересчёт единиц (файл без physical dimension) */
  units_autoscaled: boolean
  /** Явные единицы из EDF_UNITS; null = автоопределение */
  edf_units: string | null
  warnings: string[]
  created_at: string
}

export type PipelineInfo = {
  app_version: string
  mne_version: string
  numpy_version: string
  python_version: string
  epoch_length_ms: number
  freq_band: string
  single_freq: number | null
  dipole_fit_decim: number
  dipole_fit_max_epochs: number
  z_threshold: number
  pp_threshold_uv: number
  reject_threshold_uv: number
  ica_requested: boolean
  ica_applied: boolean
  edf_units: string | null
  duration_sec: number
  created_at: string
}

export type SurfaceRef = {
  version: string
  url: string
  brodmann_url: string
}

export type AnalyzeResponse = {
  session_id: string
  filename: string
  n_channels: number
  sfreq: number
  duration_sec: number
  epoch_length_ms: number
  freq_band: string
  n_epochs_total: number
  n_epochs_used: number
  n_epochs_dropped: number
  n_artifacts: number
  artifact_types: ArtifactTypes
  frequency_powers: Record<string, number>
  surface: SurfaceRef
  dipoles: DipoleFit[]
  best_fit_dipoles: BestFitDipole[]
  results_file: string
  pipeline: PipelineInfo
}

export type JobCreated = {
  job_id: string
  status: JobState
  poll_url: string
  result_url: string | null
}

export type JobStatus = {
  job_id: string
  kind: string
  status: JobState
  stage: string
  progress: number
  message: string
  filename: string | null
  session_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  elapsed_sec: number | null
  error: string | null
  result_url: string | null
}

export type ArtifactThresholds = {
  z_score_threshold: number
  peak_to_peak_threshold_uv: number
  flat_line_threshold_uv: number
  flat_line_min_duration_ms: number
  reject_threshold_uv: number
}

export type MetaResponse = {
  app: string
  app_version: string
  api_prefix: string
  schema_version: string
  python_version: string
  platform: string
  mne_version: string
  numpy_version: string
  scipy_version: string
  sqlalchemy_version: string
  trimesh_version: string | null
  subjects_dir: string
  fsaverage_trans: string
  upload_dir: string
  results_dir: string
  cache_dir: string
  database_backend: string
  surface_version: string
  surface_url: string
  standard_channels: string[]
  epoch_lengths_ms: number[]
  freq_bands: Record<string, number[]>
  artifact_thresholds: ArtifactThresholds
  dipole_fit_decim: number
  dipole_fit_max_epochs: number
  max_concurrent_jobs: number
  cors_origins: string[]
}

/** Статусы проверок готовности (GET /init-status) */
export type CheckStatus = 'ready' | 'pending' | 'loading' | 'error' | 'unknown'

export type InitStatus = {
  checks: Record<string, CheckStatus>
  status: 'ready' | 'pending'
  versions: Record<string, string | null>
  ui: { built: boolean; url: string; legacy_url: string }
  paths: {
    subjects_dir: string
    fsaverage_trans: string
    upload_dir: string
    results_dir: string
    cache_dir: string
  }
  api: { prefix: string; docs_url: string; meta_url: string }
}

/** Человекочитаемые подписи проверок для раздела «Состояние сервера» */
export const CHECK_TITLES: Record<string, string> = {
  mne: 'MNE-Python',
  config: 'Конфигурация',
  database: 'База данных',
  fsaverage: 'Данные FSAverage',
  transform: 'Transform (MRI ↔ head)',
  bem: 'BEM-модель головы',
}
