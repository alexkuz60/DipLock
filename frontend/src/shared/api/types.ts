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

/** Одна эпоха нарезки: окно, флаг отбраковки и мощности по диапазонам (F21) */
export type EpochSummary = {
  epoch_index: number
  start_time_sec: number
  duration_ms: number
  /** Эпоха не прошла reject-фильтр (отброшена) */
  has_artifact: boolean
  /** Мощности по диапазонам, ключи вида `alpha_power` (пусто у отброшенных) */
  band_powers: Record<string, number>
}

export type ArtifactTypes = {
  zscore_outlier: number
  peak_to_peak: number
  flat_line: number
  ica_eog: number
}

/** Стадия предподготовки записи (срез 2.7) — совпадает с `RecalcStage` в UI */
export type PreprocessStage = 'filter' | 'artifacts' | 'epochs'

/** Зона артефакта из результата стадии (слои вьюера, срез 2.6/2.7) */
export type ArtifactZoneOut = {
  kind: import('@/shared/lib/artifacts').ArtifactKind
  onset_sec: number
  duration_sec: number
  channels: string[]
}

/** QC-строка канала (шаг 0.4): доля времени в зонах артефактов (иконки вьюера) */
export type ChannelQc = {
  channel: string
  /** Секунд в зонах артефактов (интервалы слиты, без ica_eog) */
  artifact_sec: number
  /** Доля времени записи в зонах (0..1) */
  artifact_share: number
  /** Секунды по типам артефактов (для тултипа иконки) */
  by_kind: Partial<Record<import('@/shared/lib/artifacts').ArtifactKind, number>>
}

/**
 * Результат одной стадии предподготовки (`GET /recordings/{id}/preprocess/{job}`).
 * Заполнены только поля запрошенной стадии, остальные — пустые значения.
 */
export type PreprocessResult = {
  recording_id: string
  stage: PreprocessStage
  channels: string[]
  band_hz: number[] | null
  notch_hz: number | null
  reference: string
  sfreq: number
  duration_sec: number
  artifacts: ArtifactZoneOut[]
  artifact_types: ArtifactTypes
  ica_applied: boolean
  /** QC-сводка по каналам (стадия artifacts, шаг 0.4); у других стадий пусто */
  channel_qc: ChannelQc[]
  /** Пороги статуса иконок (из конфига сервера, приезжают с результатом) */
  qc_warn_share: number
  qc_bad_share: number
  epoch_length_ms: number
  n_epochs_total: number
  n_epochs_used: number
  rejected_epochs: number[]
  warnings: string[]
  duration_sec_calc: number
}

/** Мощность одного ритма (срез 3.4): интеграл PSD + ссылка на топокарту */
export type SpectrumBandOut = {
  /** Ключ диапазона из `/meta` (`delta`…`gamma`) */
  name: string
  fmin: number
  fmax: number
  /** Интеграл PSD по диапазону, мкВ² (N15); `null` — диапазон вне полосы фильтра («не измерено») */
  power_uv2: number | null
  /** Доля диапазона в интеграле всего спектра, 0..1 (N16); `null` — не измерено */
  relative_power: number | null
  /** Медиана и квартили мощности по эпохам, мкВ² (N16); `null` — не измерено */
  median_power_uv2: number | null
  q25_power_uv2: number | null
  q75_power_uv2: number | null
  /** URL топокарты (PNG, ETag) или `null`, если картинка не построена */
  topomap_url: string | null
}

/**
 * Результат расчёта спектра (`GET /recordings/{id}/spectrum/{job}`).
 * Числа рисует UI (гистограмма), топокарты приходят картинками с сервера.
 */
