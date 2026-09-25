/**
 * Состояние раздела EDF: загруженная запись, прогресс загрузки, демо-сигнал,
 * паспорт сессии для БД.
 *
 * Раздельно от `edfParams` (параметры) и от react-query (серверный кэш):
 * запись — сессионное состояние рабочей области, его не надо ни персистить
 * (файл на сервере живёт по TTL), ни кэшировать по ключам запросов.
 *
 * Загрузка — явное действие пользователя (кнопка в тулс-хедере, кнопка в зоне
 * загрузки или drag & drop), никаких авто-запросов.
 */
import { create } from 'zustand'
import { api, apiErrorText } from '@/shared/api/client'
import type {
  ArtifactTypes,
  ChannelQc,
  CleanReport,
  PreprocessResult,
  RecordingMeta,
} from '@/shared/api/types'
import { uploadRecording } from '@/shared/api/upload'
import type { ArtifactKind } from '@/shared/lib/artifacts'
import { makeDemoSignal } from '@/shared/lib/demoSignal'
import {
  createRunToken,
  isCancelled,
  JobFailedError,
  waitForJob,
} from '@/shared/lib/jobPolling'
import { decodeSignalFrame, frameFromSignalData, type SignalFrame } from '@/shared/lib/signalFrame'
import {
  DEMO_LAYERS_SEED,
  demoLayers,
  toggleEpochMark,
  type ArtifactNavStep,
  type EdfViewerLayers,
  type EpochMark,
} from '@/shared/lib/viewerLayers'
import {
  FILTER_PRESETS,
  stageSignature,
  useEdfParams,
  type EdfParams,
  type EdfUnits,
  type RecalcStage,
} from './edfParams'
import { useDipoleCalc } from './dipoleCalc'
import { useEegParams } from './eegParams'

/** Снимает отметку «уровень в полёте», не мутируя прежний объект состояния. */
function releaseLevel(
  inFlight: Record<number, boolean>,
  level: number,
): Record<number, boolean> {
  const next = { ...inFlight }
  delete next[level]
  return next
}

/** Совпадает с MAX_UPLOAD_SIZE бэкенда (200 МБ) — проверяем до отправки */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/**
 * Токен запуска стадий: закрытие записи или новый запуск стадии делают ответы
 * прежних задач неактуальными, и они не должны трогать состояние. Механизм
 * отмены (номер попытки + проверка актуальности) — общий, `shared/lib/jobPolling.ts`.
 */
const stageRunToken = createRunToken()

/** Полоса фильтра из пресета панели: `null` — пресет «Без фильтра» */
export function filterBandOf(params: EdfParams): [number, number] | null {
  const preset = FILTER_PRESETS.find((item) => item.value === params.filterPreset)
  if (params.filterPreset === 'custom') return params.customBand
  return preset?.band ?? null
}

/**
 * Форма запроса стадии предподготовки: параметры фильтра уходят **всегда**
 * (стадии считаются на одном и том же предподготовленном сигнале), а пороги
 * артефактов и длина эпохи — только для своей стадии. Ровно как
 * `STAGE_PARAM_KEYS` в сторе параметров.
 */
