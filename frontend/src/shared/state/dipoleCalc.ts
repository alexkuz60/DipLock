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
 *   порог отображения «КД», окно частот FFT-графика, открытая выдвижная панель
 *   (`view`), выделенный диполь и сами результаты задач (они принадлежат записи
 *   и сбрасываются при закрытии записи);
 * - в компонентах — отрисовка: топокарты, гистограмма и подсветка выделенного
 *   диполя считаются из результата чистыми функциями (`shared/lib/spectrum.ts`,
 *   `shared/lib/dipolePoints.ts`).
 *
 * Полоса фильтра выбирается формой в панели раздела (срез 3.6): пресеты δ…γ
 * приходят из `/meta`, есть «свой диапазон», «одиночная частота» (f ± bw/2) и
 * «без фильтра». Хранится только **полоса** — пресет выводится из неё
 * (`shared/lib/calcFilter.ts`), поэтому подпись формы не может разойтись с тем,
 * что уйдёт в задачу. Форма живёт здесь, а не в `edfParams`: расчёт диполей не
 * должен меняться «незаметно» от правок предподготовки записи.
 *
 * Персистится только набор параметров и предпочтений просмотра (окно частот):
 * результаты задач и выделенный диполь относятся к конкретной записи и после
 * перезагрузки страницы бессмысленны.
 *
 * Воспроизведение траектории (срез 3.7) — тоже состояние **просмотра**, но с
 * командой из шапки: `playback` хранит идущее воспроизведение, скорость (×1/×2/×4),
 * номер эпохи и счётчик пользовательских переходов (`seekSeq` — как `navRequest.seq`
 * в EDF, чтобы часы не проигрывали одну команду дважды). Непрерывное время кадра
 * здесь **не** живёт: его ведут часы раздела (`PlaybackFrame.tsx`), а в стор уходит
 * только смена эпохи — кадры 60 раз в секунду не должны перерисовывать облако точек.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiErrorText } from '@/shared/api/client'
import {
  BANDWIDTH_RANGE,
  SINGLE_FREQ_RANGE,
  bandForPreset,
  filterPresetIsValid,
  filterPresetOf,
  normalizeFilterBand,
  normalizeNotchHz,
  singleFreqBand,
  type CalcFilterPresetId,
} from '@/shared/lib/calcFilter'
import { normalizeFreqWindow, type FreqWindow } from '@/shared/lib/spectrum'
import {
  DEFAULT_PLAYBACK_SPEED,
  canPlayback,
  clampEpochIndex,
  normalizePlaybackSpeed,
  type PlaybackSpeed,
} from '@/shared/lib/playback'
import type { DipoleScanResult, JobStatus, SpectrumResult } from '@/shared/api/types'

/** Что открыто в выдвижной панели раздела: одна панель за раз. */
export type CalcView = 'none' | 'topomap' | 'fft'

/**
 * Кадр воспроизведения траектории (срез 3.7). Живёт в сторе, потому что команда
 * идёт из шапки (play/pause, покадрово, `Space`), а исполняется в рабочей области:
 * прямой «ручки» у проекций нет — как и у вьюера EDF.
 */
export type PlaybackState = {
  /** Идёт воспроизведение; на паузе кадр равен измеренной точке своей эпохи */
  playing: boolean
  /** Скорость: 1 — реальное время записи, 2 и 4 — ускорение */
  speed: PlaybackSpeed
  /** Текущая эпоха нарезки результата (0…`n_epochs_total`−1) */
  epochIndex: number
  /**
   * Счётчик **пользовательских** переходов (покадрово/перевод): растёт монотонно,
   * поэтому часы видят новую команду, даже если номер эпохи не изменился (повторный
   * «покадрово» на границе записи). Как `navRequest.seq` в EDF: повторный рендер не
   * проигрывает команду дважды.
   */
  seekSeq: number
  /**
   * Кадр задействован: облако проекций приглушено, а маркер кадра виден и на
   * паузе — так «останавливаются» на интересующем кадре.
   */
  active: boolean
}

export const PLAYBACK_DEFAULTS: PlaybackState = {
  playing: false,
  speed: DEFAULT_PLAYBACK_SPEED,
  epochIndex: 0,
  seekSeq: 0,
  active: false,
}

