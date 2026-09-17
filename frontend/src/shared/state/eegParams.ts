/**
 * Состояние раздела «ЭЭГ»: выбранный канал, окно просмотра, параметры расчёта
 * спектрограммы и сама задача расчёта.
 *
 * Правило раздела то же, что в EDF и «Диполях» (`docs/ui.md`): **правка
 * параметра ничего не запускает**. Спектрограмма считается только кнопкой
 * (`POST /recordings/{id}/spectrogram`), а параметры лишь помечают результат
 * устаревшим (`eegSignature` параметров против `eegResultSignature` результата).
 *
 * Что в сторе, а что нет:
 * - здесь — параметры просмотра (канал, мкВ на деление, окно частот, палитра,
 *   окно дБ, сглаживание, режим спектрограммы, доля разделителя), параметры
 *   расчёта (полоса фильтра, окно STFT, перекрытие, верхняя частота), окно
 *   времени и состояние задачи (прогресс, ошибка, локальный `eegNav`);
 * - в компонентах — отрисовка: canvas рисует трек и сетку, а арифметика шкал
 *   живёт в `shared/lib/eegView.ts` и `shared/lib/eegSpectrogram.ts`.
 *
 * **Окно времени лежит здесь, а не в компоненте**: курсор общий для трека и
 * спектрограммы, и в режиме «связано» спектрограмма следует за окном трека —
 * значит, окно принадлежит разделу, а не одной половине. Хранится **центр**
 * окна (а не левый край): так работает тот же `zoomWindow` с зажимом, что у
 * вьюера EDF, поэтому зум ×1…×16 и листание окна ведут себя одинаково.
 *
 * **Уровень зума не устаревает расчёт**: `eegSignature` его не содержит — как и
 * окно частот FFT-графика в «Диполях», это параметр просмотра.
 *
 * Персистятся только параметры и предпочтения просмотра: результат задачи и
 * сетка принадлежат конкретной записи и после перезагрузки страницы
 * бессмысленны (файл живёт по TTL).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiErrorText } from '@/shared/api/client'
import type { SpectrogramResult } from '@/shared/api/types'
import {
  BANDWIDTH_RANGE,
  SINGLE_FREQ_RANGE,
  bandForPreset,
  filterPresetIsValid,
  filterPresetOf,
  normalizeFilterBand,
  normalizeNotchHz,
  singleFreqBand,
  type CalcFilterParams,
  type CalcFilterPresetId,
} from '@/shared/lib/calcFilter'
import {
  decodeSpectrogramGrid,
  gridUrlOf,
  type EegPaletteId,
  type SpectrogramGrid,
} from '@/shared/lib/eegSpectrogram'
import { DB_RANGE_LIMITS, normalizeAmplitudeUv } from '@/shared/lib/eegView'
import { normalizeFreqWindow, type FreqWindow } from '@/shared/lib/spectrum'
import { TIME_LEVELS } from './edfParams'
import { calcJobFromStatus, calcJobSummary, type CalcJob } from './dipoleCalc'

export { TIME_LEVELS }

/** Как спектрограмма относится к окну трека: вся запись или видимое окно */
export type SpectrogramMode = 'overview' | 'linked'

/** Команды листания окна из тулс-хедера (как `navRequest` в EDF) */
export type EegNavCommand = 'start' | 'prev' | 'next' | 'end'

export type EegNavRequest = {
  command: EegNavCommand
  /** Монотонно растущий счётчик: повторный рендер не проигрывает команду дважды */
  seq: number
}

/** Параметры окна STFT — то, что уходит в задачу расчёта */
export type EegSpectrogramParams = {
  windowMs: number
  overlapPct: number
  fmaxHz: number
}

/** Границы контролов окна STFT (совпадают со схемой формы на сервере) */
export const SPECTROGRAM_WINDOW_RANGE_MS: [number, number] = [64, 4000]
export const SPECTROGRAM_OVERLAP_RANGE_PCT: [number, number] = [0, 95]
export const SPECTROGRAM_FMAX_RANGE_HZ: [number, number] = [1, 120]