export function buildPreprocessForm(stage: RecalcStage, params: EdfParams): FormData {
  const form = new FormData()
  form.set('stage', stage)

  const band = filterBandOf(params)
  if (band) {
    form.set('band_min', String(band[0]))
    form.set('band_max', String(band[1]))
  }
  if (params.notchHz) form.set('notch_hz', String(params.notchHz))
  form.set('reference', params.reference)
  if (params.reference === 'custom' && params.visibleChannels.length) {
    form.set('reference_channels', params.visibleChannels.join(','))
  }
  // Очистка (этап 4) — параметры стадии `filter`: она меняет сигнал подготовки
  form.set('notch_harmonics', String(params.notchHarmonics))
  if (params.badChannels.trim()) form.set('bad_channels', params.badChannels.trim())
  form.set('interpolate_bads', String(params.interpolateBads))
  form.set('clean_method', params.cleanMethod)
  form.set('ica_n_components', String(params.icaNComponents))

  if (stage === 'artifacts' || stage === 'epochs') {
    // Пороги детекции — вход и стадии «нарезка эпох» тоже: она пересчитывает
    // детекцию для BAD_-пометок, и без порогов считала бы дефолтами — зоны
    // расходились с пиулями легенды (199 против 8, случай 24.09.2026)
    form.set('z_threshold', String(params.zScoreThreshold))
    form.set('pp_threshold_uv', String(params.peakToPeakUv))
    form.set('flat_line_uv', String(params.flatLineUv))
    form.set('flat_line_ms', String(params.flatLineMs))
    form.set('run_ica', String(params.runIca))
  }
  if (stage === 'epochs') {
    form.set('epoch_length_ms', String(params.epochLengthMs))
  }
  return form
}

/**
 * Переносит результат стадии в слои вьюера, сохраняя слоты других стадий.
 * Стадии раздельные: пересчёт артефактов не должен сбрасывать штриховку эпох,
 * а результат расчёта помечается `source: 'result'` вместо демо-фикстуры.
 */
export function layersFromResult(
  result: PreprocessResult,
  previous: EdfViewerLayers | null,
): EdfViewerLayers {
  const base: EdfViewerLayers =
    previous && previous.source === 'result'
      ? previous
      : {
          artifacts: [],
          rejectedEpochs: [],
          rejectChannels: {},
          epochLengthMs: null,
          source: 'result',
        }
  const next: EdfViewerLayers = { ...base, source: 'result' }

  if (result.stage === 'artifacts') {
    next.artifacts = result.artifacts.map((zone, index) => ({
      id: `${zone.kind}-${index + 1}`,
      kind: zone.kind as ArtifactKind,
      onsetSec: zone.onset_sec,
      durationSec: zone.duration_sec,
      channels: zone.channels,
    }))
  }
  if (result.stage === 'epochs') {
    next.rejectedEpochs = result.rejected_epochs
    // Каналы-виновники и порог reject-фильтра — причины блокировки: рамки в
    // треках соответствующих каналов и строка в тултипе эпохи
    const channelsByIndex: Record<number, string[]> = {}
    for (const item of result.rejected_epoch_channels) {
      channelsByIndex[item.index] = [...item.channels]
    }
    next.rejectChannels = channelsByIndex
    // Индексы отброшенных эпох имеют смысл только вместе с длиной нарезки, в
    // которой они получены: вьюер строит по ней свою сетку (срез 2.10).
    next.epochLengthMs = result.epoch_length_ms > 0 ? result.epoch_length_ms : null
  }
  return next
}

/**
 * Паспорт сессии: метаданные для БД (таблица `sessions`), а не для EDF-файла.
 * Правка паспорта исходник не меняет — это данные для записи в БД при анализе.
 */
export type SessionPassport = {
  /** Название/код сессии — как её искать в групповом анализе */
  title: string
  /** Испытуемый или его код (обезличенный) */
  subject: string
  /** Дата записи (YYYY-MM-DD), пустая — не указана */
  recordedOn: string
  /** Заметки к сессии (условия, самочувствие, особенности монтажа) */
  notes: string
  /** В каких единицах амплитуда заносится в БД (файл не перезаписывается) */
  units: EdfUnits
}

export const EMPTY_PASSPORT: SessionPassport = {
  title: '',
  subject: '',
  recordedOn: '',
  notes: '',
  units: 'auto',
}

/**
 * Состояние задачи предподготовки стадии (срез 2.7): прогресс по этапам и
 * ошибка. UI показывает его на кнопке стадии — обработка идёт по кнопке.
 */
export type StageJob = {
  status: 'running' | 'succeeded' | 'failed'
  progress: number
  message: string
  /** Этап пайплайна от сервера (load_edf / artifacts / epochs / done) */
  stage: string
  error: string | null
  /** Хвост traceback при провале задачи (N31): показывается разворотом в панели */
  errorTraceback: string | null
}

