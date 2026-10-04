/**
 * Фикстуры ответов бэкенда для тестов UI (совпадают по форме со схемами API).
 */
import type {
  BundleResult,
  CompareResult,
  ContourSlice,
  DipoleScanPoint,
  DipoleRefineResult,
  EloretaResult,
  DipoleScanResult,
  EvokedResult,
  FilterResponse,
  GroupAggregateOut,
  GroupAnalysisSummary,
  InitStatus,
  JobStatus,
  LocalResource,
  MainsResponse,
  MetaResponse,
  PreprocessResult,
  PreprocessStage,
  RecordingMeta,
  ReportBandSummary,
  ReportHtmlOut,
  ReportResult,
  RoiAggregate,
  RoiBandCell,
  SessionSummary,
  SpectrogramResult,
  SpectrumBandOut,
  SpectrumResult,
} from '@/shared/api/types'

export const metaFixture: MetaResponse = {
  app: 'DipLock',
  app_version: '0.1.0',
  api_prefix: '/api/v1',
  schema_version: '1',
  python_version: '3.12.3',
  platform: 'linux',
  mne_version: '1.13.2',
  numpy_version: '2.5.3',
  scipy_version: '1.16.0',
  sqlalchemy_version: '2.0.52',
  trimesh_version: '5.1.0',
  subjects_dir: '/home/user/mne_data/MNE-fsaverage-data',
  fsaverage_trans: '/home/user/mne_data/fsaverage-trans.fif',
  upload_dir: '/home/user/DipLock/data/edf',
  results_dir: '/home/user/DipLock/data/results',
  cache_dir: '/home/user/DipLock/data/cache',
  database_backend: 'sqlite+aiosqlite',
  surface_version: 'abc123def456',
  surface_url: '/api/v1/surface',
  standard_channels: ['Fp1', 'Fp2', 'F3', 'F4', 'C3', 'C4', 'P3', 'P4', 'O1', 'O2'],
  // Нормированные координаты монтажа (как отдаёт /meta: [x, y] в [-1, 1], нос +y)
  channel_positions: {
    Fp1: [-0.253, 0.722],
    Fp2: [0.257, 0.73],
    F3: [-0.432, 0.457],
    F4: [0.446, 0.467],
    C3: [-0.562, -0.1],
    C4: [0.577, -0.094],
    P3: [-0.456, -0.678],
    P4: [0.479, -0.676],
    O1: [-0.253, -0.967],
    O2: [0.257, -0.965],
  },
  epoch_lengths_ms: [250, 500, 750, 1000, 1250, 1500, 1750, 2000],
  freq_bands: {
    delta: [0.5, 2],
    delta_theta: [2, 4],
    theta: [4, 8],
    alpha: [8, 16],
    beta: [16, 32],
    gamma: [32, 64],
    high_gamma: [64, 128],
  },
  functional_bands: {
    mu: [8, 13],
    sigma: [11, 16],
    kappa: [8, 12],
    tau: [8, 9],
    lambda: [4, 5],
    psi: [35, 55],
  },
  signal_levels: [1, 2, 4, 8, 16],
  signal_base_points: 4000,
  artifact_thresholds: {
    z_score_threshold: 5,
    zscore_window_sec: 30,
    peak_to_peak_threshold_uv: 100,
    flat_line_threshold_uv: 1,
    flat_line_min_duration_ms: 200,
    muscle_min_duration_ms: 100,
    break_min_duration_ms: 500,
    line_noise_ratio: 4,
    clipping_share: 0.05,
    pop_step_uv: 80,
    bad_channel_z: 3.5,
  },
  dipole_fit_decim: 5,
  dipole_fit_max_epochs: 0,
  dipole_fit_n_jobs: 1,
  dipole_fit_sec_per_point: 5.4,
  dipole_fit_experimental: true,
  dipole_refine_halfwin_ms: 0,
  dipole_refine_halfwin_max_ms: 20,
  dipole_refine_sec_fixed: 0.5,
  dipole_refine_sec_per_sample: 7,
  dipole_refine_n_jobs: -1,
  max_concurrent_jobs: 2,
  cors_origins: ['http://localhost:5173'],
  mri_slices: {
    version: 'mri12345678',
    slice_url: '/api/v1/surface/mri/slice',
    spacing_mm: 1,
  },
  mri_volumes: {
    version: 'vol12345678',
    url: '/api/v1/surface/mri/volume',
    names: ['T1.mgz', 'seghead.mgz', 'lh.white', 'rh.white'],
    // Воксель → мировые координаты (fsaverage T1, коронарная укладка L, I, A)
    affine: [
      [-1, 0, 0, 128],
      [0, 0, 1, -128],
      [0, -1, 0, 128],
      [0, 0, 0, 1],
    ],
  },
  contours: {
    version: 'cont12345678',
    url: '/api/v1/surface/contours',
    spacing_mm: 1,
    method: 'nearest_cortex_vertex',
  },
}

/**
 * Контуры среза атласа для тестов UI: две структуры и одно поле, полигоны —
 * квадраты в мм MNI по осям аксиальной плоскости (z = 0).
 */