export type EegParams = {
  /** Выбранный канал (null — берём первый доступный) */
  channel: string | null
  /** Шкала трека: мкВ на деление (правится перетаскиванием правой линейки) */
  amplitudeUv: number
  /** Уровень зума по времени: индекс в `TIME_LEVELS` (0 — вся запись) */
  timeLevel: number
  /** Центр окна времени, с: общий для трека и спектрограммы */
  windowCenterSec: number
  /** Окно частот спектрограммы, Гц (`null` — вся сетка) */
  freqWindow: FreqWindow | null
  palette: EegPaletteId
  /** Окно дБ палитры относительно потолка шкалы расчёта, дБ */
  dbRangeDb: [number, number]
  /** Сглаживание по времени, мс (параметр просмотра) */
  smoothMs: number
  /** Сглаживание по частоте, корзин (параметр просмотра) */
  smoothBins: number
  /** Рисовать ли сетку частот и времени поверх спектрограммы */
  grid: boolean
  /** Показывать ли общий курсор */
  showCursor: boolean
  spectrogramMode: SpectrogramMode
  /** Доля верхней половины (0..1): перетаскиваемый разделитель */
  splitRatio: number
  spectrogram: EegSpectrogramParams
  /** Фильтр расчёта: полоса и сетевой (та же форма, что в «Диполях») */
  filter: CalcFilterParams
}

export const EEG_PARAM_DEFAULTS: EegParams = {
  channel: null,
  amplitudeUv: 50,
  timeLevel: 0,
  windowCenterSec: 0,
  freqWindow: null,
  palette: 'viridis',
  // Окно дБ по умолчанию — 40 дБ над полом шкалы: шум отсекается, ритм виден
  dbRangeDb: [-40, 0],
  smoothMs: 0,
  smoothBins: 0,
  grid: true,
  showCursor: true,
  spectrogramMode: 'linked',
  splitRatio: 0.5,
  spectrogram: { windowMs: 500, overlapPct: 75, fmaxHz: 40 },
  filter: {
    filterPreset: 'band_1_40',
    filterBandHz: [1, 40],
    notchHz: null,
    singleFreqHz: 7.83,
    bandwidthHz: 0.5,
  },
}

/**
 * Отпечаток параметров **расчёта**: он же у результата задачи (эхо сервера),
 * поэтому расхождение = «результат посчитан на других настройках».
 * Параметры просмотра (зум, шкала, палитра, окно дБ, сглаживание, разделитель)
 * в отпечаток не входят: они не меняют числа.
 */
export function eegSignature(params: EegParams): string {
  const band = params.filter.filterBandHz
  return [
    params.channel ?? 'auto',
    band ? `${band[0]}-${band[1]}` : 'none',
    params.filter.notchHz ?? 'none',
    params.spectrogram.windowMs,
    params.spectrogram.overlapPct,
    params.spectrogram.fmaxHz,
  ].join('|')
}

/** Отпечаток результата задачи: параметры, с которыми он реально посчитан. */
export function eegResultSignature(result: SpectrogramResult): string {
  const band = result.filter_band_hz
  return [
    result.channel,
    band && band.length === 2 ? `${band[0]}-${band[1]}` : 'none',
    result.notch_hz ?? 'none',
    result.window_ms,
    result.overlap_pct,
    result.fmax_hz,
  ].join('|')
}

/** Результат соответствует текущим параметрам расчёта? `false` — он устарел. */
export function eegResultMatchesParams(
  result: SpectrogramResult,
  params: EegParams,
): boolean {
  return eegResultSignature(result) === eegSignature(params)
}

/** Форма запроса расчёта спектрограммы: канал, полоса, окно STFT — без догадок. */
export function buildSpectrogramForm(params: EegParams, channel: string): FormData {
  const form = new FormData()
  form.set('channel', channel)
  const band = params.filter.filterBandHz
  if (band) {
    form.set('band_min', String(band[0]))
    form.set('band_max', String(band[1]))
  }
  if (params.filter.notchHz) form.set('notch_hz', String(params.filter.notchHz))
  form.set('window_ms', String(params.spectrogram.windowMs))
  form.set('overlap_pct', String(params.spectrogram.overlapPct))
  form.set('fmax_hz', String(params.spectrogram.fmaxHz))
  return form
}

/** Шаг перекрытия в панели: 5 % — мельче неразличимо на картинке */
export const SPECTROGRAM_OVERLAP_STEP_PCT = 5