export type SpectrumResult = {
  recording_id: string
  channels: string[]
  /** Каналы без позиции в монтаже — в топокарты не попали */
  missed_channels: string[]
  sfreq: number
  epoch_length_ms: number
  n_epochs: number
  n_fft: number
  filter_band_hz: number[] | null
  notch_hz: number | null
  /** Порог reject эпох: входит в URL картинки топокарты (и в её ETag) */
  reject_threshold_uv: number
  freqs: number[]
  psd_mean_uv2: number[]
  bands: SpectrumBandOut[]
  /** Индивидуальная пиковая α-частота (IAF), Гц (N16); `null` — мало бинов в полосе α */
  iaf_hz: number | null
  /** Индекс θ/β по интегральным мощностям (N16); `null` — диапазоны не измерены */
  theta_beta_ratio: number | null
  /** Индекс (θ+α)/β (N16); `null` — диапазоны не измерены */
  theta_alpha_beta_ratio: number | null
  /** Версия топокарт: уходит в URL (`?v=`) против «залипания» кэша браузера */
  topomap_version: string
  warnings: string[]
  duration_sec_calc: number
}

/** Один диполь быстрого расчёта (срез 3.4): одна эпоха → одна точка в пике GFP */
export type DipoleScanPoint = {
  epoch_index: number
  time_ms: number
  /** Позиция в системе координат головы, мм */
  head_coords: number[]
  /** MNI, мм; `null` — fsaverage недоступен, точка не наводится на проекции */
  mni_coords: number[] | null
  /** Единичный вектор момента диполя (направление луча на проекциях) */
  moment: number[]
  amplitude_nam: number
  gof: number
  brodmann_area: string | null
  /**
   * Анатомическая структура по MNI-координате (атлас `aparc+aseg` — тот же, что
   * и контуры срезов); `null` — координат/метки нет
   */
  anatomical_structure: string | null
}

/**
 * Результат быстрого расчёта диполей (`GET /recordings/{id}/dipoles/{job}`).
 * `method: 'fast_grid'` — перебор сетки на сферической модели (не `mne.fit_dipole`):
 * UI обязан показывать эту метку, а не выдавать быстрый режим за точный.
 */
export type DipoleScanResult = {
  recording_id: string
  method: string
  /** Референс расчёта: уточнение эпохи (`dipole_refine`) повторяет нарезку результата */
  reference: string
  /** Каналы custom-референса; `null` — average */
  reference_channels: string[] | null
  channels: string[]
  sfreq: number
  epoch_length_ms: number
  reject_threshold_uv: number
  filter_band_hz: number[] | null
  notch_hz: number | null
  n_epochs_total: number
  n_epochs_used: number
  /** Шаг объёмной сетки поиска, мм */
  grid_mm: number
  points: DipoleScanPoint[]
  warnings: string[]
  duration_sec_calc: number
}

/** Результат точного уточнения эпохи (`kind=dipole_refine`, кнопка «Уточнить…», F19) */
export type DipoleRefineResult = {
  recording_id: string
  /** Метод уточнения: `bem_fit` */
  method: string
  /** Номер эпохи нарезки быстрого расчёта (с 0) */
  epoch_index: number
  /** Время пика GFP эпохи, мс */
  time_ms: number
  /** Окно фитинга вокруг пика [от, до], мс */
  window_ms: number[]
  /** Половина окна свободного фитинга, мс (0 — фитился только пик GFP) */
  halfwin_ms: number
  /** Узел сетки (быстрый режим), head, мм */
  fast_head_coords: number[]
  /** GOF узла сетки на сферической модели, 0..1 */
  fast_gof: number
  /** GOF того же узла на BEM (позиция фиксирована); `null` — не посчитан */
  grid_gof_bem: number | null
  /** Сдвиг позиции после уточнения относительно узла сетки, мм */
  shift_mm: number
  /**
   * Свободный фит окна выполнен; `false` — показана оценка узла сетки на BEM
   * (причина в `warnings`): «стало» не выдумывается, а честно называется узлом.
   */
  free_fit: boolean
  /** Уточнённая точка (BEM, max GOF в окне) */
  point: DipoleScanPoint
  warnings: string[]
  duration_sec_calc: number
}