export function contourSliceFixture(
  overrides: Partial<ContourSlice> = {},
): ContourSlice {
  return {
    version: 'cont12345678',
    plane: 'axial',
    axis: 'z',
    mm: 0,
    spacing_mm: 1,
    method: 'nearest_cortex_vertex',
    structures: [
      {
        id: 'Left-Cerebral-White-Matter',
        name: 'Left-Cerebral-White-Matter',
        label: 'белое вещество (слева)',
        hulls: [
          [
            [-60, -60],
            [-10, -60],
            [-10, -10],
            [-60, -10],
          ],
        ],
        area_mm2: 2500,
      },
      {
        id: 'Left-Thalamus-Proper',
        name: 'Left-Thalamus-Proper',
        label: 'таламус (слева)',
        hulls: [
          [
            [-30, -30],
            [-20, -30],
            [-20, -20],
            [-30, -20],
          ],
        ],
        area_mm2: 100,
      },
    ],
    areas: [
      {
        id: 'BA17-lh',
        name: 'BA17',
        label: 'поле 17 (слева)',
        hulls: [
          [
            [10, -55],
            [30, -55],
            [30, -45],
            [10, -45],
          ],
        ],
        area_mm2: 200,
      },
    ],
    ...overrides,
  }
}

export const initStatusFixture: InitStatus = {
  checks: {
    mne: 'ready',
    config: 'ready',
    database: 'ready',
    fsaverage: 'ready',
    transform: 'error',
    bem: 'ready',
  },
  status: 'pending',
  versions: { python: '3.12.3', mne: '1.13.2', numpy: '2.5.3', trimesh: '5.1.0' },
  code: { code_mtime: '2026-09-24T12:00:00', server_started_at: '2026-09-24T12:00:05', stale: false },
  ui: { built: false, url: '/ui/', legacy_url: '/legacy' },
  paths: {
    subjects_dir: '/home/user/mne_data/MNE-fsaverage-data',
    fsaverage_trans: '/home/user/mne_data/fsaverage-trans.fif',
    upload_dir: '/home/user/DipLock/data/edf',
    results_dir: '/home/user/DipLock/data/results',
    cache_dir: '/home/user/DipLock/data/cache',
  },
  // Занятость кэша записей (N40/4.6): 12.5 МБ, 3 единицы, квота 256 МБ
  cache: { usage_bytes: 13_107_200, units: 3, quota_bytes: 268_435_456 },
  api: { prefix: '/api/v1', docs_url: '/docs', meta_url: '/api/v1/meta' },
}

/** Локальный ресурс (GET /resource): рабочий GPU/CuPy, тумблер выключен. */
export const localResourceFixture: LocalResource = {
  gpu: {
    present: true,
    name: 'NVIDIA RTX A4000',
    cupy: true,
    usable: true,
    mem_total_mb: 16376,
    mem_free_mb: 15120,
    reason: null,
  },
  use_cuda: false,
}

export const recordingFixture: RecordingMeta = {
  recording_id: 'rec-1',
  filename: 'probe.edf',
  n_channels: 10,
  channels: [...metaFixture.standard_channels],
  // Виртуальные каналы «ЭЭГ»: тот же состав, что вернул бы сервер для монтажа
  // `standard_channels` (`services/channel_mix.py`) — вариант есть только для
  // непустой группы
  mixes: [
    {
      id: 'mix:all',
      label: 'Все каналы',
      group: 'all',
      channels: [...metaFixture.standard_channels],
    },
    {
      id: 'mix:left',
      label: 'Левое полушарие',
      group: 'left',
      channels: ['Fp1', 'F3', 'C3', 'P3', 'O1', 'F7', 'T7', 'P7'],
    },
    {
      id: 'mix:right',
      label: 'Правое полушарие',
      group: 'right',
      channels: ['Fp2', 'F4', 'C4', 'P4', 'O2', 'F8', 'T8', 'P8'],
    },
    {
      id: 'mix:frontal',
      label: 'Лобные',
      group: 'frontal',
      channels: ['Fp1', 'Fp2', 'F3', 'F4', 'F7', 'F8', 'Fz'],
    },
    {
      id: 'mix:temporal',
      label: 'Височные',
      group: 'temporal',
      channels: ['F7', 'F8', 'T7', 'T8', 'P7', 'P8'],
    },
    { id: 'mix:central', label: 'Центральные', group: 'central', channels: ['C3', 'C4', 'Cz'] },
    {
      id: 'mix:parietal',
      label: 'Теменные',
      group: 'parietal',
      channels: ['P3', 'P4', 'P7', 'P8', 'Pz'],
    },
    { id: 'mix:occipital', label: 'Затылочные', group: 'occipital', channels: ['O1', 'O2', 'Oz'] },
  ],
  unmatched_channels: [],
  sfreq: 250,
  duration_sec: 30,
  units_autoscaled: false,
  edf_units: null,
  // События записи (N2/2.7): маркер стим-канала и длительная аннотация файла
  events: [
    { onset: 2, duration: 0, description: 'STIM/5', source: 'stim' },
    { onset: 6, duration: 0.5, description: 'Sound/On', source: 'annotation' },
    { onset: 12, duration: 0, description: 'STIM/5', source: 'stim' },
  ],
  event_counts: { 'STIM/5': 2, 'Sound/On': 1 },
  warnings: [],
  created_at: '2026-09-13T09:00:00',
  deduplicated: false,
}

export const jobFixture: JobStatus = {
  job_id: 'job-1',
  kind: 'analyze',
  status: 'running',
  stage: 'dipoles',
  progress: 0.9,
  message: 'Фитинг диполей по эпохам',
  epochs_done: 0,
  epochs_total: 0,
  filename: 'rec.edf',
  session_id: null,
  created_at: '2026-09-13T09:00:00',
  started_at: '2026-09-13T09:00:01',
  finished_at: null,
  elapsed_sec: 12.5,
  error: null,
  error_traceback: null,
  result_url: null,
}