/** Границы сглаживания просмотра: по времени в мс, по частоте в корзинах */
export const SMOOTH_MS_RANGE: [number, number] = [0, 2000]
export const SMOOTH_BINS_RANGE: [number, number] = [0, 15]
/** Границы доли верхней половины: у обеих половин должно остаться место */
export const SPLIT_RATIO_RANGE: [number, number] = [0.15, 0.85]


/** Окно дБ: низ ниже верха, оба в границах шкалы. */
export function normalizeDbRange(range: [number, number]): [number, number] {
  const low = clamp(Math.min(range[0], range[1]), DB_RANGE_LIMITS)
  const high = clamp(Math.max(range[0], range[1]), DB_RANGE_LIMITS)
  return low === high ? [low - 5, high] : [low, high]
}

/** Индекс уровня зума: чужие значения из localStorage не «висят» вне списка. */
export function clampIndex(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.min(TIME_LEVELS.length - 1, Math.max(0, Math.round(level)))
}

function clamp(value: number, [min, max]: [number, number]): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Нормализация сохранённых параметров: значения из localStorage могут быть из
 * прежней версии UI или просто мусором, а контролы обязаны читаться.
 */
export function normalizeEegParams(params: EegParams): EegParams {
  const filter = { ...EEG_PARAM_DEFAULTS.filter, ...(params.filter ?? {}) }
  const filterBandHz = normalizeFilterBand(filter.filterBandHz)
  const preset = filterPresetIsValid(filter.filterPreset)
    ? filter.filterPreset
    : filterPresetOf({ ...filter, filterBandHz }, {})
  const spectrogram = params.spectrogram ?? EEG_PARAM_DEFAULTS.spectrogram
  return {
    ...EEG_PARAM_DEFAULTS,
    ...params,
    channel: params.channel ?? null,
    amplitudeUv: normalizeAmplitudeUv(params.amplitudeUv),
    timeLevel: clampIndex(params.timeLevel),
    windowCenterSec: Number.isFinite(params.windowCenterSec) ? params.windowCenterSec : 0,
    freqWindow: normalizeFreqWindow(params.freqWindow),
    dbRangeDb: normalizeDbRange(params.dbRangeDb ?? EEG_PARAM_DEFAULTS.dbRangeDb),
    smoothMs: clamp(params.smoothMs, SMOOTH_MS_RANGE),
    smoothBins: clamp(params.smoothBins, SMOOTH_BINS_RANGE),
    splitRatio: clamp(params.splitRatio, SPLIT_RATIO_RANGE),
    spectrogramMode: params.spectrogramMode === 'overview' ? 'overview' : 'linked',
    spectrogram: {
      windowMs: clamp(spectrogram.windowMs, SPECTROGRAM_WINDOW_RANGE_MS),
      overlapPct: clamp(spectrogram.overlapPct, SPECTROGRAM_OVERLAP_RANGE_PCT),
      fmaxHz: clamp(spectrogram.fmaxHz, SPECTROGRAM_FMAX_RANGE_HZ),
    },
    filter: {
      ...filter,
      filterPreset: preset,
      filterBandHz,
      notchHz: normalizeNotchHz(filter.notchHz),
      singleFreqHz: clamp(filter.singleFreqHz, SINGLE_FREQ_RANGE),
      bandwidthHz: clamp(filter.bandwidthHz, BANDWIDTH_RANGE),
    },
  }
}

/** Сколько ждём между опросами задачи: STFT считается секунды, прогресс виден сразу */
const EEG_POLL_MS = 400

/**
 * Токен запуска: новый расчёт или сброс делают ответы прежних задач
 * неактуальными, и они не должны трогать состояние.
 */
let eegRunToken: number | undefined

/** Ждёт завершения задачи, сообщая прогресс; устаревшие запуски бросают. */
async function waitForJob(
  jobId: string,
  token: number,
  onTick: (job: CalcJob) => void,
): Promise<void> {
  for (;;) {
    if (token !== eegRunToken) throw new Error('cancelled')
    const status = await api.job(jobId)
    if (token !== eegRunToken) throw new Error('cancelled')
    onTick(calcJobFromStatus(status))
    if (status.status === 'succeeded') return
    if (status.status === 'failed') throw new Error(status.error ?? 'Задача завершилась ошибкой')
    await new Promise((resolve) => setTimeout(resolve, EEG_POLL_MS))
  }
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'cancelled'
}