/**
 * Виртуальный канал записи: микс каналов группы (срез 5+).
 *
 * Раздел «ЭЭГ» считает спектрограмму по одному каналу, а микс отвечает на
 * вопрос «что в этой области/полушарии». Состав приходит из паспорта записи:
 * правила разбора имён 10-20 живут на сервере (`services/channel_mix.py`), UI их
 * не повторяет — он только усредняет готовый список каналов для трека.
 */
export type RecordingMix = {
  /** Идентификатор канала для формы расчёта (`mix:frontal`) */
  id: string
  /** Русская подпись для списка каналов («Лобные») */
  label: string
  group: string
  /** Каналы записи, попавшие в микс (порядок монтажа) */
  channels: string[]
}

/** Паспорт загруженной для просмотра записи (срез 2.2, без обработки) */
export type RecordingMeta = {
  recording_id: string
  filename: string
  /** Число каналов в файле */
  n_channels: number
  /** Каналы, сопоставленные с монтажом 10-20 (порядок монтажа) */
  channels: string[]
  /**
   * Виртуальные каналы «ЭЭГ» (миксы групп). Пустые группы не приходят: в записи
   * нет таких электродов — предлагать их значило бы обещать пустую линию
   */
  mixes: RecordingMix[]
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
  /**
   * Файл уже был загружен ранее: открыта существующая запись, копия не создана.
   * Заполняется только ответом `POST /recordings` (дедуп по sha256 содержимого)
   */
  deduplicated: boolean
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
  /** Все нарезанные эпохи (включая отброшенные) — строки таблицы `epochs` в БД (F21) */
  epochs: EpochSummary[]
  /** Сколько эпох точного фитинга дало хотя бы один диполь (F18) */
  n_dipole_fit: number
  /** Сколько эпох точного фитинга упало: задача может быть успешной без диполей */
  n_dipole_errors: number
  /** Первые тексты ошибок фитинга (до 5) — по ним понятно, что чинить */
  dipole_error_samples: string[]
  /** Предупреждения пайплайна: UI обязан показать их, а не только статус задачи */
  warnings: string[]
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
  /** Детальный прогресс этапа, где считаются эпохи (срез 3.4): «12 из 30» */
  epochs_done: number
  epochs_total: number
  filename: string | null
  session_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  elapsed_sec: number | null
  error: string | null
  /** Хвост traceback при провале задачи (разворот в UI, N31) */
  error_traceback: string | null
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
  /** Уровни пирамиды сигналов вьюера (множители зума ×1…×16) */
  signal_levels: number[]
  /** Точек на канал на уровне ×1 (2 × ширина вьюпорта) */
  signal_base_points: number
  artifact_thresholds: ArtifactThresholds
  dipole_fit_decim: number
  dipole_fit_max_epochs: number
  dipole_fit_n_jobs: number
  dipole_fit_sec_per_point: number
  /** Точный фитинг помечен экспериментальным: дефолты означают часы счёта */
  dipole_fit_experimental: boolean
  /** Дефолтное окно уточнения эпохи, мс (0 — свободный фит только по пику GFP) */
  dipole_refine_halfwin_ms: number
  /** Предел окна уточнения из формы, мс — каждый отсчёт стоит ≈7 с */
  dipole_refine_halfwin_max_ms: number
  /** Постоянная цена уточнения (оценка узла сетки на BEM), с — замер, не параметр */
  dipole_refine_sec_fixed: number
  /** Оценка времени одного отсчёта свободного фита в окне, с */
  dipole_refine_sec_per_sample: number
  /** Потоков fit_dipole в уточнении (-1 — все ядра; нужен установленный joblib) */
  dipole_refine_n_jobs: number
  max_concurrent_jobs: number
  cors_origins: string[]
  /** Срезы МРТ для проекций мозга: версия ассета, базовый URL, шаг сетки */
  mri_slices: MriSliceRef
  /** Контуры атласа (структуры + поля Бродмана): версия, URL, шаг, метод */
  contours: ContoursRef
}