/** Завершённая задача предподготовки (срез 2.7) — её опрашивает стор записи. */
export const preprocessJobFixture: JobStatus = {
  job_id: 'job-pre-1',
  kind: 'preprocess',
  status: 'succeeded',
  stage: 'done',
  progress: 1,
  message: 'Найдено артефактов: 2',
  epochs_done: 0,
  epochs_total: 0,
  filename: 'probe.edf',
  session_id: null,
  created_at: '2026-09-13T09:00:00',
  started_at: '2026-09-13T09:00:01',
  finished_at: '2026-09-13T09:00:02',
  elapsed_sec: 1.2,
  error: null,
  error_traceback: null,
  result_url: '/api/v1/recordings/rec-1/preprocess/job-pre-1',
}

/**
 * Результат стадии предподготовки: заполнены только «свои» поля, как отдаёт
 * бэкенд (`PreprocessResult`). Для `filter` — только параметры сигнала.
 */
export function preprocessResultFixture(
  stage: PreprocessStage = 'artifacts',
  overrides: Partial<PreprocessResult> = {},
): PreprocessResult {
  return {
    recording_id: recordingFixture.recording_id,
    stage,
    channels: [...(recordingFixture.channels ?? [])],
    band_hz: stage === 'filter' ? [1, 40] : null,
    notch_hz: stage === 'filter' ? 50 : null,
    reference: 'average',
    filter_method: stage === 'filter' ? 'fir' : 'none',
    filter_length_sec: stage === 'filter' ? 3.302 : null,
    edge_buffer_sec: stage === 'filter' ? 1.651 : 0,
    sfreq: recordingFixture.sfreq,
    duration_sec: recordingFixture.duration_sec,
    good_data_percent: 100,
    artifact_share_by_kind: {},
    line_noise_level: null,
    bad_channels: [],
    snr_db_median: 12.5,
    dead_channels: [],
    record_status: 'ok',
    record_status_reasons: [],
    qc_snr_warn_db: 10,
    qc_snr_bad_db: 5,
    clean: null,
    artifacts:
      stage === 'artifacts'
        ? [
            {
              kind: 'zscore_outlier',
              onset_sec: 4,
              duration_sec: 0.5,
              channels: ['F3', 'C3'],
            },
            {
              kind: 'peak_to_peak',
              onset_sec: 12,
              duration_sec: 2,
              channels: ['Fp1'],
            },
          ]
        : [],
    // Ряд ЧСС (трек пульса): по умолчанию ритм не извлечён — тесты переопределяют
    heart_rate: null,
    artifact_types: {
      zscore_outlier: stage === 'artifacts' ? 1 : 0,
      peak_to_peak: stage === 'artifacts' ? 1 : 0,
      flat_line: 0,
      ica_eog: 0,
    },
    ica_applied: false,
    channel_qc: [],
    qc_warn_share: 0.05,
    qc_bad_share: 0.2,
    epoch_length_ms: stage === 'epochs' ? 2000 : 0,
    // Событийный режим (N2/2.7): фикстура по умолчанию — фиксированная нарезка
    epoch_mode: 'fixed',
    event_id: null,
    epoch_pre_ms: 0,
    epoch_post_ms: 0,
    epoch_starts_sec: null,
    n_epochs_total: stage === 'epochs' ? 15 : 0,
    n_epochs_used: stage === 'epochs' ? 13 : 0,
    rejected_epochs: stage === 'epochs' ? [2, 7] : [],
    rejected_epoch_channels:
      stage === 'epochs'
        ? [
            { index: 2, channels: ['F3', 'C3'] },
            { index: 7, channels: [] },
          ]
        : [],
    warnings: [],
    duration_sec_calc: 0.4,
    ...overrides,
  }
}

/**
 * Результат задачи ERP (шаг 2.7): усреднённая волна по событию STIM/5.
 * Синтетика — синус ~20 мкВ от момента события, ось −200…800 мс.
 */
export function evokedResultFixture(overrides: Partial<EvokedResult> = {}): EvokedResult {
  const times = Array.from({ length: 51 }, (_unused, index) => Math.round((-0.2 + index * 0.02) * 1000) / 1000)
  return {
    recording_id: recordingFixture.recording_id,
    event_id: 'STIM/5',
    tmin: -0.2,
    tmax: 0.8,
    sfreq: 50,
    times,
    channels: [...(recordingFixture.channels ?? [])],
    data_uv: (recordingFixture.channels ?? []).map((_channel, channelIndex) =>
      times.map(
        (timeSec) =>
          Math.round(Math.sin((timeSec + 0.2) * 10 + channelIndex) * 20 * 1000) / 1000,
      ),
    ),
    baseline: null,
    n_total: 2,
    n_used: 2,
    rejected_epochs: [],
    warnings: [],
    duration_sec_calc: 0.3,
    ...overrides,
  }
}

/**
 * АЧХ применяемого фильтра (шаг 2.5): полоса 1–40 Гц @500 Гц, ядро 1651 тап.
 * Числа совпадают с расчётом `services/filter_design.py` на текущей версии MNE.
 */
export function filterResponseFixture(
  overrides: Partial<FilterResponse> = {},
): FilterResponse {
  const freqs: number[] = []
  const gains: number[] = []
  for (let f = 0; f <= 250; f += 0.5) {
    freqs.push(f)
    const inBand = f >= 1 && f <= 40
    const atNotch = Math.abs(f - 50) < 1
    gains.push(inBand ? 0 : atNotch ? -60 : f < 1 || f > 60 ? -60 : -3)
  }
  return {
    freqs_hz: freqs,
    gain_db: gains,
    method: 'fir',
    band_hz: [1, 40],
    l_trans_bandwidth_hz: 1,
    h_trans_bandwidth_hz: 10,
    filter_length_sec: 3.302,
    edge_buffer_sec: 1.651,
    notch_freqs: [50],
    sfreq: 500,
    ...overrides,
  }
}

