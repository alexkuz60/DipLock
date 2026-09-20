/**
 * Состояние раздела «Диполи» (срез 3.4): выделенный диполь, порог «КД», окно
 * частот FFT-графика, открытая выдвижная панель и результаты задач.
 *
 * Правило раздела то же, что в EDF (`docs/ui.md`): правка параметра **ничего не
 * запускает**. Расчёт стартует только кнопкой (`POST /recordings/{id}/dipoles`),
 * спектр — отдельной кнопкой (`…/spectrum`), а параметры лишь помечают, что
 * результат устарел.
 *
 * Что здесь, а что нет (разрезка 17.09.2026):
 * - **домен** — параметры расчёта и их дефолты, рамки контролов, формы запросов,
 *   состояние фоновой задачи, отпечатки параметров и результата, а также типы
 *   состояния просмотра — в `shared/lib/dipoleCalcModel.ts` (чистый модуль: те же
 *   правила проверяются без хранилища);
 * - здесь — значения и **действия**: сеттеры формы, запуск задач с поллингом,
 *   сброс и персист. Результаты задач принадлежат записи и сбрасываются вместе с
 *   ней (закрытие записи);
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
  clamp,
  filterPresetOf,
  normalizeFilterBand,
  normalizeNotchHz,
  singleFreqBand,
  type CalcFilterPresetId,
} from '@/shared/lib/calcFilter'
import {
  CALC_PARAM_DEFAULTS,
  GRID_MM_RANGE,
  PLAYBACK_DEFAULTS,
  THRESHOLD_NAM_RANGE,
  buildDipoleForm,
  buildSpectrumForm,
  buildRefineForm,
  calcJobFromStatus,
  normalizeCalcParams,
  normalizeRefineHalfwin,
  type CalcJob,
  type CalcParams,
  type CalcView,
  type PlaybackState,
} from '@/shared/lib/dipoleCalcModel'
import { createRunToken, isCancelled, waitForJob } from '@/shared/lib/jobPolling'
import { normalizeFreqWindow, type FreqWindow } from '@/shared/lib/spectrum'
import { canPlayback, clampEpochIndex, normalizePlaybackSpeed } from '@/shared/lib/playback'
import type { DipoleRefineResult, DipoleScanResult, SpectrumResult } from '@/shared/api/types'

/**
 * Токен запуска расчёта: новый расчёт, новый спектр или сброс делают ответы
 * прежних задач неактуальными, и они не должны трогать состояние. Механизм
 * отмены (номер попытки + проверка актуальности) — общий, `shared/lib/jobPolling.ts`.
 */
