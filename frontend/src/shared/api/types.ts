/**
 * Типы контракта API DipLock.
 *
 * Источник истины — Pydantic-схемы бэкенда (`backend/app/schemas/analysis.py`).
 * Сейчас описаны вручную; следующий шаг — генерация из OpenAPI
 * (`openapi-typescript`), см. `docs/ui.md`.
 */

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type TrajectoryPoint = {
  time_ms: number
  pos_head: number[]
  ori_head: number[]
  amplitude_nam: number
  gof: number
  /**
   * Доля отбелённой невязки (in-band ковариация шума), 2.6/N23: кросс-полосной
   * фильтр доверия. GOF между полосами не сравним (узкая полоса завышает R²),
   * RIV — сравним. `null` — не посчитан
   */
  riv: number | null
  /** Радиус доверительной области позиции, мм (2.6/N23); `null` — не оценён */
  ci_mm: number | null
  /** χ² фита (`mne.Dipole.khi2`), если считался */
  khi2: number | null
  /** Число степеней свободы фита (`mne.Dipole.nfree`) */
  nfree: number | null
  mni_coords: number[] | null
  anatomical_structure: string | null
  /** Расстояние от точки до ближайшей структуры, мм (шаг 1.4); `null` — координат/атласа нет */
  structure_distance_mm: number | null
  /** Расстояние от точки до ближайшего узла поля Бродмана, мм (шаг 1.4); `null` — координат/атласа нет */
  brodmann_distance_mm: number | null
  /**
   * Точка вне маски мозга `brainmask` (шаг 1.4): подпись «вне мозга (~N мм до X)»
   * вместо выдуманной атрибуции; `null` — маска недоступна
   */
  outside_brain: boolean | null
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
  /** Доля отбелённой невязки (in-band ковариация шума), 2.6/N23 */
  riv: number | null
  /** Радиус доверительной области позиции, мм (2.6/N23) */
  ci_mm: number | null
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

export type ArtifactKind = import('@/shared/lib/artifacts').ArtifactKind

/** Счётчики артефактов по типам (ключи — `ArtifactKind`, их может стать больше) */
export type ArtifactTypes = Partial<Record<import('@/shared/lib/artifacts').ArtifactKind, number>>

/** Стадия предподготовки записи (срез 2.7) — совпадает с `RecalcStage` в UI */
export type PreprocessStage = 'filter' | 'artifacts' | 'epochs'

/** Зона артефакта из результата стадии (слои вьюера, срез 2.6/2.7) */
export type ArtifactZoneOut = {
  kind: import('@/shared/lib/artifacts').ArtifactKind
  onset_sec: number
  duration_sec: number
  channels: string[]
}

/** Отброшенная reject-фильтром эпоха: индекс в нарезке и каналы-виновники */
export type EpochRejectOut = {
  index: number
  channels: string[]
}

/** QC-строка канала (шаг 0.4 + расширение 2.2): зоны, SNR, мёртвый канал */
export type ChannelQc = {
  channel: string
  /** Секунд в зонах артефактов (интервалы слиты, без ica_eog) */
  artifact_sec: number
  /** Доля времени записи в зонах (0..1) */
  artifact_share: number
  /** Секунды по типам артефактов (для тултипа иконки) */
  by_kind: Partial<Record<import('@/shared/lib/artifacts').ArtifactKind, number>>
  /** SNR канала, дБ (ритмические полосы против шумовой полки) */
  snr_db: number | null
  /** Мёртвый канал: константный до референса (отвалившийся электрод) */
  dead: boolean
}

/** Отчёт очистки сигнала (стадия filter, этап 4): что сделано и «до/после» */
export type CleanReport = {
  method: string
  notch_harmonics: number
  interpolated_channels: string[]
  n_components_removed: number
  removed_components: number[]
  n_projectors: number
  amplitude_p95_uv_before: number | null
  amplitude_p95_uv_after: number | null
  warnings: string[]
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
  /** Метод полосового фильтра: none | fir | iir (шаг 2.5, N11) */
  filter_method: string
  /** Длина FIR-ядра, с (null для IIR и без фильтра) */
  filter_length_sec: number | null
  /** Краевой буфер записи ±, с (эпохи у краёв — BAD_edge, N12) */
  edge_buffer_sec: number
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
  /** Доля чистых данных, % (100 минус средняя доля времени в зонах) */
  good_data_percent: number
  /** Средняя по каналам доля времени в зонах по видам артефактов */
  artifact_share_by_kind: Record<string, number>
  /** Уровень сетевого шума: пик 50/60 Гц к фону (≥1); null — не измерялся */
  line_noise_level: number | null
  /** Авто-список плохих каналов (можно подставить в очистку) */
  bad_channels: string[]
  /** Медиана SNR по каналам, дБ (шаг 2.2); null — запись короче окна Welch */
  snr_db_median: number | null
  /** Мёртвые каналы (константные до референса), не исправленные интерполяцией */
  dead_channels: string[]
  /** Светофор записи: ok | warn | bad (худший из четырёх категорий, сервер) */
  record_status: 'ok' | 'warn' | 'bad'
  /** Причины вердикта светофора (тултип пилюли UI) */
  record_status_reasons: string[]
  /** Порог SNR «внимание» для иконок каналов, дБ (из конфига сервера) */
  qc_snr_warn_db: number
  /** Порог SNR «плохо» для иконок каналов, дБ */
  qc_snr_bad_db: number
  /** Отчёт очистки (стадия filter, когда заданы опции очистки) */
  clean: CleanReport | null
  epoch_length_ms: number
  /** Режим нарезки (N2/2.7): fixed — фиксированная длина, events — по событиям */
  epoch_mode: 'fixed' | 'events'
  /** Описание события нарезки (режим events); null — фиксированный режим */
  event_id: string | null
  /** Окно до события, мс (режим events); вместе с post задаёт длину эпохи */
  epoch_pre_ms: number
  /** Окно после события, мс (режим events) */
  epoch_post_ms: number
  /**
   * Начала окон эпох от начала записи, с (событийный режим: сетка нерегулярная).
   * `null` — регулярная сетка по `epoch_length_ms`.
   */
  epoch_starts_sec: number[] | null
  n_epochs_total: number
  n_epochs_used: number
  rejected_epochs: number[]
  /** Отброшенные эпохи с каналами-виновниками (причины блокировки в UI) */
  rejected_epoch_channels: EpochRejectOut[]
  /** Порог reject-фильтра амплитуды, мкВ (строка причины в UI) */
  warnings: string[]
  duration_sec_calc: number
}

/**
 * АЧХ применяемого фильтра (`GET /filter-response`, шаг 2.5, N11–N14).
 * Кривая — фактический отклик живого конвейера (импульс через те же
 * `raw.filter` + `raw.notch_filter`), а не приближение по формулам.
 */
export type FilterResponse = {
  /** Сетка частот, Гц (0…Nyquist) */
  freqs_hz: number[]
  /** Усиление фильтра, дБ (0 — полоса пропускания) */
  gain_db: number[]
  /** Метод полосового фильтра: none | fir | iir */
  method: 'none' | 'fir' | 'iir'
  /** Полоса пропускания [l, h], Гц; null — только notch */
  band_hz: number[] | null
  /** Нижняя переходная полоса FIR, Гц (N11, явное число) */
  l_trans_bandwidth_hz: number | null
  /** Верхняя переходная полоса FIR, Гц */
  h_trans_bandwidth_hz: number | null
  /** Длина FIR-ядра, с (null для IIR и без полосы) */
  filter_length_sec: number | null
  /** Краевой буфер записи ±, с (N12, эпохи у краёв — BAD_edge) */
  edge_buffer_sec: number
  /** Частоты notch с гармониками (N13) */
  notch_freqs: number[]
  /** Частота дискретизации расчёта, Гц */
  sfreq: number
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
export type SpectrumPeakOut = {
  /** Центровая частота гауссова пика, Гц (specparam) */
  center_hz: number
  /** Высота пика над апериодическим фоном, дБ */
  amplitude_db: number
  /** Ширина пика, Гц */
  bandwidth_hz: number
}

export type SpectrumResult = {
  recording_id: string
  channels: string[]
  /** Каналы без позиции в монтаже — в топокарты не попали */
  missed_channels: string[]
  sfreq: number
  epoch_length_ms: number
  n_epochs: number
  /** Длина окна Welch, отсчётов; для multitaper — длина окна анализа (эпоха) */
  n_fft: number
  /** Метод PSD (N17): `welch` | `multitaper` — входит в URL/ETag топокарт */
  psd_method: string
  filter_band_hz: number[] | null
  notch_hz: number | null
  /** Порог reject эпох: входит в URL картинки топокарты (и в её ETag) */
  freqs: number[]
  psd_mean_uv2: number[]
  bands: SpectrumBandOut[]
  /** Индивидуальная пиковая α-частота (IAF), Гц (N16); `null` — мало бинов в полосе α */
  iaf_hz: number | null
  /** Индекс θ/β по интегральным мощностям (N16); `null` — диапазоны не измерены */
  theta_beta_ratio: number | null
  /** Индекс (θ+α)/β (N16); `null` — диапазоны не измерены */
  theta_alpha_beta_ratio: number | null
  /** Наклон апериодической 1/f-компоненты (specparam); `null` — фит не сошёлся */
  aperiodic_exponent: number | null
  /** Смещение апериодики в log10(мкВ²/Гц); `null` — фит не сошёлся */
  aperiodic_offset: number | null
  /** Кривая фона на сетке `freqs`, мкВ²/Гц (рисуется поверх PSD); пусто — фита нет */
  aperiodic_fit_uv2: number[]
  /** Гауссовые пики над фоном, по убыванию высоты (specparam) */
  peaks: SpectrumPeakOut[]
  /** Качество 1/f-фита, R² в log-пространстве; `null` — фит не сошёлся */
  fit_r_squared: number | null
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
  /**
   * Доля отбелённой невязки (in-band ковариация шума), 2.6/N23: кросс-полосной
   * фильтр доверия. GOF между полосами не сравним (узкая полоса завышает R²),
   * RIV — сравним. `null` — не посчитан
   */
  riv: number | null
  /**
   * Радиус доверительной области позиции, мм (2.6/N23): «плато» сетки (узлы в
   * пределах ΔGOF от лучшего); `null` — не оценён
   */
  ci_mm: number | null
  brodmann_area: string | null
  /**
   * Анатомическая структура по MNI-координате (атлас `aparc+aseg` — тот же, что
   * и контуры срезов); `null` — координат/метки нет
   */
  anatomical_structure: string | null
  /** Расстояние от точки до ближайшей структуры, мм (шаг 1.4); `null` — координат/атласа нет */
  structure_distance_mm: number | null
  /** Расстояние от точки до ближайшего узла поля Бродмана, мм (шаг 1.4); `null` — координат/атласа нет */
  brodmann_distance_mm: number | null
  /**
   * Точка вне маски мозга `brainmask` (шаг 1.4): подпись «вне мозга (~N мм до X)»
   * вместо выдуманной атрибуции; `null` — маска недоступна
   */
  outside_brain: boolean | null
}

/**
 * Результат быстрого расчёта диполей (`GET /recordings/{id}/dipoles/{job}`).
 * `method: 'fast_grid'` — перебор сетки на сферической модели (не `mne.fit_dipole`):
 * UI обязан показывать эту метку, а не выдавать быстрый режим за точный.
 */
export type DipoleScanResult = {
  recording_id: string
  method: string
  brodmann_method: string | null
  /** Референс расчёта: уточнение эпохи (`dipole_refine`) повторяет нарезку результата */
  reference: string
  /** Каналы custom-референса; `null` — average */
  reference_channels: string[] | null
  channels: string[]
  sfreq: number
  epoch_length_ms: number
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

/**
 * Событие записи: аннотация EDF+ или маркер стим-канала (N2, шаг 2.7).
 * Оба источника сведены к аннотациям: у стим-канала описание `STIM/<код>`.
 */
export type RecordingEvent = {
  /** Время события от начала записи, с */
  onset: number
  /** Длительность, с (0 — точечное событие/маркер) */
  duration: number
  /** Описание события: «STIM/5», «Sound/On» … */
  description: string
  /** Источник: аннотация EDF+ или маркер стим-канала */
  source: 'annotation' | 'stim'
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
  /**
   * События записи (аннотации EDF+ и маркеры стим-каналов, N2) по возрастанию
   * времени; `BAD_` не входят (это отбраковка, а не события). Лимит — cap
   * паспорта, полное число — в `event_counts`.
   */
  events: RecordingEvent[]
  /** Число событий по описаниям (селекты нарезки/ERP) */
  event_counts: Record<string, number>
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

/**
 * Результат задачи ERP-усреднения (`GET /recordings/{id}/evoked/{job}`, шаг 2.7).
 * Усреднённая волна по каналам вокруг момента события: стимул → эпоха →
 * усреднение. Данные — в µV, ось времени — секунды от события (`t=0`).
 */
export type EvokedResult = {
  recording_id: string
  /** Описание события, по которому усредняли */
  event_id: string
  /** Начало окна эпохи от события, с (обычно < 0) */
  tmin: number
  /** Конец окна эпохи от события, с */
  tmax: number
  sfreq: number
  /** Ось времени, с от события (t=0 — момент события) */
  times: number[]
  channels: string[]
  /** Усреднённая волна [канал][время], µV */
  data_uv: number[][]
  /** Окно baseline-коррекции [start, end], с от события; null — без коррекции */
  baseline: [number, number] | null
  /** Всего событий выбранного описания в записи */
  n_total: number
  /** Вошло в усреднение (после отбраковки BAD_) */
  n_used: number
  /** Индексы событий, отброшенных BAD_, в порядке событий */
  rejected_epochs: number[]
  warnings: string[]
  duration_sec_calc: number
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
  /** Окно скользящих медианы/MAD для z-score, с (устойчивость к нестационарности) */
  zscore_window_sec: number
  peak_to_peak_threshold_uv: number
  flat_line_threshold_uv: number
  flat_line_min_duration_ms: number
  /** Минимальная длительность мышечного (ЭМГ) эпизода, мс */
  muscle_min_duration_ms: number
  /** Минимальная длительность разрыва записи, мс */
  break_min_duration_ms: number
  /** Во сколько раз пик 50/60 Гц должен превышать соседние частоты */
  line_noise_ratio: number
  /** Доля отсчётов у предела АЦП в окне, с которой объявляется клиппинг */
  clipping_share: number
  /** Шаг ступеньки всплеска электрода (pop), мкВ */
  pop_step_uv: number
  /** Порог z-score дисперсии канала для списка bad (плохие каналы) */
  bad_channel_z: number
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
  /** Свежесть кода бэкенда: `stale` = исходники новее старта процесса (сервер не обновлён) */
  code: { code_mtime: string; server_started_at: string; stale: boolean }
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