/**
 * Сигнал сетевого фона (`GET /recordings/{id}/mains`): линии 50/100 Гц,
 * вырезанная компонента — синус 50 Гц 2.5 мкВ, «канал с максимумом» T7.
 */
export function mainsFixture(overrides: Partial<MainsResponse> = {}): MainsResponse {
  const times: number[] = []
  const trace: number[] = []
  for (let i = 0; i <= 300; i++) {
    const t = i / 60
    times.push(Number(t.toFixed(3)))
    trace.push(Number((2.5 * Math.sin(2 * Math.PI * 50 * t)).toFixed(3)))
  }
  return {
    freqs_hz: [50, 100],
    level_db: [18.4, 7.2],
    trace_times_sec: times,
    trace_uv: trace,
    removed_rms_uv: 1.768,
    channel: 'T7',
    start_sec: 0.752,
    duration_sec: 5,
    notch_hz: 50,
    notch_harmonics: 1,
    sfreq: 500,
    ...overrides,
  }
}

/**
 * Завершённая задача раздела «Диполи» (срез 3.4): её опрашивает стор расчёта.
 * `epochs_done`/`epochs_total` — детальный прогресс по эпохам.
 */
export const calcJobFixture: JobStatus = {
  job_id: 'job-calc-1',
  kind: 'dipoles',
  status: 'succeeded',
  stage: 'done',
  progress: 1,
  message: 'Диполей: 4 (быстрый режим, сетка 7 мм)',
  epochs_done: 4,
  epochs_total: 4,
  filename: 'probe.edf',
  session_id: null,
  created_at: '2026-09-15T09:00:00',
  started_at: '2026-09-15T09:00:01',
  finished_at: '2026-09-15T09:00:04',
  elapsed_sec: 3.1,
  error: null,
  error_traceback: null,
  result_url: '/api/v1/recordings/rec-1/dipoles/job-calc-1',
}

/** Спектр по диапазонам: числа PSD + ссылки на топокарты (срез 3.4). */
export function spectrumResultFixture(
  overrides: Partial<SpectrumResult> = {},
): SpectrumResult {
  // 7 базовых полос сетки (фаза A): γ частично внутри полосы фильтра 1–40 Гц —
  // измерена, γ-high целиком вне её — «не измерено» (именно null, а не 0)
  const bands: SpectrumBandOut[] = [
    { name: 'delta', fmin: 0.5, fmax: 2, power_uv2: 2.5, relative_power: 0.11,
      median_power_uv2: 2.4, q25_power_uv2: 2.1, q75_power_uv2: 2.8,
      topomap_url: topomapUrl('delta') },
    { name: 'delta_theta', fmin: 2, fmax: 4, power_uv2: 3.0, relative_power: 0.13,
      median_power_uv2: 2.9, q25_power_uv2: 2.6, q75_power_uv2: 3.3,
      topomap_url: topomapUrl('delta_theta') },
    { name: 'theta', fmin: 4, fmax: 8, power_uv2: 3.5, relative_power: 0.15,
      median_power_uv2: 3.4, q25_power_uv2: 3.0, q75_power_uv2: 3.9,
      topomap_url: topomapUrl('theta') },
    { name: 'alpha', fmin: 8, fmax: 16, power_uv2: 12.5, relative_power: 0.55,
      median_power_uv2: 12.2, q25_power_uv2: 11.0, q75_power_uv2: 13.4,
      topomap_url: topomapUrl('alpha') },
    { name: 'beta', fmin: 16, fmax: 32, power_uv2: 0.4, relative_power: 0.02,
      median_power_uv2: 0.4, q25_power_uv2: 0.3, q75_power_uv2: 0.5,
      topomap_url: topomapUrl('beta') },
    { name: 'gamma', fmin: 32, fmax: 64, power_uv2: 0.15, relative_power: 0.01,
      median_power_uv2: 0.1, q25_power_uv2: 0.1, q75_power_uv2: 0.2,
      topomap_url: topomapUrl('gamma') },
    { name: 'high_gamma', fmin: 64, fmax: 128, power_uv2: null, relative_power: null,
      median_power_uv2: null, q25_power_uv2: null, q75_power_uv2: null,
      topomap_url: null },
  ]
  return {
    recording_id: recordingFixture.recording_id,
    channels: [...(recordingFixture.channels ?? [])],
    missed_channels: [],
    sfreq: recordingFixture.sfreq,
    epoch_length_ms: 1000,
    n_epochs: 4,
    n_fft: 250,
    psd_method: 'welch',
    filter_band_hz: [1, 40],
    notch_hz: null,
    freqs: [1, 4, 8, 10, 13, 30, 40],
    psd_mean_uv2: [1, 2, 6, 12, 4, 2, 1],
    bands,
    iaf_hz: 10.2,
    theta_beta_ratio: 0.78,
    theta_alpha_beta_ratio: 3.56,
    // 1/f + пики (specparam): фон убывает, пик α — над ним
    aperiodic_exponent: 1.8,
    aperiodic_offset: 0.2,
    aperiodic_fit_uv2: [1.1, 0.6, 0.35, 0.28, 0.22, 0.09, 0.06],
    peaks: [{ center_hz: 10.2, amplitude_db: 12.4, bandwidth_hz: 1.8 }],
    fit_r_squared: 0.93,
    topomap_version: 'spec1234abcd',
    warnings: [],
    duration_sec_calc: 0.6,
    ...overrides,
  }
}