/**
 * Ссылка на срезы МРТ (T1) на MNI-сетке (срез 3.2): картинки отдаёт
 * `GET {slice_url}/{plane}/{mm}.png`, версия — ключ кэша браузера.
 */
export type MriSliceRef = {
  /** Версия ассета тома: меняется вместе с данными fsaverage */
  version: string
  /** Базовый URL срезов: `/api/v1/surface/mri/slice` */
  slice_url: string
  /** Шаг сетки срезов, мм: картинка существует только на этих значениях */
  spacing_mm: number
}

/**
 * Ссылка на контуры атласа (срез 3.9): картинки срезов МРТ и контуры меток —
 * разные ассеты с разными версиями, поэтому и ссылки разные.
 */
export type ContoursRef = {
  /** Версия ассета атласа: меняется вместе с файлами fsaverage */
  version: string
  /** Базовый URL контуров: `/{url}/{plane}/{mm}` */
  url: string
  /** Шаг сетки контуров, мм: контур существует только на этих значениях */
  spacing_mm: number
  /** Метод разметки полей Бродмана (производная разметка объёма коры) */
  method: string
}

/**
 * Контур одной метки на срезе: замкнутые полигоны в мм MNI по осям плоскости.
 * Дырки (желудочек внутри структуры) приходят отдельными полигонами, поэтому
 * заливка идёт по правилу even-odd.
 */
export type ContourShape = {
  /** Идентификатор метки: имя структуры атласа или поле (`BA17-lh`) */
  id: string
  /** Имя метки как в атласе (без перевода) */
  name: string
  /** Подпись для UI (русская, где есть перевод) */
  label: string
  /** Полигоны `[горизонталь_мм, вертикаль_мм]` среза */
  hulls: [number, number][][]
  /** Площадь главного полигона, мм² */
  area_mm2: number
}

/** Ответ `GET /surface/contours/{plane}/{mm}`: метки одного среза. */
export type ContourSlice = {
  version: string
  plane: string
  /** Ось MNI, по которой наведён срез (x/y/z) */
  axis: string
  /** Фактическое значение среза после квантования сеткой атласа */
  mm: number
  spacing_mm: number
  /** Метод разметки полей: `nearest_cortex_vertex` — производная разметка */
  method: string
  structures: ContourShape[]
  areas: ContourShape[]
}

/**
 * Результат расчёта спектрограммы канала (`GET /recordings/{id}/spectrogram/{job}`).
 *
 * Считается STFT по одному каналу («ЭЭГ»): числа сетки приезжают отдельным
 * бинарным контейнером (`grid_url`), а в JSON — метаданные и оси. Палитра, окно
 * дБ и сглаживание — параметры просмотра, сетку они не пересчитывают.
 */
export type SpectrogramResult = {
  recording_id: string
  channel: string
  channels: string[]
  /**
   * Электроды, усреднённые в виртуальном канале (`mix:*`); пусто — спектрограмма
   * обычного канала (срез 5+)
   */
  mix_channels: string[]
  sfreq: number
  duration_sec: number
  window_ms: number
  overlap_pct: number
  fmax_hz: number
  n_fft: number
  filter_band_hz: number[] | null
  notch_hz: number | null
  /** Референс расчёта сетки: параметр расчёта, не просмотра (A11) */
  reference: string
  /** Каналы своей ссылки; пусто — средняя по каналам */
  reference_channels: string[]
  /** Частоты сетки (строки), Гц */
  freqs: number[]
  /** Времена центров окон (столбцы), с */
  times: number[]
  db_min: number
  db_max: number
  grid_url: string
  /** Отпечаток расчёта: уходит в URL сетки против «залипания» кэша браузера */
  grid_version: string
  warnings: string[]
  duration_sec_calc: number
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
