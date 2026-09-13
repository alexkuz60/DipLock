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
import { apiErrorText } from '@/shared/api/client'
import type { RecordingMeta } from '@/shared/api/types'
import { uploadRecording } from '@/shared/api/upload'
import { makeDemoSignal, type SignalData } from '@/shared/lib/demoSignal'
import { useEdfParams, type EdfUnits } from './edfParams'

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
  /** Демо-сигнал для отладки вьюера (без сервера) */
  demo: SignalData | null
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
  /** Правка паспорта сессии (данные для БД, файл не трогаем) */
  setPassport: (patch: Partial<SessionPassport>) => void
  /** Запросить открытие диалога выбора EDF (тулс-хедер → рабочая область) */
  requestFileDialog: () => void
  /** Закрыть запись (вернуться к пустому состоянию) */
  closeRecording: () => void
}

export const useEdfRecording = create<EdfRecordingState>()((set) => ({
  recording: null,
  uploadProgress: null,
  uploadError: null,
  demo: null,
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
      // Паспорт принадлежит сессии: новая запись — чистый паспорт
      passport: { ...EMPTY_PASSPORT, title: meta.filename },
    }),

  openDemo: (channels) => {
    const signal = makeDemoSignal(channels)
    set({ demo: signal })
    // Демо-каналы становятся «доступными»: вьюер и блок «Каналы» работают
    // с реальным выбором пользователя, а не с отдельной веткой логики.
    useEdfParams.getState().setAvailableChannels(signal.channels)
  },
  closeDemo: () => set({ demo: null }),

  setPassport: (patch) => set((state) => ({ passport: { ...state.passport, ...patch } })),

  requestFileDialog: () => set((state) => ({ fileDialogRequest: state.fileDialogRequest + 1 })),

  closeRecording: () => {
    set({
      recording: null,
      uploadProgress: null,
      uploadError: null,
      demo: null,
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
