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
import type { PreprocessResult, RecordingMeta } from '@/shared/api/types'
import { uploadRecording } from '@/shared/api/upload'
import type { ArtifactKind } from '@/shared/lib/artifacts'
import { makeDemoSignal } from '@/shared/lib/demoSignal'
import { decodeSignalFrame, frameFromSignalData, type SignalFrame } from '@/shared/lib/signalFrame'
import { DEMO_LAYERS_SEED, demoLayers, type EdfViewerLayers } from '@/shared/lib/viewerLayers'
import {
  FILTER_PRESETS,
  stageSignature,
  useEdfParams,
  type EdfParams,
  type EdfUnits,
  type RecalcStage,
} from './edfParams'

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
 * Сколько ждём между опросами задачи предподготовки.
 * Стадии короткие (фильтр/артефакты/эпохи на готовой записи), поэтому поллинг
 * частый: UI должен показывать прогресс без заметной задержки.
 */
const STAGE_POLL_MS = 400

/**
 * Отмена задач предподготовки: закрытие записи или новый запуск стадии делают
 * ответы прежних задач неактуальными, и они не должны трогать состояние.
 */
let stageRunToken = 0

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

  if (stage === 'artifacts') {
    form.set('z_threshold', String(params.zScoreThreshold))
    form.set('pp_threshold_uv', String(params.peakToPeakUv))
    form.set('flat_line_uv', String(params.flatLineUv))
    form.set('flat_line_ms', String(params.flatLineMs))
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
      : { artifacts: [], rejectedEpochs: [], source: 'result' }
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
  }
  return next
}

/** Ждёт завершения задачи, сообщая о прогрессе; `token` отменяет устаревшие запуски. */
async function waitForJob(
  jobId: string,
  token: number,
  onTick: (progress: number, message: string, stage: string) => void,
): Promise<void> {
  for (;;) {
    if (token !== stageRunToken) throw new Error('cancelled')
    const job = await api.job(jobId)
    if (token !== stageRunToken) throw new Error('cancelled')
    onTick(job.progress, job.message, job.stage)
    if (job.status === 'succeeded') return
    if (job.status === 'failed') throw new Error(job.error ?? 'Задача завершилась ошибкой')
    await new Promise((resolve) => setTimeout(resolve, STAGE_POLL_MS))
  }
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
  stageJobs: {},
  passport: { ...EMPTY_PASSPORT },
  fileDialogRequest: 0,

  beginUpload: () => set({ uploadProgress: 0, uploadError: null, demo: null }),
  setUploadProgress: (ratio) => set({ uploadProgress: Math.min(1, Math.max(0, ratio)) }),
  failUpload: (message) => set({ uploadProgress: null, uploadError: message }),
  finishUpload: (meta) =>
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
      // Слои результата принадлежат записи: пока это фикстура под её длину и монтаж
      layers: demoLayers(meta.duration_sec, meta.channels, DEMO_LAYERS_SEED),
      // Задачи прежней записи не переносим на новую
      stageJobs: {},
      // Паспорт принадлежит сессии: новая запись — чистый паспорт
      passport: { ...EMPTY_PASSPORT, title: meta.filename },
    }),

  openDemo: (channels) => {
    const signal = makeDemoSignal(channels)
    set({
      demo: frameFromSignalData(signal),
      layers: demoLayers(signal.durationSec, signal.channels, DEMO_LAYERS_SEED),
    })
    // Демо-каналы становятся «доступными»: вьюер и блок «Каналы» работают
    // с реальным выбором пользователя, а не с отдельной веткой логики.
    useEdfParams.getState().setAvailableChannels(signal.channels)
  },
  closeDemo: () => set({ demo: null, layers: null }),

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
    const token = ++stageRunToken

    set((state) => ({
      stageJobs: {
        ...state.stageJobs,
        [stage]: { status: 'running', progress: 0, message: '', stage: 'queued', error: null },
      },
    }))

    const fail = (message: string) => {
      if (token !== stageRunToken) return
      set((state) => ({
        stageJobs: {
          ...state.stageJobs,
          [stage]: {
            status: 'failed',
            progress: 0,
            message: '',
            stage: 'queued',
            error: message,
          },
        },
      }))
    }

    try {
      const created = await api.preprocessJob(
        recording.recording_id,
        buildPreprocessForm(stage, params),
      )
      await waitForJob(created.job_id, token, (progress, message, jobStage) => {
        if (token !== stageRunToken) return
        set((state) => ({
          stageJobs: {
            ...state.stageJobs,
            [stage]: {
              status: 'running',
              progress,
              message,
              stage: jobStage,
              error: null,
            },
          },
        }))
      })
      if (token !== stageRunToken) return

      const result = await api.preprocessResult(recording.recording_id, created.job_id)
      if (token !== stageRunToken) return

      set((state) => ({
        layers: layersFromResult(result, state.layers),
        stageJobs: {
          ...state.stageJobs,
          [stage]: { status: 'succeeded', progress: 1, message: '', stage: 'done', error: null },
        },
      }))
      // Результат получен — фиксируем снимок параметров стадии. Если параметры
      // успели измениться, стадия сразу покажет «параметры изменены».
      useEdfParams.getState().markStageApplied(stage, signature)
    } catch (error) {
      // Отмена (закрытие записи/новый запуск) — не ошибка пользователя
      if (token !== stageRunToken) return
      fail(apiErrorText(error))
    }
  },

  requestFileDialog: () => set((state) => ({ fileDialogRequest: state.fileDialogRequest + 1 })),

  closeRecording: () => {
    // Отменяем поллинг: ответы прежних стадий не должны трогать новое состояние
    stageRunToken += 1
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
      stageJobs: {},
      passport: { ...EMPTY_PASSPORT },
    })
    // Выбор каналов и результат предподготовки привязаны к записи
    useEdfParams.getState().setAvailableChannels([])
    useEdfParams.getState().clearApplied()
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