/** Результат точного уточнения эпохи (kind=dipole_refine, кнопка «Уточнить…»). */
export function dipoleRefineResultFixture(
  overrides: Partial<DipoleRefineResult> = {},
): DipoleRefineResult {
  const scan = dipoleScanResultFixture()
  const fast = scan.points?.[0]
  if (!fast) throw new Error('dipoleScanResultFixture: неожиданно пустые точки')
  return {
    recording_id: recordingFixture.recording_id,
    method: 'bem_fit',
    epoch_index: fast.epoch_index,
    time_ms: fast.time_ms,
    window_ms: [fast.time_ms - 10, fast.time_ms + 10],
    halfwin_ms: 0,
    fast_head_coords: [...fast.head_coords],
    fast_gof: fast.gof,
    grid_gof_bem: 0.81,
    shift_mm: 6.3,
    free_fit: true,
    point: {
      ...fast,
      head_coords: [fast.head_coords[0] + 4.1, fast.head_coords[1] + 2.2, fast.head_coords[2] + 3.5],
      mni_coords: fast.mni_coords
        ? [fast.mni_coords[0] + 4.3, fast.mni_coords[1] + 2.4, fast.mni_coords[2] + 3.3]
        : null,
      gof: 0.94,
    },
    warnings: [],
    duration_sec_calc: 3.2,
    ...overrides,
  }
}

/** Результат eLORETA одной эпохи (остаток B9): пик + ROI-доли, без карт. */
export function eloretaResultFixture(
  overrides: Partial<EloretaResult> = {},
): EloretaResult {
  const scan = dipoleScanResultFixture()
  const fast = scan.points?.[0]
  if (!fast) throw new Error('eloretaResultFixture: неожиданно пустые точки')
  return {
    recording_id: recordingFixture.recording_id,
    method: 'eloreta',
    epoch_index: fast.epoch_index,
    time_ms: fast.time_ms,
    window_ms: [fast.time_ms - 4, fast.time_ms + 4],
    halfwin_ms: 0,
    peak: {
      mni_mm: [-42.0, -18.0, 61.0],
      value: 0.0031,
      time_ms: fast.time_ms,
      structure_name: 'Left Precentral',
      structure_distance_mm: 1.8,
      area_name: 'BA4',
      area_distance_mm: 3.1,
      outside_brain: false,
    },
    roi: [
      { structure: 'Left Precentral', share: 0.42 },
      { structure: 'Right Precentral', share: 0.18 },
      { structure: 'Left Superior Frontal', share: 0.11 },
    ],
    other_share: 0.29,
    n_sources: 4098,
    n_channels: 18,
    lambda2: 1 / 9,
    warnings: [
      'eLORETA-решение на одной эпохе: пик и ROI — ориентир для перекрёстной проверки с быстрым расчётом и refine, а не замена точечного фита',
    ],
    duration_sec_calc: 4.7,
    ...overrides,
  }
}

/** URL топокарты диапазона — как его отдаёт бэкенд (версия добавляется клиентом). */
export function topomapUrl(band: string): string {
  return `/api/v1/recordings/${recordingFixture.recording_id}/spectrum/topomap/${band}.png`
}

/** Результат быстрого расчёта диполей: точки MNI с моментами (срез 3.4). */
export function dipoleScanResultFixture(
  overrides: Partial<DipoleScanResult> = {},
): DipoleScanResult {
  return {
    recording_id: recordingFixture.recording_id,
    method: 'fast_grid',
    brodmann_method: 'nearest_cortex_vertex',
    reference: 'average',
    reference_channels: null,
    channels: [...(recordingFixture.channels ?? [])],
    sfreq: recordingFixture.sfreq,
    epoch_length_ms: 1000,
    // «На параметрах по умолчанию»: полоса CALC_PARAM_DEFAULTS (широкий 0.5–128)
    filter_band_hz: [0.5, 128],
    notch_hz: null,
    n_epochs_total: 4,
    n_epochs_used: 4,
    grid_mm: 7,
    points: [
      dipolePoint(0, 120, [12, -34.5, 18], 60),
      dipolePoint(1, 140, [-20, 10, 42], 25),
      dipolePoint(2, 60, [30, 5, 30], 90),
      // Точка без MNI (fsaverage недоступен) — в слой проекций не попадёт
      dipolePointWithoutMni,
    ],
    warnings: [],
    duration_sec_calc: 3.1,
    ...overrides,
  }
}

/** Одна точка результата расчёта: позиция MNI, момент (единичный) и метрики. */
function dipolePoint(
  epochIndex: number,
  timeMs: number,
  mni: [number, number, number],
  amplitudeNaM: number,
): DipoleScanPoint {
  return {
    epoch_index: epochIndex,
    time_ms: timeMs,
    head_coords: [mni[0], mni[1], mni[2]],
    mni_coords: [...mni],
    moment: [0, 1, 0],
    amplitude_nam: amplitudeNaM,
    gof: 0.91,
    // RIV/CI (2.6/N23): типовые значения фикстуры; тесты перекрывают их явно
    riv: 0.12,
    ci_mm: 7.0,
    brodmann_area: 'BA17-lh',
    anatomical_structure: 'таламус (слева)',
    structure_distance_mm: 0.4,
    brodmann_distance_mm: 0.6,
    outside_brain: false,
  }
}

/**
 * Точка без MNI (fsaverage недоступен): координат нет — значит нет и структуры,
 * которую по ним читает сервер. Такой точки анатомию не «достраиваем» на клиенте.
 */
export const dipolePointWithoutMni = {
  ...dipolePoint(3, 200, [0, 0, 0], 80),
  mni_coords: null,
  anatomical_structure: null,
  structure_distance_mm: null,
  brodmann_distance_mm: null,
  outside_brain: null,
}

