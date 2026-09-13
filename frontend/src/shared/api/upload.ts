/**
 * Загрузка EDF-записи с прогрессом: fetch не умеет upload-прогресс,
 * поэтому здесь XMLHttpRequest (остальные запросы — через `client.ts`).
 */
import { ApiError, API_PREFIX } from './client'
import type { RecordingMeta } from './types'

export type UploadProgress = (ratio: number) => void

export function uploadRecording(
  file: File,
  onProgress: UploadProgress = () => {},
): Promise<RecordingMeta> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_PREFIX}/recordings`)
    xhr.responseType = 'json'
    xhr.timeout = 120_000

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      const body = xhr.response as unknown
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as RecordingMeta)
        return
      }
      const detail = (body as { detail?: unknown } | null)?.detail
      reject(
        new ApiError(
          typeof detail === 'string' ? detail : `Ошибка загрузки (HTTP ${xhr.status})`,
          xhr.status,
          detail,
        ),
      )
    }
    xhr.onerror = () =>
      reject(new ApiError('Сервер недоступен (проверьте, запущен ли backend)', 0))
    xhr.ontimeout = () => reject(new ApiError('Таймаут загрузки файла', 0))

    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}
