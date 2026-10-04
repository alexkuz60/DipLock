/**
 * HTTP-клиент бэкенда: одна точка для запросов и разбора ошибок.
 *
 * В dev-режиме запросы уходят на Vite dev-server и проксируются на :8000
 * (same-origin, CORS не нужен). В собранном виде UI раздаёт сам FastAPI.
 */
import type {
  AnalyzeResponse,
  BundleResult,
  CompareResult,
  ContourSlice,
  DipoleRefineResult,
  DipoleScanResult,
  EloretaResult,
  EvokedResult,
  FilterResponse,
  GroupAggregateIn,
  GroupAggregateOut,
  GroupAnalysesPage,
  GroupAnalysisCreateIn,
  GroupAnalysisDetail,
  GroupAnalysisSummary,
  InitStatus,
  JobCreated,
  JobStatus,
  LocalResource,
  MainsResponse,
  MetaResponse,
  PreprocessResult,
  RecordingMeta,
  ReportHtmlOut,
  ReportResult,
  ServerRestart,
  SessionsPage,
  SignalLayer,
  SignalsPrepQuery,
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
  | 'report'
  | 'bundle'
  | 'eloreta'

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

  /** Локальный ресурс: автоопределение GPU + тумблер «Использовать GPU». */
  resource: (signal?: AbortSignal) => request<LocalResource>(`${API_PREFIX}/resource`, { signal }),

  /**
   * Переключить тумблер «Использовать GPU» (пишется в MNE-конфиг сервера).
   * 409 — включить нечего: CUDA недоступна, `detail` — причина для UI.
   */
  setResourceUseCuda: (useCuda: boolean, signal?: AbortSignal) =>
    request<LocalResource>(`${API_PREFIX}/resource`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ use_cuda: useCuda }),
      signal,
    }),

  /** Готовность компонентов (MNE, БД, fsaverage, BEM). */
  initStatus: (signal?: AbortSignal) => request<InitStatus>('/init-status', { signal }),

  /**
   * Перезапуск бэкенда из «Состояния сервера» (202 → exec через ~0.5 с).
   * 409 — dev-режим --reload / сервер не от лаунчера / идут задачи.
   */
  serverRestart: (signal?: AbortSignal) =>
    request<ServerRestart>(`${API_PREFIX}/server/restart`, { method: 'POST', signal }),

  /**
   * Контуры среза атласа (срез 3.9): структуры `aparc+aseg` и поля Бродмана.
   * URL собирает `shared/lib/atlasContours.ts` — срез квантуется к сетке атласа,
   * версия ассета уезжает в `?v=`, чтобы браузер не закэшировал старые контуры.
   */
  contourSlice: (url: string, signal?: AbortSignal) => request<ContourSlice>(url, { signal }),

  /** Запуск анализа фоновой задачей (основной вход для UI). */
  createAnalysisJob: (form: FormData, signal?: AbortSignal) =>
    request<JobCreated>(`${API_PREFIX}/jobs`, { method: 'POST', body: form, signal }),

  /**
   * Страница сессий (read-API 4.7): кандидаты записей для сравнения — у каждой
   * строки `recording_id` + `filename`. Листинга записей в API нет
   * (осознанно, `docs/rules/api-jobs.md`), санкционированный вход — сессии.
   */
  sessions: (query?: { limit?: number; recording_id?: string }, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (query?.limit) params.set('limit', String(query.limit))
    if (query?.recording_id) params.set('recording_id', query.recording_id)
    const search = params.toString()
    return request<SessionsPage>(
      `${API_PREFIX}/sessions${search ? `?${search}` : ''}`,
      { signal },
    )
  },

  /**
   * Дифференциальный анализ двух записей (B9): запуск — `POST /compare`
   * (FormData с обеими записями и параметрами спектра), результат —
   * `GET /compare/{job_id}` (`CompareResult`). Пара — не одна запись, поэтому
   * это не `recordingJob`.
   */
  compare: {
    start: (form: FormData, signal?: AbortSignal) =>
      request<JobCreated>(`${API_PREFIX}/compare`, { method: 'POST', body: form, signal }),
    result: (jobId: string, signal?: AbortSignal) =>
      request<CompareResult>(`${API_PREFIX}/compare/${jobId}`, { signal }),
    /**
     * Отчёт по результату сравнения — раздел «Итоги» (Тип 1): ленивая сборка
     * самодостаточного HTML, адрес ассета — в ответе (`html_url`).
     */
    report: (jobId: string, signal?: AbortSignal) =>
      request<ReportHtmlOut>(`${API_PREFIX}/compare/${jobId}/report`, { signal }),
  },

  /**
   * Групповой анализ (остаток 4.7): агрегаты «BA × сессии» и история прогонов.
   * Синхронные JSON-запросы (без MNE и задачи): расчёт — выборки по
   * `dipole_points`, поэтому запросы не питают job-очередь.
   */
  group: {
    /** Живой агрегат выборки (`POST /group/aggregate`). */
    aggregate: (payload: GroupAggregateIn, signal?: AbortSignal) =>
      request<GroupAggregateOut>(`${API_PREFIX}/group/aggregate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      }),
    /** Сохранить прогон — снимок определения (`POST /group/analyses`, 201). */
    save: (payload: GroupAnalysisCreateIn, signal?: AbortSignal) =>
      request<GroupAnalysisSummary>(`${API_PREFIX}/group/analyses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      }),
    /** История прогонов: страница новых сверху (`GET /group/analyses`). */
    runs: (query?: { limit?: number; offset?: number }, signal?: AbortSignal) => {
      const params = new URLSearchParams()
      if (query?.limit) params.set('limit', String(query.limit))
      if (query?.offset) params.set('offset', String(query.offset))
      const search = params.toString()
      return request<GroupAnalysesPage>(
        `${API_PREFIX}/group/analyses${search ? `?${search}` : ''}`,
        { signal },
      )
    },
    /** Прогон: паспорт + свежий пересчёт (`GET /group/analyses/{id}`; 404 — нет). */
    run: (runId: number, signal?: AbortSignal) =>
      request<GroupAnalysisDetail>(`${API_PREFIX}/group/analyses/${runId}`, { signal }),
    /**
     * Отчёт по прогону — раздел «Итоги» (Тип 2): ленивая сборка самодостаточного
     * HTML по свежему пересчёту агрегата, адрес ассета — в ответе (`html_url`).
     */
    report: (runId: number, signal?: AbortSignal) =>
      request<ReportHtmlOut>(`${API_PREFIX}/group/analyses/${runId}/report`, { signal }),
  },

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

  /**
   * Сигнал сетевого фона записи (Части 1 §7, L1): уровни линий сети и
   * вырезанная notch-компонентная. Как и АЧХ — только по явному раскрытию
   * блока «Сетевой фон» (правило: считает только кнопка).
   */
  mains: (
    recordingId: string,
    params: { notchHz: number; notchHarmonics: number },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams()
    query.set('notch_hz', String(params.notchHz))
    if (params.notchHarmonics > 0) {
      query.set('notch_harmonics', String(params.notchHarmonics))
    }
    return request<MainsResponse>(`${API_PREFIX}/recordings/${recordingId}/mains?${query}`, {
      signal,
    })
  },

  /** Паспорт загруженной записи (метаданные, без обработки). */
  recording: (recordingId: string, signal?: AbortSignal) =>
    request<RecordingMeta>(`${API_PREFIX}/recordings/${recordingId}`, { signal }),

  /**
   * Сигналы записи для вьюера: бинарный контейнер float32 (срез 2.5).
   * `level` — множитель зума из `signal_levels` (`/meta`); `options.layer` —
   * слой видимости (шаг 2 плана), `options.prep` — параметры подготовленной
   * базы слоёв `cleaned`/`diff` (форма стадии «Фильтр и референс» в query).
   */
  recordingSignals: async (
    recordingId: string,
    level: number,
    options?: {
      layer?: SignalLayer
      prep?: SignalsPrepQuery
      signal?: AbortSignal
    },
  ): Promise<ArrayBuffer> => {
    const layer = options?.layer ?? 'raw'
    const query = new URLSearchParams({ level: String(level), layer })
    // Параметры подготовки — только непустые: пустой query у сырого слоя
    // не меняет его семантику (сервер читает их только для cleaned/diff).
    if (layer !== 'raw') {
      for (const [key, value] of Object.entries(options?.prep ?? {})) {
        if (value !== undefined && value !== null && value !== '') {
          query.set(key, String(value))
        }
      }
    }
    const path = `${API_PREFIX}/recordings/${recordingId}/signals?${query.toString()}`
    let response: Response
    try {
      response = await fetch(path, { signal: options?.signal })
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
   * eLORETA (остаток B9, dipoles.md п.5): пик/ROI распределения одной эпохи.
   * Форма та же, что у «Уточнить» (нарезка быстрого расчёта); полные карты
   * не отдаются — контракт ограничен пиком и ROI-долями.
   */
  eloreta: recordingJob<EloretaResult>('eloreta'),

  /**
   * Спектрограмма канала («ЭЭГ»): в форме — канал, полоса фильтра и окно STFT.
   * Сетку чисел (`DPS2`) читает отдельный запрос — `api.spectrogramGrid`.
   */
  spectrogram: recordingJob<SpectrogramResult>('spectrogram'),

  /**
   * Сквозной автоотчёт («Итоги»): форма повторяет стадии EDF (фильтр, пороги,
   * очистка, длина эпохи) плюс `bands` (ключи пакета через запятую) и `grid_mm`;
   * результат — агрегаты + `html_url` (самодостаточный MNE.Report).
   */
  report: recordingJob<ReportResult>('report'),

  /**
   * Пакет сессии (N40/4.6): zip «EDF + параметры + результаты» (`format=session`)
   * или минимальный BIDS (`format=bids`). Результат — `zip_url` для скачивания.
   */
  bundle: recordingJob<BundleResult>('bundle'),

  /**
   * CSV таблицы диполей записи (RFC 4180, `Content-Disposition: attachment`) —
   * синхронная выгрузка готовых строк, задача не нужна.
   */
  dipolesCsv: (recordingId: string) => `${API_PREFIX}/recordings/${recordingId}/dipoles.csv`,

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