/** Результат расчёта спектрограммы («ЭЭГ»): метаданные сетки + ссылка на числа. */
export function spectrogramResultFixture(
  overrides: Partial<SpectrogramResult> = {},
): SpectrogramResult {
  return {
    recording_id: recordingFixture.recording_id,
    channel: 'Fp1',
    channels: [...(recordingFixture.channels ?? [])],
    mix_channels: [],
    sfreq: recordingFixture.sfreq,
    duration_sec: recordingFixture.duration_sec,
    window_ms: 1000,
    overlap_pct: 75,
    fmax_hz: 40,
    n_fft: 256,
    // «На параметрах по умолчанию»: полоса EEG_PARAM_DEFAULTS (широкий 0.5–128)
    filter_band_hz: [0.5, 128],
    notch_hz: null,
    reference: 'average',
    reference_channels: [],
    freqs: [0, 10, 20],
    times: [0.5, 0.75, 1, 1.25],
    db_min: -60,
    db_max: 0,
    grid_url: `/api/v1/recordings/${recordingFixture.recording_id}/spectrogram/job-spec-1/grid.bin`,
    grid_version: 'spec1234abcd',
    warnings: [],
    duration_sec_calc: 0.4,
    ...overrides,
  }
}

/** Статус успешной задачи расчёта спектрограммы (поллинг в UI). */
export const spectrogramJobFixture: JobStatus = {
  job_id: 'job-spec-1',
  kind: 'spectrogram',
  status: 'succeeded',
  stage: 'done',
  progress: 1,
  message: 'Спектрограмма готова',
  epochs_done: 4,
  epochs_total: 4,
  filename: 'test.edf',
  session_id: null,
  created_at: '2026-09-15T09:00:00',
  started_at: '2026-09-15T09:00:01',
  finished_at: '2026-09-15T09:00:02',
  elapsed_sec: 0.4,
  error: null,
  error_traceback: null,
  result_url: `/api/v1/recordings/${recordingFixture.recording_id}/spectrogram/job-spec-1`,
}

/** Агрегат одной полосы пакета в части 2 отчёта (топ структур/BA + динамика). */
export function reportBandFixture(bandKey: string): ReportBandSummary {
  const bounds = bandKey === 'alpha' ? [8, 16] : bandKey === 'beta' ? [16, 32] : [4, 8]
  return {
    band_key: bandKey,
    band_hz: bounds,
    n_epochs_used: 9,
    n_points: 9,
    n_no_attribution: 0,
    median_gof: 0.82,
    top_structures: [{ name: 'Precuneus', count: 5, share: 5 / 9, median_gof: 0.85 }],
    top_brodmann: [{ name: 'BA7-lh', count: 5, share: 5 / 9, median_gof: 0.85 }],
    dynamics: [{ name: 'Precuneus', shares: [0.2, 0.4, 0.6, 0.4, 0.2] }],
    warnings: [],
  }
}

/** ROI-агрегат пакета (4.5): две полосы, структуры и поле БА с ячейками. */
export function roiAggregateFixture(): RoiAggregate {
  const cell = (count: number, gofPass: number): RoiBandCell => ({
    count,
    share: count / 9,
    median_gof: 0.83,
    median_amplitude_nam: 12.5,
    gof_pass: gofPass,
  })
  return {
    gof_threshold: 0.8,
    bands: ['theta', 'alpha'],
    n_points_total: 18,
    structures: [
      {
        name: 'Precuneus (слева)',
        hemisphere: 'lh',
        count: 10,
        bands: { theta: cell(5, 4), alpha: cell(5, 3) },
      },
      {
        name: 'таламус (справа)',
        hemisphere: 'rh',
        count: 6,
        bands: { theta: cell(3, 2), alpha: cell(3, 1) },
      },
    ],
    brodmann: [
      {
        name: 'BA7-lh',
        hemisphere: 'lh',
        count: 10,
        bands: { theta: cell(5, 4), alpha: cell(5, 3) },
      },
    ],
    n_structure_names: 4,
    n_brodmann_names: 3,
    hemisphere_counts: { lh: 10, rh: 6, mid: 1 },
    n_without_structure: 1,
  }
}

/** Сквозной автоотчёт (раздел «Итоги»): агрегаты QC, эпох и полос пакета. */
export function reportResultFixture(overrides: Partial<ReportResult> = {}): ReportResult {
  return {
    recording_id: recordingFixture.recording_id,
    filename: 'probe.edf',
    html_sig: 'sig1234abcd0000',
    report_version: 'rep1234abcd0000',
    html_url: `/api/v1/recordings/${recordingFixture.recording_id}/report/job-report-1/html`,
    qc: {
      status: 'ok',
      reasons: [],
      good_data_percent: 98.5,
      snr_db_median: 12.5,
      n_channels: 3,
    },
    reference: 'average',
    filter_method: 'fir',
    n_epochs_total: 10,
    n_epochs_used: 9,
    rejected_epochs: 1,
    bands: [reportBandFixture('theta'), reportBandFixture('alpha')],
    roi: roiAggregateFixture(),
    warnings: ['[Фильтр и референс] Переходный процесс FIR-фильтра: ±0.42 с у краёв записи'],
    duration_sec_calc: 12.3,
    ...overrides,
  }
}

/**
 * Метаданные HTML-отчёта «Итогов» по результату группового анализа
 * (`GET …/report`): ленивая сборка — сервер отдаёт подпись и ссылку на ассет.
 */
export function reportHtmlOutFixture(overrides: Partial<ReportHtmlOut> = {}): ReportHtmlOut {
  return {
    title: 'Сравнение: Покой ↔ Деятельность',
    html_sig: 'sig0000abcd0000ef',
    report_version: 'ghrep0rt0000abcd',
    html_url: '/api/v1/compare/job-compare-1/report/html',
    warnings: [],
    ...overrides,
  }
}

