/**
 * HTTP-клиент бэкенда: одна точка для запросов и разбора ошибок.
 *
 * В dev-режиме запросы уходят на Vite dev-server и проксируются на :8000
 * (same-origin, CORS не нужен). В собранном виде UI раздаёт сам FastAPI.
 */
import type {
  AnalyzeResponse,
  InitStatus,
  JobCreated,
  JobStatus,
  MetaResponse,
  RecordingMeta,
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

  const body = await parseBody(response)
  if (!response.ok) {
    const detail = (body as { detail?: unknown } | undefined)?.detail ?? body
    throw new ApiError(
      typeof detail === 'string' ? detail : `Ошибка запроса (HTTP ${response.status})`,
      response.status,
      detail,
    )
  }
  return body as T
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

export const api = {
  /** Версии, пути и активные параметры сервера. */
  meta: (signal?: AbortSignal) => request<MetaResponse>(`${API_PREFIX}/meta`, { signal }),

  /** Готовность компонентов (MNE, БД, fsaverage, BEM). */
  initStatus: (signal?: AbortSignal) => request<InitStatus>('/init-status', { signal }),

  /** Запуск анализа фоновой задачей (основной вход для UI). */
  createAnalysisJob: (form: FormData, signal?: AbortSignal) =>
    request<JobCreated>(`${API_PREFIX}/jobs`, { method: 'POST', body: form, signal }),

  /** Состояние задачи: этап, прогресс 0..1, ошибка. */
  job: (jobId: string, signal?: AbortSignal) =>
    request<JobStatus>(`${API_PREFIX}/jobs/${jobId}`, { signal }),

  /** Результат завершённой задачи. */
  jobResult: (jobId: string, signal?: AbortSignal) =>
    request<AnalyzeResponse>(`${API_PREFIX}/jobs/${jobId}/result`, { signal }),

  /** История задач (новые — в конце). */
  jobs: (limit = 20, signal?: AbortSignal) =>
    request<JobStatus[]>(`${API_PREFIX}/jobs?limit=${limit}`, { signal }),

  /** Паспорт загруженной записи (метаданные, без обработки). */
  recording: (recordingId: string, signal?: AbortSignal) =>
    request<RecordingMeta>(`${API_PREFIX}/recordings/${recordingId}`, { signal }),
}
