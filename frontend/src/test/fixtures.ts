/**
 * Фикстуры ответов бэкенда для тестов UI (совпадают по форме со схемами API).
 */
import type { InitStatus, JobStatus, MetaResponse, RecordingMeta } from '@/shared/api/types'

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
    flat_line_threshold_uv: 5,
    flat_line_min_duration_ms: 200,
    reject_threshold_uv: 150,
  },
  dipole_fit_decim: 5,
  dipole_fit_max_epochs: 0,
  max_concurrent_jobs: 2,
  cors_origins: ['http://localhost:5173'],
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
  unmatched_channels: [],
  sfreq: 250,
  duration_sec: 30,
  units_autoscaled: false,
  edf_units: null,
  warnings: [],
  created_at: '2026-09-13T09:00:00',
}

export const jobFixture: JobStatus = {
  job_id: 'job-1',
  kind: 'analyze',
  status: 'running',
  stage: 'dipoles',
  progress: 0.9,
  message: 'Фитинг диполей по эпохам',
  filename: 'rec.edf',
  session_id: null,
  created_at: '2026-09-13T09:00:00',
  started_at: '2026-09-13T09:00:01',
  finished_at: null,
  elapsed_sec: 12.5,
  error: null,
  result_url: null,
}