/** Состояние задачи сразу после запуска: полоса прогресса появляется без задержки. */
function runningJob(): CalcJob {
  return {
    status: 'running',
    progress: 0,
    message: 'Задача поставлена в очередь',
    stage: 'queued',
    epochsDone: 0,
    epochsTotal: 0,
    error: null,
  }
}

function succeededJob(job: CalcJob | null): CalcJob {
  return {
    status: 'succeeded',
    progress: 1,
    message: job?.message ?? 'Спектрограмма готова',
    stage: 'done',
    epochsDone: job?.epochsDone ?? 0,
    epochsTotal: job?.epochsTotal ?? 0,
    error: null,
  }
}

function failedJob(job: CalcJob | null, message: string): CalcJob {
  return { ...(job ?? runningJob()), status: 'failed', error: message }
}

export type EegState = {
  params: EegParams
  /** Задача расчёта спектрограммы: прогресс, этап, ошибка */
  job: CalcJob | null
  /** Метаданные результата (оси, шкала дБ, ссылка на сетку) */
  result: SpectrogramResult | null
  /** Разобранная сетка спектрограммы — числа для отрисовки */
  grid: SpectrogramGrid | null
  /** Ошибка расчёта */
  error: string | null
  /** Ошибка загрузки сетки — **отдельно** от ошибки расчёта: разные причины */
  gridError: string | null
  /** Команда листания окна из тулс-хедера */
  eegNav: EegNavRequest | null
  setParams: (patch: Partial<EegParams>) => void
  /** Канал трека: смена канала обесценивает спектрограмму другого канала */
  setChannel: (channel: string) => void
  /** Шкала трека: готовое значение мкВ/деление (считает перетаскивание линейки) */
  setAmplitudeUv: (value: number) => void
  /** Окно частот: кнопки ритмов, поля «от/до», «весь диапазон» — только просмотр */
  setFreqWindow: (window: FreqWindow | null) => void
  setSpectrogramParams: (patch: Partial<EegSpectrogramParams>) => void
  setFilterPreset: (preset: CalcFilterPresetId, freqBands: Record<string, number[]>) => void
  setFilterBand: (band: [number, number]) => void
  setNotchHz: (value: number | null) => void
  setSingleFreq: (value: number) => void
  setBandwidth: (value: number) => void
  /** Команда листания окна: `<<` `<` `>` `>>` (исполняет рабочая область) */
  requestNav: (command: EegNavCommand) => void
  /** Запуск расчёта: **единственное** место, где уходит задача */
  runSpectrogram: (recordingId: string | null, channel: string | null) => Promise<void>
  /** Сброс результата (новая запись / закрытие записи): параметры просмотра остаются */
  reset: () => void
}

