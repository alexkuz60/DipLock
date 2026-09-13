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
import type { RecordingMeta } from '@/shared/api/types'
import { uploadRecording } from '@/shared/api/upload'
import { makeDemoSignal } from '@/shared/lib/demoSignal'
import { decodeSignalFrame, frameFromSignalData, type SignalFrame } from '@/shared/lib/signalFrame'
import { DEMO_LAYERS_SEED, demoLayers, type EdfViewerLayers } from '@/shared/lib/viewerLayers'
import { useEdfParams, type EdfUnits } from './edfParams'

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

  requestFileDialog: () => set((state) => ({ fileDialogRequest: state.fileDialogRequest + 1 })),

  closeRecording: () => {
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