/** Параметры расчёта, уходящие в форму запроса (и в URL топокарт). */
export type CalcParams = {
  /**
   * Выбор пользователя в списке «Фильтр расчёта»: пресет диапазона (δ…γ из
   * `/meta`), «одиночная частота», «свой диапазон» или «без фильтра».
   */
  filterPreset: CalcFilterPresetId
  /**
   * Полоса фильтра, Гц; `null` — без фильтра. **То, что уходит в задачу**
   * (`band_min`/`band_max`) и входит в отпечаток результата; пересчитывается
   * каждым сеттером формы (`shared/lib/calcFilter.ts`).
   */
  filterBandHz: [number, number] | null
  notchHz: number | null
  /** Одиночная частота, Гц: полосу считает `singleFreqBand` (f ± bw/2) */
  singleFreqHz: number
  /** Ширина полосы вокруг одиночной частоты, Гц */
  bandwidthHz: number
  epochLengthMs: number
  rejectThresholdUv: number
  /** Шаг объёмной сетки поиска диполей, мм */
  gridMm: number
}

export const CALC_PARAM_DEFAULTS: CalcParams = {
  filterPreset: 'band_1_40',
  filterBandHz: [1, 40],
  notchHz: null,
  // Значения одиночной частоты — заготовка формы: 7.83 Гц (частота Шумана) с
  // полосой ±0.25 Гц. Ширина по умолчанию та же, что у предподготовки записи
  // (`settings.default_single_freq_bandwidth_hz`), иначе формы расходились бы.
  singleFreqHz: 7.83,
  bandwidthHz: 0.5,
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
    status:
      job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : 'running',
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
  return [
    band,
    parts.notchHz ?? 'none',
    parts.epochLengthMs,
    parts.rejectThresholdUv,
    parts.gridMm,
  ].join('|')
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
  /**
   * Окно частот FFT-графика, Гц (`null` — весь измеренный диапазон).
   * Параметр **просмотра**: график срезает уже посчитанные числа PSD, запросов
   * не делает (правило раздела «UI не запускает обработку»).
   */
  fftRangeHz: FreqWindow | null
  /**
   * Выделенный диполь (id точки слоя) — подсвечивается во **всех** проекциях:
   * выбор в одной, синхронизация в трёх. Сессионное состояние, не персистится.
   */
  selectedPointId: string | null
  /** Кадр воспроизведения траектории: играет/пауза, скорость, эпоха (срез 3.7) */
  playback: PlaybackState
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
  /** Окно частот FFT-графика по кнопке ритма или полю «от/до»; `null` — весь диапазон */
  setFftRange: (range: FreqWindow | null) => void
  /** Повторный клик по выделенной точке снимает выделение (одна кнопка на два состояния) */
  toggleSelectedPoint: (id: string) => void
  clearSelectedPoint: () => void
  /** Play/pause кадра воспроизведения: без результата ничего не запускает */
  togglePlayback: () => void
  /** Пауза без снятия кадра (конец записи, уход из раздела) */
  pausePlayback: () => void
  /** Скорость воспроизведения: значение приводится к 1/2/4 */
  setPlaybackSpeed: (speed: number) => void
  /** Покадрово: ставит на паузу и сдвигает кадр на `delta` эпох (с зажимом) */
  stepPlaybackEpoch: (delta: number) => void
  /** Перевод кадра на конкретную эпоху (ставит на паузу) */
  seekPlaybackEpoch: (epochIndex: number) => void
  /** Снять кадр воспроизведения: облако диполей возвращается в обычный вид */
  clearPlaybackFrame: () => void
  /** Сдвиг кадра **часами** воспроизведения (не команда: счётчик переходов не растёт) */
  setPlaybackEpoch: (epochIndex: number) => void
  setEpochLengthMs: (value: number) => void
  setGridMm: (value: number) => void
  setRejectThresholdUv: (value: number) => void
  /** Выбор пресета фильтра: полоса пресета — данные (ритмы идут из `/meta`) */
  setFilterPreset: (preset: CalcFilterPresetId, freqBands: Record<string, number[]>) => void
  /** Полоса фильтра числом (поля «свой диапазон»): границы нормализуются */
  setFilterBand: (band: readonly number[] | null) => void
  /** Сетевой фильтр 50/60 Гц (`null` — выключен) */
  setNotchHz: (value: number | null) => void
  /** Одиночная частота: полоса пересчитывается как f ± bw/2 */
  setSingleFreq: (value: number) => void
  /** Ширина полосы одиночной частоты: полоса пересчитывается как f ± bw/2 */
  setBandwidth: (value: number) => void
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
      fftRangeHz: null,
      selectedPointId: null,
      playback: { ...PLAYBACK_DEFAULTS },
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
      setFftRange: (range) => set({ fftRangeHz: normalizeFreqWindow(range) }),
      toggleSelectedPoint: (id) =>
        set((state) => ({ selectedPointId: state.selectedPointId === id ? null : id })),
      clearSelectedPoint: () => set({ selectedPointId: null }),

      togglePlayback: () => {
        const { result, playback } = get()
        // Без точек и сетки эпох кадры пусты: кнопка выключена в шапке, а действие
        // не «играет вхолостую»
        if (!canPlayback(result)) return
        if (playback.playing) {
          // Пауза: часы останавливаются, кадр остаётся на текущей эпохе и
          // показывается **измеренной** точкой (доля внутри эпохи — ноль)
          set({ playback: { ...playback, playing: false } })
          return
        }
        // Play с последнего кадра начинает запись сначала: иначе кнопка «играет»,
        // а картинка стоит на месте
        const atEnd = playback.epochIndex >= (result?.n_epochs_total ?? 1) - 1
        set({
          playback: {
            ...playback,
            playing: true,
            active: true,
            epochIndex: atEnd ? 0 : playback.epochIndex,
            seekSeq: playback.seekSeq + 1,
          },
        })
      },
      pausePlayback: () =>
        set((state) =>
          state.playback.playing ? { playback: { ...state.playback, playing: false } } : {},
        ),
      setPlaybackSpeed: (speed) =>
        set((state) => ({ playback: { ...state.playback, speed: normalizePlaybackSpeed(speed) } })),
      stepPlaybackEpoch: (delta) =>
        set((state) => {
          const total = state.result?.n_epochs_total ?? 0
          if (total <= 0) return {}
          return {
            playback: {
              ...state.playback,
              playing: false,
              active: true,
              epochIndex: clampEpochIndex(state.playback.epochIndex + delta, total),
              seekSeq: state.playback.seekSeq + 1,
            },
          }
        }),
      seekPlaybackEpoch: (epochIndex) =>
        set((state) => {
          const total = state.result?.n_epochs_total ?? 0
          if (total <= 0) return {}
          return {
            playback: {
              ...state.playback,
              playing: false,
              active: true,
              epochIndex: clampEpochIndex(epochIndex, total),
              seekSeq: state.playback.seekSeq + 1,
            },
          }
        }),
      clearPlaybackFrame: () =>
        set((state) => ({ playback: { ...state.playback, playing: false, active: false } })),
      setPlaybackEpoch: (epochIndex) =>
        set((state) => {
          const next = clampEpochIndex(epochIndex, state.result?.n_epochs_total ?? 0)
          // Часы пишут кадр на каждом переходе эпохи: при том же номере стор не
          // трогаем, иначе кадры 60 раз в секунду давали бы лишние перерисовки
          return next === state.playback.epochIndex
            ? {}
            : { playback: { ...state.playback, epochIndex: next } }
        }),

      setEpochLengthMs: (value) =>
        set((state) => ({ params: { ...state.params, epochLengthMs: Math.round(value) } })),
      setGridMm: (value) =>
        set((state) => ({ params: { ...state.params, gridMm: clamp(value, GRID_MM_RANGE) } })),
      setRejectThresholdUv: (value) =>
        set((state) => ({ params: { ...state.params, rejectThresholdUv: Math.max(0, value) } })),
      setFilterPreset: (preset, freqBands) =>
        set((state) => ({
          params: {
            ...state.params,
            filterPreset: preset,
            filterBandHz: bandForPreset(state.params, preset, freqBands),
          },
        })),
      // Полосу правят поля «своего диапазона»: выбор становится «своим», а если
      // границы совпали (полоса пустая) — фильтра нет вовсе
      setFilterBand: (band) =>
        set((state) => {
          const filterBandHz = normalizeFilterBand(band)
          return {
            params: {
              ...state.params,
              filterBandHz,
              filterPreset: filterBandHz === null ? 'none' : 'custom',
            },
          }
        }),
      setNotchHz: (value) =>
        set((state) => ({ params: { ...state.params, notchHz: normalizeNotchHz(value) } })),
      // Частота и ширина одиночной частоты — одно целое с её полосой: полоса
      // пересчитывается сразу, иначе поля показывали бы одно, а задача получала
      // другое (поля видны только в пресете «одиночная частота», где это и ждут).
      setSingleFreq: (value) =>
        set((state) => {
          const singleFreqHz = clamp(value, SINGLE_FREQ_RANGE)
          return {
            params: {
              ...state.params,
              filterPreset: 'single',
              singleFreqHz,
              filterBandHz:
                singleFreqBand(singleFreqHz, state.params.bandwidthHz) ?? state.params.filterBandHz,
            },
          }
        }),
      setBandwidth: (value) =>
        set((state) => {
          const bandwidthHz = clamp(value, BANDWIDTH_RANGE)
          return {
            params: {
              ...state.params,
              filterPreset: 'single',
              bandwidthHz,
              filterBandHz:
                singleFreqBand(state.params.singleFreqHz, bandwidthHz) ?? state.params.filterBandHz,
            },
          }
        }),

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
          // Новый результат — новый кадр воспроизведения: прежняя эпоха относилась
          // к другой нарезке (номер эпохи без результата ничего не значит)
          set({
            result,
            job: succeededJob(get().job),
            playback: {
              ...get().playback,
              playing: false,
              active: false,
              epochIndex: 0,
              seekSeq: 0,
            },
          })
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
          // Выделенный диполь жил в результате задачи — вместе с ним он исчезает
          selectedPointId: null,
          // Кадр воспроизведения привязан к нарезке эпох результата: вместе с ним
          // он снимается, а скорость остаётся (предпочтение просмотра)
          playback: { ...get().playback, playing: false, active: false, epochIndex: 0, seekSeq: 0 },
        })
      },
    }),
    {
      name: 'diplock.dipoleCalc',
      // Результаты задач и выделение привязаны к записи: после перезагрузки
      // страницы они бессмысленны (файл живёт по TTL). Окно частот — наоборот,
      // предпочтение просмотра, оно переживает перезагрузку.
      partialize: (state) => ({
        view: state.view,
        amplitudeThresholdNam: state.amplitudeThresholdNam,
        fftRangeHz: state.fftRangeHz,
        params: state.params,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<DipoleCalcState>
        const storedParams = (stored.params ?? {}) as Partial<CalcParams>
        const merged = { ...current.params, ...storedParams }
        // Состояние до среза 3.6 не знало пресета: выводим его из сохранённой
        // полосы, а не подставляем «широкий 1–40» к любой полосе (иначе список
        // называл бы ритмом не то, что уйдёт в расчёт)
        if (storedParams.filterPreset === undefined) {
          merged.filterPreset = filterPresetOf(merged, {})
        }
        return {
          ...current,
          view: stored.view ?? current.view,
          amplitudeThresholdNam: stored.amplitudeThresholdNam ?? current.amplitudeThresholdNam,
          fftRangeHz: normalizeFreqWindow(stored.fftRangeHz ?? current.fftRangeHz),
          selectedPointId: null,
          // Кадр воспроизведения — сессионное состояние: он не персистится, и после
          // перезагрузки страницы его нет (как и результата задачи) — берём дефолт
          playback: { ...PLAYBACK_DEFAULTS },
          // Старые сохранённые параметры не знают полей формы фильтра (срез 3.6),
          // а в числах мог оказаться мусор: приводим их к правилам контролов
          params: normalizeCalcParams(merged),
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

/**
 * Параметры расчёта в целостном виде: сохранённые в localStorage значения могут
 * быть из другой версии UI (без полей формы фильтра) или содержать мусор — и то
 * и другое приводится к правилам контролов, а не уходит в задачу как есть.
 */
export function normalizeCalcParams(params: CalcParams): CalcParams {
  const filterBandHz = normalizeFilterBand(params.filterBandHz)
  const storedPreset = filterPresetIsValid(params.filterPreset) ? params.filterPreset : 'custom'
  // Пара «пресет + полоса» должна быть непротиворечивой: пустая полоса — только у
  // «без фильтра», а непустая не может стоять у него же. Пресет при этом берём из
  // полосы (`filterPresetOf` без метаданных: 1–40 → «широкий», полоса одиночной
  // частоты → «одиночная», иначе «свой диапазон» — его поля покажут эти числа).
  const filterPreset =
    filterBandHz === null
      ? 'none'
      : storedPreset === 'none'
        ? filterPresetOf({ ...params, filterBandHz }, {})
        : storedPreset

  return {
    ...params,
    filterPreset,
    filterBandHz,
    notchHz: normalizeNotchHz(params.notchHz),
    singleFreqHz: clamp(params.singleFreqHz, SINGLE_FREQ_RANGE),
    bandwidthHz: clamp(params.bandwidthHz, BANDWIDTH_RANGE),
    epochLengthMs: Math.round(params.epochLengthMs),
    gridMm: clamp(params.gridMm, GRID_MM_RANGE),
    rejectThresholdUv: Math.max(0, params.rejectThresholdUv),
  }
}

/** Запуск отменён (сброс/новый расчёт) — это не ошибка пользователя. */
function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'cancelled'
}

function runningJob(): CalcJob {
  return {
    status: 'running',
    progress: 0,
    message: '',
    stage: 'queued',
    epochsDone: 0,
    epochsTotal: 0,
    error: null,
  }
}

function succeededJob(previous: CalcJob | null): CalcJob {
  return {
    ...(previous ?? runningJob()),
    status: 'succeeded',
    progress: 1,
    epochsDone: previous?.epochsTotal ?? 0,
  }
}

function failedJob(previous: CalcJob | null, message: string): CalcJob {
  return { ...(previous ?? runningJob()), status: 'failed', progress: 0, error: message }
}
