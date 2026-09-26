/**
 * HTTP-клиент бэкенда: одна точка для запросов и разбора ошибок.
 *
 * В dev-режиме запросы уходят на Vite dev-server и проксируются на :8000
 * (same-origin, CORS не нужен). В собранном виде UI раздаёт сам FastAPI.
 */
import type {
  AnalyzeResponse,
  ContourSlice,
  DipoleRefineResult,
  DipoleScanResult,
  EvokedResult,
  FilterResponse,
  InitStatus,
  JobCreated,
  JobStatus,
  MetaResponse,
  PreprocessResult,
  RecordingMeta,
  SpectrogramResult,
  SpectrumResult,
} from './types'

export const API_PREFIX = '/api/v1'

export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(message: string, status: number, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      ...init,
    })
  } catch (cause) {
    throw new ApiError('Сервер недоступен (проверьте, запущен ли backend)', 0, cause)
  }

  if (!response.ok) await failWithBody(response)
  return (await parseBody(response)) as T
}

/** Ошибка по телу ответа: FastAPI кладёт понятное человеку объяснение в `detail`. */
async function failWithBody(response: Response): Promise<never> {
  const body = await parseBody(response)
  const detail = (body as { detail?: unknown } | undefined)?.detail ?? body
  throw new ApiError(
    typeof detail === 'string' ? detail : `Ошибка запроса (HTTP ${response.status})`,
    response.status,
    detail,
  )
}