/** Строки `GET /sessions` для выбора пары сравнения (две записи, по 2 сессии). */
export const sessionsFixture: { total: number; items: SessionSummary[] } = {
  total: 3,
  items: [
    {
      id: 'sess-1', recording_id: 'rec-rest', kind: 'preprocess', filename: 'rest.edf',
      n_channels: 10, sfreq: 250, duration_sec: 120, epoch_length_ms: 2000,
      n_epochs: 60, n_epochs_rejected: 2, n_dipoles: 0, created_at: '2026-10-01T10:00:00',
    },
    {
      id: 'sess-2', recording_id: 'rec-rest', kind: 'spectrum', filename: 'rest.edf',
      n_channels: 10, sfreq: 250, duration_sec: 120, epoch_length_ms: 2000,
      n_epochs: 60, n_epochs_rejected: 2, n_dipoles: 0, created_at: '2026-10-01T10:05:00',
    },
    {
      id: 'sess-3', recording_id: 'rec-task', kind: 'preprocess', filename: 'task.edf',
      n_channels: 10, sfreq: 250, duration_sec: 120, epoch_length_ms: 2000,
      n_epochs: 60, n_epochs_rejected: 4, n_dipoles: 0, created_at: '2026-10-01T11:00:00',
    },
  ],
}

/** Результат сравнения двух записей (B9): дельта по α + значимый кластер. */
export function compareResultFixture(
  overrides: Partial<CompareResult> = {},
): CompareResult {
  return {
    signature: 'abc123def4567890',
    side_a: {
      recording_id: 'rec-rest', filename: 'rest.edf', label: 'Покой',
      n_epochs: 60, n_channels: 10,
    },
    side_b: {
      recording_id: 'rec-task', filename: 'task.edf', label: 'Деятельность',
      n_epochs: 58, n_channels: 10,
    },
    match: {
      sfreq: 250, filter_band_hz: [1, 40], notch_hz: null, epoch_length_ms: 2000,
      psd_method: 'welch', reference: 'average',
      channels: ['Fp1', 'Fp2', 'F3', 'F4', 'C3', 'C4', 'P3', 'P4', 'O1', 'O2'],
      channels_only_a: [], channels_only_b: ['T3'],
    },
    freqs: [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40],
    psd_mean_a_uv2: [8, 6, 5, 4, 4, 5, 9, 7, 4, 3, 2, 1.5, 1],
    psd_mean_b_uv2: [8, 6, 5, 4, 4, 6, 60, 9, 4, 3, 2, 1.5, 1],
    psd_delta_db: [0, 0, 0, 0, 0, 0.8, 8.3, 1.1, 0, 0, 0, 0, 0],
    bands: [
      {
        name: 'alpha', fmin: 8, fmax: 13, power_a_uv2: 9.1, power_b_uv2: 61.2,
        delta_uv2: 52.1, delta_db: 8.3, relative_power_a: 0.3, relative_power_b: 0.55,
        median_a_uv2: 9.0, median_b_uv2: 60.8, ci95_delta_db: [7.1, 9.5],
        effect: 2.4, p_value: 0.0004, q_value: 0.003,
        fdr_significant_channels: ['O1', 'O2', 'P3', 'P4'],
        topomap_delta_url: '/api/v1/compare/topomap/alpha.png?recording_id_a=rec-rest&recording_id_b=rec-task',
      },
      {
        name: 'theta', fmin: 4, fmax: 8, power_a_uv2: 4.0, power_b_uv2: 4.2,
        delta_uv2: 0.2, delta_db: 0.2, relative_power_a: 0.13, relative_power_b: 0.14,
        median_a_uv2: 4.0, median_b_uv2: 4.1, ci95_delta_db: [-0.5, 0.9],
        effect: 0.1, p_value: 0.62, q_value: 0.71,
        fdr_significant_channels: [], topomap_delta_url: null,
      },
    ],
    indices: {
      iaf_a_hz: 10.0, iaf_b_hz: 10.2, delta_iaf_hz: 0.2,
      theta_beta_a: 1.4, theta_beta_b: 1.5, delta_theta_beta: 0.1,
      theta_alpha_beta_a: 2.1, theta_alpha_beta_b: 2.2, delta_theta_alpha_beta: 0.1,
    },
    specparam: {
      exponent_a: 1.4, exponent_b: 1.1, delta_exponent: -0.3,
      offset_a: 2.1, offset_b: 2.4, delta_offset: 0.3,
      fit_r_squared_a: 0.98, fit_r_squared_b: 0.97, peaks_a: [], peaks_b: [],
    },
    stats: {
      method: 'permutation_cluster_test', n_permutations: 1024, alpha: 0.05,
      n_clusters: 3, n_significant: 1,
      clusters: [
        {
          p_value: 0.01, significant: true, channels: ['O1', 'O2', 'P3', 'P4'],
          freq_min_hz: 8.8, freq_max_hz: 11.7, n_points: 24,
          mean_delta_db: 7.9, direction: 'B>A',
        },
        {
          p_value: 0.4, significant: false, channels: ['F7'],
          freq_min_hz: 20.0, freq_max_hz: 22.0, n_points: 4,
          mean_delta_db: -0.3, direction: 'A>B',
        },
      ],
    },
    topomap_version: 'abc123def4567890',
    notes: [
      'Кластерный тест указывает на связку «частота × канал», но не доказывает значимость каждой её точки отдельно (Sassenhagen & Draschkow, 2019).',
      'Эпохи внутри записи автокоррелированы: эффективная выборка меньше числа эпох, поэтому p-значения могут быть оптимистичными.',
      'Дельты считаются по общим каналам пары и при одинаковой обработке (см. «совпадение параметров»); направление дельт — B − A.',
    ],
    warnings: ['Каналы вне пересечения исключены из сравнения: B: T3'],
    duration_sec_calc: 3.2,
    ...overrides,
  }
}

