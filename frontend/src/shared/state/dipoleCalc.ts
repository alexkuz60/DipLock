/**
 * Состояние расчёта раздела «Диполи» (срез 3.4): спектр по диапазонам, быстрый
 * расчёт диполей, порог «КД ≥ X нАм» и открытая выдвижная панель.
 *
 * Правило раздела то же, что в EDF (`docs/ui.md`): правка параметра **ничего не
 * запускает**. Расчёт стартует только кнопкой (`POST /recordings/{id}/dipoles`),
 * спектр — отдельной кнопкой (`…/spectrum`), а параметры лишь помечают, что
 * результат устарел.
 *
 * Что здесь, а что нет:
 * - в сторе — параметры расчёта (полоса, длина эпохи, порог reject, шаг сетки),
 *   порог отображения «КД», открытая выдвижная панель (`view`) и сами результаты
 *   задач (они принадлежат записи и сбрасываются при закрытии записи);
 * - в компонентах — отрисовка: топокарты и гистограмма считаются из результата
 *   чистыми функциями (`shared/lib/spectrum.ts`, `shared/lib/dipolePoints.ts`).
 *
 * Полоса фильтра пока фиксирована (1–40 Гц): форма фильтров δ/θ/α/β/γ —
 * следующий срез фазы 3 (`docs/ui.md` §3.3). Она живёт здесь, а не в `edfParams`,
 * чтобы расчёт диполей не менялся «незаметно» от правок предподготовки записи.
 *
 * Персистится только набор параметров: результаты задач относятся к конкретной
 * записи и после перезагрузки страницы бессмысленны.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiErrorText } from '@/shared/api/client'
import type { DipoleScanResult, JobStatus, SpectrumResult } from '@/shared/api/types'

/** Что открыто в выдвижной панели раздела: одна панель за раз. */
export type CalcView = 'none' | 'topomap' | 'fft'

/** Параметры расчёта, уходящие в форму запроса (и в URL топокарт). */
export type CalcParams = {
  /** Полоса фильтра, Гц; `null` — без фильтра */
  filterBandHz: [number, number] | null
  notchHz: number | null
  epochLengthMs: number
  rejectThresholdUv: number
  /** Шаг объёмной сетки поиска диполей, мм */
  gridMm: number
}

export const CALC_PARAM_DEFAULTS: CalcParams = {
  filterBandHz: [1, 40],
  notchHz: null,
  epochLengthMs: 1000,
  rejectThresholdUv: 150,
  gridMm: 7,
}

/** Ограничения контролов панели (совпадают со схемой формы на сервере). */
export const GRID_MM_RANGE: [number, number] = [2, 20]
export const THRESHOLD_NAM_RANGE: [number, number] = [0, 1000]

/** Состояние одной фоновой задачи раздела: прогресс по этапам и эпохам. */
export type CalcJob = {
  status: 'running' | 'succeeded' | 'failed'
  progress: number
  message: string
  stage: string
  epochsDone: number
  epochsTotal: number
  error: string | null
}

/** Задача из ответа сервера в состояние панели (одно место на обе задачи). */
export function calcJobFromStatus(job: JobStatus): CalcJob {
  return {
    status: job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : 'running',
    progress: job.progress,
    message: job.message,
    stage: job.stage,
    epochsDone: job.epochs_done,
    epochsTotal: job.epochs_total,
    error: job.status === 'failed' ? (job.error ?? 'Задача завершилась ошибкой') : null,
  }
}

/** Подпись хода задачи: этап, прогресс и «N из M эпох», когда они есть. */
export function calcJobSummary(job: CalcJob | null): string {
  if (job === null) return 'Расчёт не запускался'
  if (job.status === 'failed') return `Ошибка: ${job.error ?? 'задача завершилась ошибкой'}`
  const parts = [job.message || job.stage]
  if (job.epochsTotal > 0) parts.push(`эпох ${job.epochsDone} из ${job.epochsTotal}`)
  parts.push(`${Math.round(job.progress * 100)} %`)
  return parts.join(' · ')
}

/** Форма запроса быстрого расчёта диполей: параметры идут как есть, без догадок. */
export function buildDipoleForm(params: CalcParams): FormData {
  const form = new FormData()
  if (params.filterBandHz) {
    form.set('band_min', String(params.filterBandHz[0]))
    form.set('band_max', String(params.filterBandHz[1]))
  }
  if (params.notchHz) form.set('notch_hz', String(params.notchHz))
  form.set('epoch_length_ms', String(params.epochLengthMs))
  form.set('reject_threshold_uv', String(params.rejectThresholdUv))
  form.set('grid_mm', String(params.gridMm))
  return form
}

