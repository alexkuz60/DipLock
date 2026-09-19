/**
 * Фикстуры ответов бэкенда для тестов UI (совпадают по форме со схемами API).
 */
import type {
  ContourSlice,
  DipoleScanPoint,
  DipoleRefineResult,
  DipoleScanResult,
  InitStatus,
  JobStatus,
  MetaResponse,
  PreprocessResult,
  PreprocessStage,
  RecordingMeta,
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
  epoch_lengths_ms: [250, 500, 750, 1000, 1250, 1500, 1750, 2000],
  freq_bands: { delta: [1, 4], theta: [4, 8], alpha: [8, 13], beta: [13, 30], gamma: [30, 40] },
  signal_levels: [1, 2, 4, 8, 16],
  signal_base_points: 4000,
  artifact_thresholds: {
    z_score_threshold: 5,
    peak_to_peak_threshold_uv: 100,
    flat_line_threshold_uv: 1,
    flat_line_min_duration_ms: 200,
    reject_threshold_uv: 150,
  },
  dipole_fit_decim: 5,
  dipole_fit_max_epochs: 0,
  dipole_fit_n_jobs: 1,
  dipole_fit_sec_per_point: 5.4,
  dipole_fit_experimental: true,
  max_concurrent_jobs: 2,
  cors_origins: ['http://localhost:5173'],
  mri_slices: {
    version: 'mri12345678',
    slice_url: '/api/v1/surface/mri/slice',
    spacing_mm: 1,
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
  ui: { built: false, url: '/ui/', legacy_url: '/legacy' },
  paths: {
    subjects_dir: '/home/user/mne_data/MNE-fsaverage-data',
    fsaverage_trans: '/home/user/mne_data/fsaverage-trans.fif',
    upload_dir: '/home/user/DipLock/data/edf',
    results_dir: '/home/user/DipLock/data/results',
    cache_dir: '/home/user/DipLock/data/cache',
  },
  api: { prefix: '/api/v1', docs_url: '/docs', meta_url: '/api/v1/meta' },
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
    channels: [...recordingFixture.channels],
    band_hz: stage === 'filter' ? [1, 40] : null,
    notch_hz: stage === 'filter' ? 50 : null,
    reference: 'average',
    sfreq: recordingFixture.sfreq,
    duration_sec: recordingFixture.duration_sec,
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
    n_epochs_total: stage === 'epochs' ? 15 : 0,
    n_epochs_used: stage === 'epochs' ? 13 : 0,
    rejected_epochs: stage === 'epochs' ? [2, 7] : [],
    warnings: [],
    duration_sec_calc: 0.4,
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
  const bands: SpectrumBandOut[] = [
    { name: 'delta', fmin: 1, fmax: 4, power_uv2: 2.5, relative_power: 0.11,
      median_power_uv2: 2.4, q25_power_uv2: 2.1, q75_power_uv2: 2.8,
      topomap_url: topomapUrl('delta') },
    { name: 'theta', fmin: 4, fmax: 8, power_uv2: 3.5, relative_power: 0.15,
      median_power_uv2: 3.4, q25_power_uv2: 3.0, q75_power_uv2: 3.9,
      topomap_url: topomapUrl('theta') },
    { name: 'alpha', fmin: 8, fmax: 13, power_uv2: 12.5, relative_power: 0.55,
      median_power_uv2: 12.2, q25_power_uv2: 11.0, q75_power_uv2: 13.4,
      topomap_url: topomapUrl('alpha') },
    { name: 'beta', fmin: 13, fmax: 30, power_uv2: 4.5, relative_power: 0.19,
      median_power_uv2: 4.4, q25_power_uv2: 4.0, q75_power_uv2: 4.9,
      topomap_url: topomapUrl('beta') },
    // γ вне узкой полосы фильтра: мощность «не измерена» — именно null, а не 0
    { name: 'gamma', fmin: 30, fmax: 40, power_uv2: null, relative_power: null,
      median_power_uv2: null, q25_power_uv2: null, q75_power_uv2: null,
      topomap_url: topomapUrl('gamma') },
  ]
  return {
    recording_id: recordingFixture.recording_id,
    channels: [...recordingFixture.channels],
    missed_channels: [],
    sfreq: recordingFixture.sfreq,
    epoch_length_ms: 1000,
    n_epochs: 4,
    n_fft: 250,
    filter_band_hz: [1, 40],
    notch_hz: null,
    reject_threshold_uv: 150,
    freqs: [1, 4, 8, 10, 13, 30, 40],
    psd_mean_uv2: [1, 2, 6, 12, 4, 2, 1],
    bands,
    iaf_hz: 10.2,
    theta_beta_ratio: 0.78,
    theta_alpha_beta_ratio: 3.56,
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
  const fast = scan.points[0]
  return {
    recording_id: recordingFixture.recording_id,
    method: 'bem_fit',
    epoch_index: fast.epoch_index,
    time_ms: fast.time_ms,
    window_ms: [fast.time_ms - 10, fast.time_ms + 10],
    fast_head_coords: [...fast.head_coords],
    fast_gof: fast.gof,
    grid_gof_bem: 0.81,
    shift_mm: 6.3,
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
    reference: 'average',
    reference_channels: null,
    channels: [...recordingFixture.channels],
    sfreq: recordingFixture.sfreq,
    epoch_length_ms: 1000,
    reject_threshold_uv: 150,
    filter_band_hz: [1, 40],
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
    brodmann_area: 'BA17-lh',
    anatomical_structure: 'таламус (слева)',
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
}

/** Результат расчёта спектрограммы («ЭЭГ»): метаданные сетки + ссылка на числа. */
export function spectrogramResultFixture(
  overrides: Partial<SpectrogramResult> = {},
): SpectrogramResult {
  return {
    recording_id: recordingFixture.recording_id,
    channel: 'Fp1',
    channels: [...recordingFixture.channels],
    mix_channels: [],
    sfreq: recordingFixture.sfreq,
    duration_sec: recordingFixture.duration_sec,
    window_ms: 1000,
    overlap_pct: 75,
    fmax_hz: 40,
    n_fft: 256,
    filter_band_hz: [1, 40],
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