/** Событийная ветка TFR/ERDS результата сравнения (остаток B9): 2 полосы, малая карта. */
export function compareErdsFixture(): NonNullable<CompareResult['erds']> {
  const times = Array.from({ length: 5 }, (_, index) => -0.4 + index * 0.2)
  const freqs = [4, 8, 12]
  const grid = (value: number) => freqs.map((freq) => times.map((_t, index) => value + freq * 0.1 + index))
  return {
    event_id: 'STIM/5',
    tmin: -0.5,
    tmax: 1.5,
    baseline: [-500, -100],
    freqs,
    times,
    n_channels: 8,
    n_epochs_a: 12,
    n_epochs_b: 11,
    erds_a: grid(0),
    erds_b: grid(40),
    delta: grid(40),
    delta_png: 'data:image/png;base64,AAAA',
    bands: [
      {
        name: 'alpha', fmin: 8, fmax: 13,
        erds_a_post: 2.5, erds_b_post: 55.4, delta_post: 52.9,
        p_value: 0.002, q_value: 0.01, ci95_delta_pct: [30.1, 71.2],
      },
      {
        name: 'theta', fmin: 4, fmax: 8,
        erds_a_post: -1.2, erds_b_post: 3.4, delta_post: 4.6,
        p_value: 0.4, q_value: 0.6, ci95_delta_pct: null,
      },
    ],
    warnings: ['TFR по 12 (A) и 11 (B) событиям «STIM/5», сетка 40 × 101, 8 каналов (усреднение)'],
  }
}

/** Агрегат «BA × сессии» (остаток 4.7): две записи, две строки в каждом словаре. */
export function groupAggregateFixture(
  overrides: Partial<GroupAggregateOut> = {},
): GroupAggregateOut {
  const cell = (recordingId: string, count: number, share: number) => ({
    recording_id: recordingId,
    count,
    share,
  })
  const thalamus = {
    name: 'таламус (слева)',
    hemisphere: 'lh',
    count: 4,
    share: 0.8,
    mean_gof: 0.75,
    median_gof: 0.75,
    std_gof: 0.1118,
    mean_amplitude_nam: 52.5,
    std_amplitude_nam: 31.9,
    n_sessions: 2,
    cells: [cell('rec-rest', 2, 0.6667), cell('rec-task', 2, 1.0)],
  }
  const visual = {
    name: 'зрительная кора (справа)',
    hemisphere: 'rh',
    count: 1,
    share: 0.2,
    mean_gof: 0.85,
    median_gof: 0.85,
    std_gof: null,
    mean_amplitude_nam: 40,
    std_amplitude_nam: null,
    n_sessions: 1,
    cells: [cell('rec-rest', 1, 0.3333), cell('rec-task', 0, 0.0)],
  }
  return {
    filters: {
      band_key: 'alpha',
      band_hz: [8, 16],
      gof_min: null,
      epoch_length_ms: null,
      date_from: null,
      date_to: null,
      names: null,
      top_n: 12,
    },
    participants: [
      {
        recording_id: 'rec-rest', filename: 'rest.edf', analysis_id: 3,
        analysis_kind: 'fast_grid', analysis_created_at: '2026-10-02T10:00:00',
        n_points: 3,
      },
      {
        recording_id: 'rec-task', filename: 'task.edf', analysis_id: 5,
        analysis_kind: 'fast_grid', analysis_created_at: '2026-10-02T11:00:00',
        n_points: 2,
      },
    ],
    n_points_total: 5,
    structures: [thalamus, visual],
    brodmann: [
      { ...thalamus, name: 'BA7-lh' },
      { ...visual, name: 'BA17-rh' },
    ],
    n_structure_names: 2,
    n_brodmann_names: 2,
    clusters: [
      {
        centroid_mni: [-40.5, -17.5, 56],
        n_points: 4,
        n_sessions: 2,
        session_share: 1.0,
        volume_cm3: 1.728,
        density_per_cm3: 2.3,
        share: 0.8,
        extent_mm: [8, 6, 7],
        top_structures: ['таламус (слева)'],
        top_brodmann: ['BA7-lh'],
      },
    ],
    cluster_params: { voxel_mm: 12, min_points: 4, connectivity: 26 },
    notes: [
      'GOF и амплитуда момента считаются только внутри своей полосы — между полосами они не сравнимы (узкая полоса завышает R², принцип 3).',
      'share строки — доля от всех точек выборки в полосе; доля ячейки — от точек своей записи.',
    ],
    warnings: [],
    duration_sec_calc: 0.012,
    ...overrides,
  }
}

/** Строка истории прогонов группового анализа (`GET /group/analyses`). */
export function groupRunSummaryFixture(
  overrides: Partial<GroupAnalysisSummary> = {},
): GroupAnalysisSummary {
  return {
    id: 7,
    name: 'покой vs деятельность',
    band_key: 'alpha',
    created_at: '2026-10-03T12:00:00',
    n_sessions_requested: 2,
    n_members_alive: 2,
    params_sig: 'abcdef0123456789',
    ...overrides,
  }
}

/** Результат задачи пакета сессии (`kind=bundle`, 4.6). */
export function bundleResultFixture(overrides: Partial<BundleResult> = {}): BundleResult {
  return {
    format: 'session',
    sig: 'a1b2c3d4e5f60718',
    files: ['manifest.json', 'passport.json', 'edf/probe.edf'],
    size_bytes: 4_194_304,
    warnings: [],
    zip_url: null,
    ...overrides,
  }
}