const calcRunToken = createRunToken()

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
  /** Задача точного уточнения эпохи (F19, «Уточнить…» в таблице локализации) */
  refineJob: CalcJob | null
  /** Эпоха, которая уточняется прямо сейчас (с 0); `null` — уточнения нет */
  refiningEpoch: number | null
  /**
   * Уточнённые точки по номеру эпохи: «было/стало» живёт здесь, а результат
   * быстрого расчёта не переписывается — он остаётся тем, что посчитала задача.
   */
  refinedPoints: Record<number, DipoleRefineResult>
  /** Текст последней ошибки уточнения — отдельно от ошибки расчёта */
  refineError: string | null
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
  /**
   * Точное уточнение эпохи (BEM fit_dipole): параметры нарезки берутся из
   * **результата** быстрого расчёта (`buildRefineForm`), а не из формы панели.
   */
  refineEpoch: (recordingId: string | null, epochIndex: number) => Promise<void>
  /**
   * Окно свободного фитинга уточнения, мс (0 — только пик GFP, шаг 1.5).
   * Предпочтение просмотра и персистится: «сколько ждать» пользователь выбирает
   * один раз, а не перед каждым уточнением. Значение — из списка вариантов.
   */
  refineHalfwinMs: number
  /** Окно уточнения из списка вариантов (`REFINE_HALFWIN_OPTIONS`) */
  setRefineHalfwinMs: (value: number) => void
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
      refineJob: null,
      refiningEpoch: null,
      refinedPoints: {},
      refineError: null,
      // Окно уточнения — предпочтение просмотра (персистится): по умолчанию
      // только пик GFP, то есть ≈8 с вместо ≈80 с на окне ±10 мс (шаг 1.5)
      refineHalfwinMs: 0,

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
      // Окно уточнения — только варианты списка: произвольное число здесь значило
      // бы «случайные 40 секунд счёта», а не выбор точности (шаг 1.5)
      setRefineHalfwinMs: (value) => set({ refineHalfwinMs: normalizeRefineHalfwin(value) }),
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
        const token = calcRunToken.next()
        const isCurrent = () => calcRunToken.isCurrent(token)
        set({
          job: runningJob(),
          error: null,
        })
        try {
          const created = await api.dipoles.start(recordingId, buildDipoleForm(params))
          await waitForJob(created.job_id, isCurrent, (status) =>
            set({ job: calcJobFromStatus(status) }),
          )
          if (!isCurrent()) return
          const result = await api.dipoles.result(recordingId, created.job_id)
          if (!isCurrent()) return
          // Новый результат — новый кадр воспроизведения: прежняя эпоха относилась
          // к другой нарезке (номер эпохи без результата ничего не значит)
          set({
            result,
            job: succeededJob(get().job),
            // Уточнения привязаны к нарезке прежнего результата — новая нарезка
            // делает их чужими (как и кадр воспроизведения ниже)
            refinedPoints: {},
            refineJob: null,
            refiningEpoch: null,
            refineError: null,
            playback: {
              ...get().playback,
              playing: false,
              active: false,
              epochIndex: 0,
              seekSeq: 0,
            },
          })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          set({ job: failedJob(get().job, apiErrorText(error)), error: apiErrorText(error) })
        }
      },

      runSpectrum: async (recordingId) => {
        if (!recordingId) return
        const params = get().params
        const token = calcRunToken.next()
        const isCurrent = () => calcRunToken.isCurrent(token)
        set({ spectrumJob: runningJob(), spectrumError: null })
        try {
          const created = await api.spectrum.start(recordingId, buildSpectrumForm(params))
          await waitForJob(created.job_id, isCurrent, (status) =>
            set({ spectrumJob: calcJobFromStatus(status) }),
          )
          if (!isCurrent()) return
          const spectrum = await api.spectrum.result(recordingId, created.job_id)
          if (!isCurrent()) return
          set({ spectrum, spectrumJob: succeededJob(get().spectrumJob) })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          set({
            spectrumJob: failedJob(get().spectrumJob, apiErrorText(error)),
            spectrumError: apiErrorText(error),
          })
        }
      },

      refineEpoch: async (recordingId, epochIndex) => {
        const result = get().result
        if (!recordingId || !result) return
        const token = calcRunToken.next()
        const isCurrent = () => calcRunToken.isCurrent(token)
        set({
          refineJob: runningJob(),
          refiningEpoch: epochIndex,
          refineError: null,
        })
        try {
          const created = await api.dipoleRefine.start(
            recordingId, buildRefineForm(result, epochIndex, get().refineHalfwinMs),
          )
          await waitForJob(created.job_id, isCurrent, (status) =>
            set({ refineJob: calcJobFromStatus(status) }),
          )
          if (!isCurrent()) return
          const refined = await api.dipoleRefine.result(recordingId, created.job_id)
          // Ключ — ЗАПРОШЕННАЯ эпоха (она привязана к выбранной точке); номер из
          // ответа — эхо сервера, и расхождение не должно прятать результат
          if (refined.epoch_index !== epochIndex) {
            console.warn('dipole_refine: эпоха ответа не совпала с запрошенной', refined.epoch_index, epochIndex)
          }
          if (!isCurrent()) return
          set({
            refinedPoints: { ...get().refinedPoints, [epochIndex]: refined },
            refineJob: succeededJob(get().refineJob),
            refiningEpoch: null,
          })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          set({
            refineJob: failedJob(get().refineJob, apiErrorText(error)),
            refineError: apiErrorText(error),
            refiningEpoch: null,
          })
        }
      },

      reset: () => {
        // Отменяем поллинг: ответы прежних задач не должны трогать новое состояние
        calcRunToken.cancel()
        set({
          job: null,
          result: null,
          spectrumJob: null,
          spectrum: null,
          error: null,
          spectrumError: null,
          refineJob: null,
          refiningEpoch: null,
          refinedPoints: {},
          refineError: null,
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
        // Окно уточнения — предпочтение просмотра: оно переживает перезагрузку
        // (результаты задач — нет, они привязаны к записи)
        refineHalfwinMs: state.refineHalfwinMs,
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
          // Окно уточнения из старого хранилища может быть любым числом (или его
          // не было): приводим к списку вариантов, а не отправляем в форму как есть
          refineHalfwinMs: normalizeRefineHalfwin(stored.refineHalfwinMs),
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