/** Команды навигации по окну вьюера из тулс-хедера (срез 2.9) */
export type EdfNavCommand = 'start' | 'prev' | 'next' | 'end'

/** Числа QC стадии artifacts для панели (светофор записи, шаг 2.2) */
export type QcSummary = {
  goodDataPercent: number
  lineNoiseLevel: number | null
  badChannels: string[]
  /** Медиана SNR по каналам, дБ (null — запись короче окна Welch) */
  snrDbMedian: number | null
  /** Мёртвые каналы (константные до референса, не исправленные интерполяцией) */
  deadChannels: string[]
  /** Светофор записи: худший из четырёх категорий (сервер, пороги из конфига) */
  recordStatus: 'ok' | 'warn' | 'bad'
  /** Причины вердикта — тултип пилюли светофора */
  recordStatusReasons: string[]
}

/**
 * Паспорт фильтра из результата стадии `filter` (шаг 2.5, N11/N12): метод,
 * длина FIR-ядра и краевой буфер. Нужен подписи вьюера (N14: «треки без
 * фильтра») и блоку «Фильтр и референс» — цена фильтрации видна числом.
 */
export type FilterDesign = {
  /** none | fir | iir */
  method: string
  /** Длина FIR-ядра, с (null для IIR и без фильтра) */
  lengthSec: number | null
  /** Краевой буфер записи ±, с (эпохи у краёв — BAD_edge) */
  edgeBufferSec: number
}