export const useEegParams = create<EegState>()(
  persist(
    (set, get) => ({
      params: { ...EEG_PARAM_DEFAULTS },
      job: null,
      result: null,
      grid: null,
      error: null,
      gridError: null,
      eegNav: null,

      setParams: (patch) => set((state) => ({ params: { ...state.params, ...patch } })),
      setChannel: (channel) => set((state) => ({ params: { ...state.params, channel } })),
      setAmplitudeUv: (value) =>
        set((state) => ({
          params: { ...state.params, amplitudeUv: normalizeAmplitudeUv(value) },
        })),
      setFreqWindow: (window) =>
        set((state) => ({
          params: { ...state.params, freqWindow: normalizeFreqWindow(window) },
        })),
      setSpectrogramParams: (patch) =>
        set((state) => ({
          params: normalizeEegParams({
            ...state.params,
            spectrogram: { ...state.params.spectrogram, ...patch },
          }),
        })),
      setFilterPreset: (preset, freqBands) =>
        set((state) => ({
          params: {
            ...state.params,
            filter: {
              ...state.params.filter,
              filterPreset: preset,
              filterBandHz: bandForPreset(state.params.filter, preset, freqBands),
            },
          },
        })),
      // Полосу правят поля «своего диапазона»: выбор становится «своим»,
      // а если границы совпали (полоса пустая) — фильтра нет вовсе
      setFilterBand: (band) =>
        set((state) => {
          const filterBandHz = normalizeFilterBand(band)
          return {
            params: {
              ...state.params,
              filter: {
                ...state.params.filter,
                filterBandHz,
                filterPreset: filterBandHz === null ? 'none' : 'custom',
              },
            },
          }
        }),
      setNotchHz: (value) =>
        set((state) => ({
          params: {
            ...state.params,
            filter: { ...state.params.filter, notchHz: normalizeNotchHz(value) },
          },
        })),
      setSingleFreq: (value) =>
        set((state) => {
          const singleFreqHz = clamp(value, SINGLE_FREQ_RANGE)
          return {
            params: {
              ...state.params,
              filter: {
                ...state.params.filter,
                filterPreset: 'single',
                singleFreqHz,
                filterBandHz:
                  singleFreqBand(singleFreqHz, state.params.filter.bandwidthHz) ??
                  state.params.filter.filterBandHz,
              },
            },
          }
        }),
      setBandwidth: (value) =>
        set((state) => {
          const bandwidthHz = clamp(value, BANDWIDTH_RANGE)
          return {
            params: {
              ...state.params,
              filter: {
                ...state.params.filter,
                filterPreset: 'single',
                bandwidthHz,
                filterBandHz:
                  singleFreqBand(state.params.filter.singleFreqHz, bandwidthHz) ??
                  state.params.filter.filterBandHz,
              },
            },
          }
        }),

      requestNav: (command) =>
        set((state) => ({ eegNav: { command, seq: (state.eegNav?.seq ?? 0) + 1 } })),

      runSpectrogram: async (recordingId, channel) => {
        if (!recordingId || !channel) return
        const params = { ...get().params, channel }
        const token = (eegRunToken = (eegRunToken ?? 0) + 1)
        set({ job: runningJob(), error: null, gridError: null })
        try {
          const form = buildSpectrogramForm(params, channel)
          const created = await api.spectrogramJob(recordingId, form)
          await waitForJob(created.job_id, token, (job) => {
            if (token !== eegRunToken) return
            set({ job })
          })
          if (token !== eegRunToken) return
          const result = await api.spectrogramResult(recordingId, created.job_id)
          if (token !== eegRunToken) return
          // Сетка грузится отдельным запросом: если она не приехала, метаданные
          // результата всё равно показываются, а причина объясняется своим текстом.
          let grid: SpectrogramGrid | null = null
          let gridError: string | null = null
          try {
            const buffer = await api.spectrogramGrid(gridUrlOf(result))
            grid = decodeSpectrogramGrid(buffer)
          } catch (gridFailure) {
            gridError = apiErrorText(gridFailure)
          }
          if (token !== eegRunToken) return
          set({ result, grid, gridError, job: succeededJob(get().job) })
        } catch (failure) {
          if (token !== eegRunToken || isCancelled(failure)) return
          set({
            job: failedJob(get().job, apiErrorText(failure)),
            error: apiErrorText(failure),
          })
        }
      },

      reset: () => {
        // Отменяем поллинг: ответы прежних задач не должны трогать новое состояние
        eegRunToken = (eegRunToken ?? 0) + 1
        set((state) => ({
          job: null,
          result: null,
          grid: null,
          error: null,
          gridError: null,
          eegNav: null,
          // Канал и окно принадлежат записи: откроют другую — выберут свой канал
          params: { ...state.params, channel: null, windowCenterSec: 0, timeLevel: 0 },
        }))
      },
    }),
    {
      name: 'diplock.eeg',
      // Результат и сетка принадлежат записи: после перезагрузки страницы они
      // бессмысленны (файл живёт по TTL). Параметры и предпочтения просмотра —
      // наоборот, переживают перезагрузку.
      partialize: (state) => ({ params: state.params }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as { params?: Partial<EegParams> }
        return {
          ...current,
          job: null,
          result: null,
          grid: null,
          error: null,
          gridError: null,
          eegNav: null,
          params: normalizeEegParams({ ...current.params, ...(stored.params ?? {}) }),
        }
      },
    },
  ),
)

/** Текущие параметры раздела (подписка на изменения). */
export function useEegParamsValue(): EegParams {
  return useEegParams((state) => state.params)
}

/** Подпись хода задачи — та же, что у расчёта диполей (один диалект на разделы). */
export function useEegJobSummary(): string {
  const job = useEegParams((state) => state.job)
  return calcJobSummary(job)
}