/** Форма запроса спектра: полоса та же, что у расчёта диполей (один источник). */
export function buildSpectrumForm(params: CalcParams): FormData {
  const form = new FormData()
  if (params.filterBandHz) {
    form.set('band_min', String(params.filterBandHz[0]))
    form.set('band_max', String(params.filterBandHz[1]))
  }
  if (params.notchHz) form.set('notch_hz', String(params.notchHz))
  form.set('epoch_length_ms', String(params.epochLengthMs))
  form.set('reject_threshold_uv', String(params.rejectThresholdUv))
  return form
}

/**
 * Отпечаток параметров расчёта: одна и та же строка для параметров и для
 * результата, поэтому их расхождение = «результат посчитан на других настройках».
 *
 * Нужно таблице локализации (срез 4): она показывает результат **как есть** (в
 * том числе после правки настроек панели) и обязана сказать, что с текущими
 * параметрами он уже не совпадает, — иначе числа таблицы читались бы как
 * «посчитано на этих настройках».
 */
function signatureOf(parts: {
  band: [number, number] | null
  notchHz: number | null
  epochLengthMs: number
  rejectThresholdUv: number
  gridMm: number
}): string {
  const band = parts.band ? `${parts.band[0]}-${parts.band[1]}` : 'none'
  return [band, parts.notchHz ?? 'none', parts.epochLengthMs, parts.rejectThresholdUv, parts.gridMm].join('|')
}

/** Отпечаток параметров из панели расчёта. */
export function calcSignature(params: CalcParams): string {
  return signatureOf({
    band: params.filterBandHz,
    notchHz: params.notchHz,
    epochLengthMs: params.epochLengthMs,
    rejectThresholdUv: params.rejectThresholdUv,
    gridMm: params.gridMm,
  })
}

/** Отпечаток параметров, с которыми реально посчитан результат задачи (эхо сервера). */
export function resultSignature(result: DipoleScanResult): string {
  const band = result.filter_band_hz
  return signatureOf({
    band: band && band.length === 2 ? [band[0], band[1]] : null,
    notchHz: result.notch_hz,
    epochLengthMs: result.epoch_length_ms,
    rejectThresholdUv: result.reject_threshold_uv,
    gridMm: result.grid_mm,
  })
}

/** Результат соответствует текущим параметрам расчёта? `false` — он устарел. */
export function resultMatchesParams(result: DipoleScanResult, params: CalcParams): boolean {
  return resultSignature(result) === calcSignature(params)
}

/**
 * Сколько ждём между опросами задачи. Расчёт диполей идёт по эпохам и может
 * занять десятки секунд, поэтому поллинг частый: прогресс виден без задержки.
 */
const CALC_POLL_MS = 400

/**
 * Токен запуска: новый расчёт или сброс делают ответы прежних задач
 * неактуальными, и они не должны трогать состояние (`undefined` до первого
 * запуска — сравнение с числом всегда даёт «устарело»).
 */
let calcRunToken: number | undefined

/** Ждёт завершения задачи, сообщая прогресс; устаревшие запуски бросают. */
async function waitForJob(
  jobId: string,
  token: number,
  onTick: (job: CalcJob) => void,
): Promise<void> {
  for (;;) {
    if (token !== calcRunToken) throw new Error('cancelled')
    const status = await api.job(jobId)
    if (token !== calcRunToken) throw new Error('cancelled')
    onTick(calcJobFromStatus(status))
    if (status.status === 'succeeded') return
    if (status.status === 'failed') throw new Error(status.error ?? 'Задача завершилась ошибкой')
    await new Promise((resolve) => setTimeout(resolve, CALC_POLL_MS))
  }
}

export type DipoleCalcState = {
  /** Открытая выдвижная панель раздела (`none` — закрыта) */
  view: CalcView
  /** Порог отображения «КД ≥ X нАм»: слабее — не рисуется */
  amplitudeThresholdNam: number
  params: CalcParams
  /** Задача быстрого расчёта диполей (прогресс/ошибка) */
  job: CalcJob | null
  /** Результат расчёта диполей (точки MNI) */
  result: DipoleScanResult | null
  /** Задача спектра по диапазонам */
  spectrumJob: CalcJob | null
  /** Результат спектра (диапазоны + ссылки на топокарты) */
  spectrum: SpectrumResult | null
  /** Текст последней ошибки расчёта диполей — для панели */
  error: string | null
  /**
   * Текст последней ошибки спектра — **отдельно** от ошибки расчёта: иначе
   * панель объясняла бы сбой диполей словами «спектр не рассчитан».
   */
  spectrumError: string | null
  setView: (view: CalcView) => void
  /** Открыть панель, а повторное нажатие — закрыть (кнопки тулс-хедера) */
  toggleView: (view: Exclude<CalcView, 'none'>) => void
  setAmplitudeThreshold: (value: number) => void
  setEpochLengthMs: (value: number) => void
  setGridMm: (value: number) => void
  setRejectThresholdUv: (value: number) => void
  /** Быстрый расчёт диполей по кнопке (202 + поллинг + результат) */
  runCalculation: (recordingId: string | null) => Promise<void>
  /** Расчёт спектра по кнопке: числа PSD + топокарты диапазонов */
  runSpectrum: (recordingId: string | null) => Promise<void>
  /** Сброс результатов (закрытие записи) — параметры остаются */
  reset: () => void
}