export type EdfRecordingState = {
  /** Паспорт загруженной записи (null — не загружена) */
  recording: RecordingMeta | null
  /** Прогресс загрузки 0..1; null — загрузки нет */
  uploadProgress: number | null
  /** Текст ошибки загрузки (для ErrorBlock) */
  uploadError: string | null
  /** Демо-кадр сигнала для отладки вьюера (без сервера) */
  demo: SignalFrame | null
  /** Кадры пирамиды сигналов записи по уровням зума (срез 2.5) */
  signalFrames: Record<number, SignalFrame>
  /** Уровни, запрос которых уже в полёте (защита от дублей при двух эффектах) */
  signalsInFlight: Record<number, boolean>
  /** Сколько уровней сигнала грузится прямо сейчас (для индикатора) */
  signalsPending: number
  /** Текст ошибки загрузки сигналов (для ErrorBlock + «Повторить») */
  signalsError: string | null
  /**
   * Слои результата вьюера (срез 2.6): зоны артефактов и отброшенные эпохи.
   * Пока стадии не подключены к серверу — детерминированная фикстура, поэтому
   * `layers.source === 'demo'`; срез 2.7 заменит её результатом задачи.
   */
  layers: EdfViewerLayers | null
  /**
   * Ручные пометки эпох (срез 2.10): интервалы на таймлайне записи, которые
   * пользователь заблокировал или, наоборот, разблокировал поверх решения
   * reject-фильтра (Ctrl+двойной клик по треку). Живут при записи, а не в
   * `edfParams`: правка относится к конкретной сессии и в localStorage не уходит.
   */
  epochMarks: EpochMark[]
  /**
   * QC-сводка каналов из стадии `artifacts` (шаг 0.4): иконки состояния слева
   * от имён каналов вьюера. `null` — стадия ещё не запускалась (иконок нет);
   * живёт при записи, сбрасывается вместе с ней.
   */
  channelQc: Record<string, ChannelQc> | null
  /** Числа QC стадии artifacts: чистые данные, уровень 50 Гц, авто-bad-каналы */
  qcSummary: QcSummary | null
  /**
   * Счётчики типов артефактов из стадии `artifacts` (`artifact_types`): у
   * `ica_eog` это число EOG-компонент (без зоны — компоненты не привязаны ко
   * времени, фидбэк 24.09.2026), поэтому легенда берёт ICA отсюда, а не из зон.
   */
  artifactTypes: ArtifactTypes | null
  /** Отчёт очистки стадии filter (ICA/SSP/интерполяция, метрика до/после) */
  cleanReport: CleanReport | null
  /**
   * Паспорт фильтра стадии `filter` (шаг 2.5): метод FIR/IIR, длина ядра и
   * краевой буфер — подпись вьюера (N14) и блок «Фильтр и референс».
   */
  filterDesign: FilterDesign | null
  /** Пороги статуса иконок из результата стадии (конфиг сервера) */
  /** Пороги статуса иконок каналов (доля зон + SNR, из конфига сервера) */
  channelQcThresholds: { warn: number; bad: number; snrWarn: number; snrBad: number }
  /**
   * Задачи предподготовки по стадиям (срез 2.7): прогресс и ошибка каждой.
   * Хранится отдельно от снимков параметров (`stageApplied`): снимок говорит
   * «результат соответствует параметрам», а это — «задача сейчас идёт».
   */
  stageJobs: Partial<Record<RecalcStage, StageJob>>
  /** Метаданные сессии для БД (в файл не пишутся) */
  passport: SessionPassport
  /**
   * Счётчик запросов «открыть диалог выбора EDF»: тулс-хедер живёт вне рабочей
   * области, поэтому диалог открывается через состояние, а не через ref.
   */
  fileDialogRequest: number
  /**
   * Запрос навигации по окну вьюера (`<<` `<` `>` `>>` из тулс-хедера, срез 2.9):
   * центр окна — локальное состояние вьюера, а кнопки живут в шапке, поэтому
   * команда передаётся через состояние с монотонным `seq` (как `fileDialogRequest`).
   */
  navRequest: { command: EdfNavCommand; seq: number } | null
  /**
   * Шаг режима «Навигация» навигатора зума (меню пиуль легенды): индекс текущего
   * артефакта и их число — счётчик «3/47» в шапке. Держит вьюер, живёт при записи.
   */
  artifactNav: ArtifactNavStep | null
  beginUpload: () => void
  setUploadProgress: (ratio: number) => void
  failUpload: (message: string) => void
  finishUpload: (meta: RecordingMeta) => void
  /** Включить демо-сигнал (синтетика, вьюер без бэкенда) */
  openDemo: (channels?: string[]) => void
  /** Закрыть демо-режим */
  closeDemo: () => void
  /** Догрузить уровень пирамиды сигналов записи (кэшируется в сторе) */
  loadSignals: (level: number) => Promise<void>
  /**
   * Запустить стадию предподготовки по кнопке (срез 2.7): 202 + задача →
   * поллинг прогресса → результат в слои вьюера + снимок параметров стадии.
   */
  runStage: (stage: RecalcStage) => Promise<void>
  /** Правка паспорта сессии (данные для БД, файл не трогаем) */
  setPassport: (patch: Partial<SessionPassport>) => void
  /** Запросить открытие диалога выбора EDF (тулс-хедер → рабочая область) */
  requestFileDialog: () => void
  /** Запросить навигацию по окну вьюера (тулс-хедер → вьюер, срез 2.9) */
  requestNav: (command: EdfNavCommand) => void
  /** Шаг навигации по артефактам (счётчик навигатора; null — режим «окно») */
  setArtifactNav: (step: ArtifactNavStep | null) => void
  /**
   * Инверсия блокировки эпохи (Ctrl+двойной клик, срез 2.10). `interval` — эпоха
   * под курсором, `rejectedByAlgorithm` — её вердикт из результата стадии.
   */
  toggleEpochBlock: (
    interval: { onsetSec: number; durationSec: number },
    rejectedByAlgorithm: boolean,
  ) => void
  /** Снять все ручные пометки эпох (вернуться к вердиктам алгоритма) */
  clearEpochMarks: () => void
  /** Закрыть запись (вернуться к пустому состоянию) */
  closeRecording: () => void
}