/** Текстовое пояснение ошибки для UI (учитывает detail от FastAPI). */
export function apiErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (Array.isArray(error.detail)) {
      // Ошибки валидации FastAPI: [{loc, msg, type}, ...]
      return error.detail
        .map((item) => {
          const entry = item as { loc?: unknown[]; msg?: string }
          const where = Array.isArray(entry.loc) ? entry.loc.slice(1).join('.') : ''
          return where ? `${where}: ${entry.msg ?? ''}` : (entry.msg ?? '')
        })
        .filter(Boolean)
        .join('; ')
    }
    // FastAPI кладёт понятное человеку объяснение в detail — показываем именно его
    if (typeof error.detail === 'string' && error.detail.trim()) {
      return error.detail
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Вид задачи расчёта по записи: адреса её двух запросов отличает последний сегмент. */
export type RecordingJobKind =
  | 'preprocess'
  | 'spectrum'
  | 'dipoles'
  | 'spectrogram'
  | 'dipole_refine'
  | 'evoked'

/**
 * Пара запросов «запустить задачу / прочитать результат» (A10).
 *
 * Раньше это были восемь отдельных методов, отличавшихся только строкой URL:
 * новая задача добавляла ещё две копии адреса, а расхождение с сервером ловил
 * только тест-двойник. Теперь адрес собирается из одного `kind`.
 * Ожидание завершения — единый поллинг `shared/lib/jobPolling.ts`.
 */
export type RecordingJob<TResult> = {
  /** Запуск: `202` + `job_id`; форма — `FormData`, как ждёт FastAPI. */
  start: (recordingId: string, form: FormData, signal?: AbortSignal) => Promise<JobCreated>
  /** Результат завершённой задачи (адрес — тот же `kind` + `job_id`). */
  result: (recordingId: string, jobId: string, signal?: AbortSignal) => Promise<TResult>
}

/** Собрать пару запросов задачи по её виду: адрес живёт в одном месте. */
function recordingJob<TResult>(kind: RecordingJobKind): RecordingJob<TResult> {
  const path = (recordingId: string) => `${API_PREFIX}/recordings/${recordingId}/${kind}`
  return {
    start: (recordingId, form, signal) =>
      request<JobCreated>(path(recordingId), { method: 'POST', body: form, signal }),
    result: (recordingId, jobId, signal) =>
      request<TResult>(`${path(recordingId)}/${jobId}`, { signal }),
  }
}

export const api = {
  /** Версии, пути и активные параметры сервера. */
  meta: (signal?: AbortSignal) => request<MetaResponse>(`${API_PREFIX}/meta`, { signal }),

  /** Готовность компонентов (MNE, БД, fsaverage, BEM). */
  initStatus: (signal?: AbortSignal) => request<InitStatus>('/init-status', { signal }),

  /**
   * Контуры среза атласа (срез 3.9): структуры `aparc+aseg` и поля Бродмана.
   * URL собирает `shared/lib/atlasContours.ts` — срез квантуется к сетке атласа,
   * версия ассета уезжает в `?v=`, чтобы браузер не закэшировал старые контуры.
   */
  contourSlice: (url: string, signal?: AbortSignal) => request<ContourSlice>(url, { signal }),

  /** Запуск анализа фоновой задачей (основной вход для UI). */
  createAnalysisJob: (form: FormData, signal?: AbortSignal) =>
    request<JobCreated>(`${API_PREFIX}/jobs`, { method: 'POST', body: form, signal }),

  /** Состояние задачи: этап, прогресс 0..1, ошибка. */
  job: (jobId: string, signal?: AbortSignal) =>
    request<JobStatus>(`${API_PREFIX}/jobs/${jobId}`, { signal }),

  /** Отмена задачи (3.2): 200 — принята/уже отменена, 409 — завершена, 404 — нет. */
  jobCancel: (jobId: string, signal?: AbortSignal) =>
    request<JobStatus>(`${API_PREFIX}/jobs/${jobId}`, { method: 'DELETE', signal }),

  /** Результат завершённой задачи. */
  jobResult: (jobId: string, signal?: AbortSignal) =>
    request<AnalyzeResponse>(`${API_PREFIX}/jobs/${jobId}/result`, { signal }),

  /** История задач (новые — в конце). */
  jobs: (limit = 20, signal?: AbortSignal) =>
    request<JobStatus[]>(`${API_PREFIX}/jobs?limit=${limit}`, { signal }),

  /**
   * АЧХ применяемого фильтра (шаг 2.5, N11–N14): лёгкий расчёт без задачи.
   * Запрос делается только при явном раскрытии блока «АЧХ» — правка параметров
   * не запускает обработку и не шлёт запросов (правило UI).
   */
  filterResponse: (
    params: {
      band: [number, number] | null
      notchHz: number | null
      notchHarmonics: number
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams()
    if (params.band) {
      query.set('band_min', String(params.band[0]))
      query.set('band_max', String(params.band[1]))
    }
    if (params.notchHz) query.set('notch_hz', String(params.notchHz))
    if (params.notchHarmonics > 0) {
      query.set('notch_harmonics', String(params.notchHarmonics))
    }
    return request<FilterResponse>(`${API_PREFIX}/filter-response?${query}`, { signal })
  },

  /** Паспорт загруженной записи (метаданные, без обработки). */
  recording: (recordingId: string, signal?: AbortSignal) =>
    request<RecordingMeta>(`${API_PREFIX}/recordings/${recordingId}`, { signal }),

  /**
   * Сигналы записи для вьюера: бинарный контейнер float32 (срез 2.5).
   * `level` — множитель зума из `signal_levels` (`/meta`).
   */
  recordingSignals: async (
    recordingId: string,
    level: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> => {
    const path = `${API_PREFIX}/recordings/${recordingId}/signals?level=${level}`
    let response: Response
    try {
      response = await fetch(path, { signal })
    } catch (cause) {
      throw new ApiError('Сервер недоступен (проверьте, запущен ли backend)', 0, cause)
    }
    if (!response.ok) await failWithBody(response)
    return response.arrayBuffer()
  },

  /**
   * Стадии предподготовки записи (срез 2.7): одна стадия = одна задача.
   * В форме — `stage` и параметры стадии; прогресс — `api.job`.
   */
  preprocess: recordingJob<PreprocessResult>('preprocess'),

  /**
   * ERP-усреднение по событиям (шаг 2.7): стимул → эпоха → усреднение.
   * В форме — событие, окно до/после, baseline и параметры подготовки/отбраковки
   * (та же форма, что у стадии «Нарезка эпох», — числа согласованы со штриховкой).
   */
  evoked: recordingJob<EvokedResult>('evoked'),

  /** Спектр по диапазонам (срез 3.4): числа PSD и ссылки на топокарты. */
  spectrum: recordingJob<SpectrumResult>('spectrum'),

  /**
   * Быстрый расчёт диполей (срез 3.4): одна точка на эпоху, перебор сетки узлов.
   * Точный профиль (`mne.fit_dipole`) — отдельный срез, здесь `method: 'fast_grid'`.
   */
  dipoles: recordingJob<DipoleScanResult>('dipoles'),

  /** Точное уточнение одной эпохи (F19): BEM fit_dipole в окне пика GFP. */
  dipoleRefine: recordingJob<DipoleRefineResult>('dipole_refine'),

  /**
   * Спектрограмма канала («ЭЭГ»): в форме — канал, полоса фильтра и окно STFT.
   * Сетку чисел (`DPS2`) читает отдельный запрос — `api.spectrogramGrid`.
   */
  spectrogram: recordingJob<SpectrogramResult>('spectrogram'),

  /**
   * Сетка спектрограммы: бинарный контейнер float32 (``DPS2``, частото-мажорно).
   * URL берётся из результата задачи (`shared/lib/eegSpectrogram.ts`).
   */
  spectrogramGrid: async (url: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
    let response: Response
    try {
      response = await fetch(url, { signal })
    } catch (cause) {
      throw new ApiError('Сервер недоступен (проверьте, запущен ли backend)', 0, cause)
    }
    if (!response.ok) await failWithBody(response)
    return response.arrayBuffer()
  },
}