export const useDipoleCalc = create<DipoleCalcState>()(
  persist(
    (set, get) => ({
      view: 'none',
      amplitudeThresholdNam: 0,
      params: { ...CALC_PARAM_DEFAULTS },
      job: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      error: null,
      spectrumError: null,

      setView: (view) => set({ view }),
      toggleView: (view) => set((state) => ({ view: state.view === view ? 'none' : view })),

      setAmplitudeThreshold: (value) =>
        set({ amplitudeThresholdNam: clamp(value, THRESHOLD_NAM_RANGE) }),
      setEpochLengthMs: (value) =>
        set((state) => ({ params: { ...state.params, epochLengthMs: Math.round(value) } })),
      setGridMm: (value) =>
        set((state) => ({ params: { ...state.params, gridMm: clamp(value, GRID_MM_RANGE) } })),
      setRejectThresholdUv: (value) =>
        set((state) => ({ params: { ...state.params, rejectThresholdUv: Math.max(0, value) } })),

      runCalculation: async (recordingId) => {
        if (!recordingId) return
        const params = get().params
        const token = (calcRunToken = (calcRunToken ?? 0) + 1)
        set({
          job: runningJob(),
          error: null,
        })
        try {
          const created = await api.dipoleScanJob(recordingId, buildDipoleForm(params))
          await waitForJob(created.job_id, token, (job) => {
            if (token !== calcRunToken) return
            set({ job })
          })
          if (token !== calcRunToken) return
          const result = await api.dipoleScanResult(recordingId, created.job_id)
          if (token !== calcRunToken) return
          set({ result, job: succeededJob(get().job) })
        } catch (error) {
          if (token !== calcRunToken || isCancelled(error)) return
          set({ job: failedJob(get().job, apiErrorText(error)), error: apiErrorText(error) })
        }
      },

      runSpectrum: async (recordingId) => {
        if (!recordingId) return
        const params = get().params
        const token = (calcRunToken = (calcRunToken ?? 0) + 1)
        set({ spectrumJob: runningJob(), spectrumError: null })
        try {
          const created = await api.spectrumJob(recordingId, buildSpectrumForm(params))
          await waitForJob(created.job_id, token, (job) => {
            if (token !== calcRunToken) return
            set({ spectrumJob: job })
          })
          if (token !== calcRunToken) return
          const spectrum = await api.spectrumResult(recordingId, created.job_id)
          if (token !== calcRunToken) return
          set({ spectrum, spectrumJob: succeededJob(get().spectrumJob) })
        } catch (error) {
          if (token !== calcRunToken || isCancelled(error)) return
          set({
            spectrumJob: failedJob(get().spectrumJob, apiErrorText(error)),
            spectrumError: apiErrorText(error),
          })
        }
      },

      reset: () => {
        // Отменяем поллинг: ответы прежних задач не должны трогать новое состояние
        calcRunToken = (calcRunToken ?? 0) + 1
        set({
          job: null,
          result: null,
          spectrumJob: null,
          spectrum: null,
          error: null,
          spectrumError: null,
        })
      },
    }),
    {
      name: 'diplock.dipoleCalc',
      // Результаты задач привязаны к записи: после перезагрузки страницы они
      // бессмысленны (файл живёт по TTL), поэтому храним только параметры
      partialize: (state) => ({
        view: state.view,
        amplitudeThresholdNam: state.amplitudeThresholdNam,
        params: state.params,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<DipoleCalcState>
        return {
          ...current,
          view: stored.view ?? current.view,
          amplitudeThresholdNam: stored.amplitudeThresholdNam ?? current.amplitudeThresholdNam,
          params: { ...current.params, ...(stored.params ?? {}) },
        }
      },
    },
  ),
)

/** Зажатие значения в диапазон контрола. */
function clamp(value: number, [min, max]: [number, number]): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Запуск отменён (сброс/новый расчёт) — это не ошибка пользователя. */
function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'cancelled'
}

function runningJob(): CalcJob {
  return { status: 'running', progress: 0, message: '', stage: 'queued', epochsDone: 0, epochsTotal: 0, error: null }
}

function succeededJob(previous: CalcJob | null): CalcJob {
  return { ...(previous ?? runningJob()), status: 'succeeded', progress: 1, epochsDone: previous?.epochsTotal ?? 0 }
}

function failedJob(previous: CalcJob | null, message: string): CalcJob {
  return { ...(previous ?? runningJob()), status: 'failed', progress: 0, error: message }
}