export const useEdfRecording = create<EdfRecordingState>()((set, get) => ({
  recording: null,
  uploadProgress: null,
  uploadError: null,
  demo: null,
  signalFrames: {},
  signalsInFlight: {},
  signalsPending: 0,
  signalsError: null,
  layers: null,
  epochMarks: [],
  stageJobs: {},
  channelQc: null,
  qcSummary: null,
  artifactTypes: null,
  cleanReport: null,
  filterDesign: null,
  channelQcThresholds: { warn: 0.05, bad: 0.2, snrWarn: 10, snrBad: 5 },
  passport: { ...EMPTY_PASSPORT },
  fileDialogRequest: 0,
  navRequest: null,
  artifactNav: null,

  beginUpload: () => set({ uploadProgress: 0, uploadError: null, demo: null }),
  setUploadProgress: (ratio) => set({ uploadProgress: Math.min(1, Math.max(0, ratio)) }),
  failUpload: (message) => set({ uploadProgress: null, uploadError: message }),
  finishUpload: (meta) => {
    set({
      recording: meta,
      uploadProgress: null,
      uploadError: null,
      demo: null,
      // Пирамида сигналов принадлежит записи: новая запись — пустой кэш кадров
      signalFrames: {},
      signalsInFlight: {},
      signalsPending: 0,
      signalsError: null,
      // Слоёв у записи до первого расчёта нет: это честное «не рассчитано».
      // Демо-фикстура под реальный файл не подставляется — её зоны и штриховка
      // читались бы как результат детектора (ручная проверка, 19.09.2026).
      layers: null,
      artifactTypes: null,
      // Паспорт фильтра относится к результату прежней записи
      filterDesign: null,
      // Задачи прежней записи не переносим на новую
      stageJobs: {},
      // Ручные пометки эпох относятся к конкретной записи — начинаем с чистых
      epochMarks: [],
      // Паспорт принадлежит сессии: новая запись — чистый паспорт
      passport: { ...EMPTY_PASSPORT, title: meta.filename },
    })
    // Расчёт диполей и спектр относятся к конкретной записи: результат прежней
    // записи на новую не переносим — точки и топокарты сбрасываются.
    useDipoleCalc.getState().reset()
    // Спектрограмма «ЭЭГ» тоже принадлежит записи: канал и сетка прежней записи
    // к новой отношения не имеют.
    useEegParams.getState().reset()
  },

  openDemo: (channels) => {
    const signal = makeDemoSignal(channels)
    set({
      demo: frameFromSignalData(signal),
      // Единственное место, где слои берутся из фикстуры: демо-режим — это
      // витрина отрисовки, а не результат обработки (`source: 'demo'`).
      layers: demoLayers(signal.durationSec, signal.channels, DEMO_LAYERS_SEED),
      epochMarks: [],
    })
    // Демо-каналы становятся «доступными»: вьюер и блок «Каналы» работают
    // с реальным выбором пользователя, а не с отдельной веткой логики.
    useEdfParams.getState().setAvailableChannels(signal.channels)
  },
  closeDemo: () => set({ demo: null, layers: null, epochMarks: [], artifactTypes: null }),

  loadSignals: async (level) => {
    const { recording, signalFrames, signalsInFlight } = get()
    // Кадр уже есть или запрос в полёте: второй раз не грузим. Эффекты
    // «предзагрузка ×1» и «текущий уровень» на старте совпадают, и без этой
    // проверки уровень ×1 запрашивался бы дважды.
    if (!recording || signalFrames[level] || signalsInFlight[level]) return
    set((state) => ({
      signalsInFlight: { ...state.signalsInFlight, [level]: true },
      signalsPending: state.signalsPending + 1,
      signalsError: null,
    }))
    try {
      const buffer = await api.recordingSignals(recording.recording_id, level)
      const frame = decodeSignalFrame(buffer)
      set((state) => ({
        signalFrames: { ...state.signalFrames, [level]: frame },
        signalsInFlight: releaseLevel(state.signalsInFlight, level),
        signalsPending: Math.max(0, state.signalsPending - 1),
      }))
    } catch (error) {
      set((state) => ({
        signalsInFlight: releaseLevel(state.signalsInFlight, level),
        signalsPending: Math.max(0, state.signalsPending - 1),
        signalsError: apiErrorText(error),
      }))
    }
  },

  setPassport: (patch) => set((state) => ({ passport: { ...state.passport, ...patch } })),

  runStage: async (stage) => {
    const { recording } = get()
    if (!recording) return
    // Параметры фиксируем в момент запуска: если пользователь успеет что-то
    // поправить, пока задача идёт, снимок останется честным (результат посчитан
    // именно по этим значениям), а стадия снова покажет «параметры изменены».
    const params = useEdfParams.getState().params
    const signature = stageSignature(params, stage)
    const token = stageRunToken.next()
    const isCurrent = () => stageRunToken.isCurrent(token)

    set((state) => ({
      stageJobs: {
        ...state.stageJobs,
        [stage]: {
          status: 'running',
          progress: 0,
          message: '',
          stage: 'queued',
          error: null,
          errorTraceback: null,
        },
      },
    }))

    const fail = (message: string, traceback: string | null = null) => {
      if (!isCurrent()) return
      set((state) => ({
        stageJobs: {
          ...state.stageJobs,
          [stage]: {
            status: 'failed',
            progress: 0,
            message: '',
            stage: 'queued',
            error: message,
            errorTraceback: traceback,
          },
        },
      }))
    }

    try {
      const created = await api.preprocess.start(
        recording.recording_id,
        buildPreprocessForm(stage, params),
      )
      await waitForJob(created.job_id, isCurrent, (status) => {
        set((state) => ({
          stageJobs: {
            ...state.stageJobs,
            [stage]: {
              status: 'running',
              progress: status.progress,
              message: status.message,
              stage: status.stage,
              error: null,
              errorTraceback: null,
            },
          },
        }))
      })
      if (!isCurrent()) return

      const result = await api.preprocess.result(recording.recording_id, created.job_id)
      if (!isCurrent()) return

      // QC-иконки каналов: сводка приходит только у стадии artifacts
      const channelQc =
        result.stage === 'artifacts' && result.channel_qc.length
          ? Object.fromEntries(result.channel_qc.map((row) => [row.channel, row]))
          : get().channelQc
      const channelQcThresholds =
        result.stage === 'artifacts'
          ? {
              warn: result.qc_warn_share,
              bad: result.qc_bad_share,
              snrWarn: result.qc_snr_warn_db,
              snrBad: result.qc_snr_bad_db,
            }
          : get().channelQcThresholds
      // Числа QC (светофор записи, SNR, 50 Гц, bad/мёртвые каналы) и отчёт
      // очистки — в панель раздела (легенда артефактов и блок «Фильтры и референс»)
      const qcSummary =
        result.stage === 'artifacts'
          ? {
              goodDataPercent: result.good_data_percent,
              lineNoiseLevel: result.line_noise_level,
              badChannels: result.bad_channels,
              snrDbMedian: result.snr_db_median,
              deadChannels: result.dead_channels,
              recordStatus: result.record_status,
              recordStatusReasons: result.record_status_reasons,
            }
          : get().qcSummary
      const cleanReport = result.stage === 'filter' ? result.clean : get().cleanReport
      // Паспорт фильтра (шаг 2.5): метод/ядро/краевой буфер — подпись вьюера (N14)
      const filterDesign =
        result.stage === 'filter'
          ? {
              method: result.filter_method,
              lengthSec: result.filter_length_sec,
              edgeBufferSec: result.edge_buffer_sec,
            }
          : get().filterDesign
      // Счётчики типов (`artifact_types`): у `ica_eog` — число EOG-компонент
      // (зоны ICA контракт больше не отдаёт — фидбэк 24.09.2026)
      const artifactTypes =
        result.stage === 'artifacts' ? result.artifact_types : get().artifactTypes

      set((state) => ({
        layers: layersFromResult(result, state.layers),
        channelQc,
        channelQcThresholds,
        qcSummary,
        cleanReport,
        filterDesign,
        artifactTypes,
        stageJobs: {
          ...state.stageJobs,
          [stage]: {
            status: 'succeeded',
            progress: 1,
            message: '',
            stage: 'done',
            error: null,
            errorTraceback: null,
          },
        },
      }))
      // Результат получен — фиксируем снимок параметров стадии. Если параметры
      // успели измениться, стадия сразу покажет «параметры изменены».
      useEdfParams.getState().markStageApplied(stage, signature)
    } catch (error) {
      // Отмена (закрытие записи/новый запуск) — не ошибка пользователя
      if (isCancelled(error) || !isCurrent()) return
      fail(
        apiErrorText(error),
        error instanceof JobFailedError ? error.traceback : null,
      )
    }
  },

  requestFileDialog: () => set((state) => ({ fileDialogRequest: state.fileDialogRequest + 1 })),

  requestNav: (command) =>
    set((state) => ({ navRequest: { command, seq: (state.navRequest?.seq ?? 0) + 1 } })),

  setArtifactNav: (step) => set({ artifactNav: step }),

  toggleEpochBlock: (interval, rejectedByAlgorithm) =>
    set((state) => ({
      epochMarks: toggleEpochMark(state.epochMarks, interval, rejectedByAlgorithm),
    })),

  clearEpochMarks: () => set({ epochMarks: [] }),

  closeRecording: () => {
    // Отменяем поллинг: ответы прежних стадий не должны трогать новое состояние
    stageRunToken.cancel()
    set({
      recording: null,
      uploadProgress: null,
      uploadError: null,
      demo: null,
      signalFrames: {},
      signalsInFlight: {},
      signalsPending: 0,
      signalsError: null,
      // Слои результата тоже принадлежат записи — сбрасываем вместе с ней
      layers: null,
      artifactNav: null,
      epochMarks: [],
      stageJobs: {},
      channelQc: null,
      qcSummary: null,
      artifactTypes: null,
      cleanReport: null,
      filterDesign: null,
      passport: { ...EMPTY_PASSPORT },
    })
    // Выбор каналов и результат предподготовки привязаны к записи
    useEdfParams.getState().setAvailableChannels([])
    useEdfParams.getState().clearApplied()
    // Результаты расчёта диполей и спектра принадлежат закрытой записи
    useDipoleCalc.getState().reset()
    useEegParams.getState().reset()
  },
}))

