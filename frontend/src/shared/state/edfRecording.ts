/**
 * Состояние раздела EDF: загруженная запись, прогресс загрузки, демо-сигнал.
 *
 * Раздельно от `edfParams` (параметры) и от react-query (серверный кэш):
 * запись — сессионное состояние рабочей области, его не надо ни персистить
 * (файл на сервере живёт по TTL), ни кэшировать по ключам запросов.
 *
 * Загрузка — явное действие пользователя (кнопка/DnD), никаких авто-запросов.
 */
import { create } from 'zustand'
import { apiErrorText } from '@/shared/api/client'
import type { RecordingMeta } from '@/shared/api/types'
import { uploadRecording } from '@/shared/api/upload'
import { makeDemoSignal, type SignalData } from '@/shared/lib/demoSignal'
import { useEdfParams } from './edfParams'

export type EdfRecordingState = {
  /** Паспорт загруженной записи (null — не загружена) */
  recording: RecordingMeta | null
  /** Прогресс загрузки 0..1; null — загрузки нет */
  uploadProgress: number | null
  /** Текст ошибки загрузки (для ErrorBlock) */
  uploadError: string | null
  /** Демо-сигнал для отладки вьюера (без сервера) */
  demo: SignalData | null
  beginUpload: () => void
  setUploadProgress: (ratio: number) => void
  failUpload: (message: string) => void
  finishUpload: (meta: RecordingMeta) => void
  /** Включить демо-сигнал (синтетика, вьюер без бэкенда) */
  openDemo: (channels?: string[]) => void
  /** Закрыть демо-режим */
  closeDemo: () => void
  /** Закрыть запись (вернуться к пустому состоянию) */
  closeRecording: () => void
}

export const useEdfRecording = create<EdfRecordingState>()((set) => ({
  recording: null,
  uploadProgress: null,
  uploadError: null,
  demo: null,

  beginUpload: () => set({ uploadProgress: 0, uploadError: null, demo: null }),
  setUploadProgress: (ratio) => set({ uploadProgress: Math.min(1, Math.max(0, ratio)) }),
  failUpload: (message) => set({ uploadProgress: null, uploadError: message }),
  finishUpload: (meta) =>
    set({ recording: meta, uploadProgress: null, uploadError: null, demo: null }),

  openDemo: (channels) => {
    const signal = makeDemoSignal(channels)
    set({ demo: signal })
    // Демо-каналы становятся «доступными»: вьюер и блок «Каналы» работают
    // с реальным выбором пользователя, а не с отдельной веткой логики.
    useEdfParams.getState().setAvailableChannels(signal.channels)
  },
  closeDemo: () => set({ demo: null }),

  closeRecording: () => {
    set({ recording: null, uploadProgress: null, uploadError: null, demo: null })
    // Выбор каналов и результат предподготовки привязаны к записи
    useEdfParams.getState().setAvailableChannels([])
    useEdfParams.getState().clearApplied()
  },
}))

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