/** Почему файл не принят (null — файл подходит). Проверяем до отправки на сервер. */
export function validateEdfFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.edf')) {
    return `«${file.name}» — не EDF. Поддерживаются только файлы .edf`
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1)
    return `«${file.name}» слишком большой (${mb} МБ, максимум 200 МБ)`
  }
  return null
}

/**
 * Приём файла из любого места UI (drag & drop, кнопка зоны загрузки, кнопка
 * тулс-хедера): сначала локальная проверка, затем загрузка на сервер.
 */
export function acceptEdfFile(file: File | null | undefined): void {
  if (!file) return
  const problem = validateEdfFile(file)
  if (problem) {
    useEdfRecording.getState().failUpload(problem)
    return
  }
  void startUpload(file)
}

/**
 * Полный сценарий загрузки: файл → сервер → запись + каналы записи в параметры.
 * Ошибка сети/сервера превращается в понятный текст (`uploadError`).
 */
export async function startUpload(file: File): Promise<void> {
  useEdfRecording.getState().beginUpload()
  try {
    const meta = await uploadRecording(file, (ratio) =>
      useEdfRecording.getState().setUploadProgress(ratio),
    )
    useEdfRecording.getState().finishUpload(meta)
    useEdfParams.getState().setAvailableChannels(meta.channels)
    useEdfParams.getState().clearApplied()
  } catch (error) {
    useEdfRecording.getState().failUpload(apiErrorText(error))
  }
}
