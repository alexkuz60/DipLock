/**
 * Подмена fetch для тестов UI: отдаёт фикстуры бэкенда по путям API.
 */
import { vi } from 'vitest'
import {
  calcJobFixture,
  dipoleScanResultFixture,
  initStatusFixture,
  metaFixture,
  preprocessJobFixture,
  preprocessResultFixture,
  recordingFixture,
  spectrumResultFixture,
} from './fixtures'
import { encodeSignalBlob } from './signalBlob'
import type {
  DipoleScanResult,
  InitStatus,
  JobStatus,
  MetaResponse,
  PreprocessResult,
  PreprocessStage,
  RecordingMeta,
  SpectrumResult,
} from '@/shared/api/types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 202-ответ запуска задачи расчёта (срез 3.4): id задачи и адреса поллинга. */
function calcJobCreated(jobId: string, kind: 'spectrum' | 'dipoles'): Record<string, string> {
  return {
    job_id: jobId,
    status: 'queued',
    poll_url: `/api/v1/jobs/${jobId}`,
    result_url: `/api/v1/recordings/${recordingFixture.recording_id}/${kind}/${jobId}`,
  }
}

/**
 * Сигналы записи для мока: 3 канала, 10 с, огибающая 100 точек (уровень ×1).
 * Формат — тот же контейнер, что отдаёт бэкенд (см. `signalBlob.ts`).
 */
export function signalsFixtureResponse(
  channels: string[] = recordingFixture.channels,
): Response {
  const nPoints = 100
  const body = encodeSignalBlob(
    {
      recording_id: recordingFixture.recording_id,
      level: 1,
      channels,
      sfreq: nPoints / recordingFixture.duration_sec,
      duration_sec: recordingFixture.duration_sec,
      n_points: nPoints,
      decimated: true,
      dtype: 'float32',
      byte_order: 'little',
      layout: 'channel-major',
    },
    channels.map((name, index) => ({
      name,
      min: Array.from({ length: nPoints }, (_, i) => -20 - index + Math.sin(i / 5)),
      max: Array.from({ length: nPoints }, (_, i) => 20 + index - Math.sin(i / 5)),
    })),
  )
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', ETag: '"mock-signals"' },
  })
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

export type MockApiOptions = {
  initStatus?: InitStatus
  meta?: MetaResponse
  /** Паспорт записи для GET /recordings/{id} */
  recording?: RecordingMeta
  /** Смоделировать недоступность сервера (500 на /init-status) */
  initStatusFails?: boolean
  /** Смоделировать отказ сигналов записи (например 404 после TTL) */
  signalsFail?: boolean
  /** Стадия предподготовки, если запрос её не указал (срез 2.7) */
  preprocessStage?: PreprocessStage
  /** Явный результат стадии (иначе — фикстура под запрошенную стадию) */
  preprocessResult?: PreprocessResult
  /** Статус задачи предподготовки: failed имитирует ошибку стадии */
  preprocessJob?: JobStatus
  /** Смоделировать отказ запуска стадии (404 записи) */
  preprocessStartFails?: boolean
  /** Статус задачи расчёта раздела «Диполи» (спектр и диполи) — для поллинга */
  calcJob?: JobStatus
  /** Явный результат спектра по диапазонам */
  spectrumResult?: SpectrumResult
  /** Явный результат быстрого расчёта диполей */
  dipoleScanResult?: DipoleScanResult
  /** Смоделировать отказ запуска расчёта (404 записи) */
  calcStartFails?: boolean
}

export function mockApiFetch(options: MockApiOptions = {}) {
  // Мок «помнит» стадию из POST: результат GET должен соответствовать запросу
  let requestedStage: PreprocessStage = options.preprocessStage ?? 'artifacts'

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'

    if (url.includes('/init-status')) {
      if (options.initStatusFails) {
        return jsonResponse({ detail: 'Сервис недоступен' }, 500)
      }
      return jsonResponse(options.initStatus ?? initStatusFixture)
    }
    if (url.includes('/preprocess')) {
      if (method === 'POST') {
        const form = init?.body as FormData | undefined
        const stage = form?.get('stage')
        if (stage) requestedStage = String(stage) as PreprocessStage
        if (options.preprocessStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(
          {
            job_id: preprocessJobFixture.job_id,
            status: preprocessJobFixture.status,
            poll_url: `/api/v1/jobs/${preprocessJobFixture.job_id}`,
            result_url: `/api/v1/recordings/${recordingFixture.recording_id}/preprocess/${preprocessJobFixture.job_id}`,
          },
          202,
        )
      }
      return jsonResponse(
        options.preprocessResult ?? preprocessResultFixture(requestedStage),
      )
    }
    if (url.includes('/spectrum')) {
      if (url.includes('/topomap/')) {
        // Картинку топокарты в jsdom никто не декодирует — важно лишь, что URL живой
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'Content-Type': 'image/png', ETag: '"mock-topomap"' },
        })
      }
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated(calcJobFixture.job_id, 'spectrum'), 202)
      }
      return jsonResponse(options.spectrumResult ?? spectrumResultFixture())
    }
    if (url.includes('/dipoles')) {
      if (method === 'POST') {
        if (options.calcStartFails) {
          return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
        }
        return jsonResponse(calcJobCreated(calcJobFixture.job_id, 'dipoles'), 202)
      }
      return jsonResponse(options.dipoleScanResult ?? dipoleScanResultFixture())
    }
    if (url.includes('/jobs/')) {
      return jsonResponse(options.calcJob ?? options.preprocessJob ?? preprocessJobFixture)
    }
    if (url.includes('/signals')) {
      if (options.signalsFail) {
        return jsonResponse({ detail: 'Запись не найдена или уже удалена' }, 404)
      }
      return signalsFixtureResponse()
    }
    if (url.includes('/meta')) {
      return jsonResponse(options.meta ?? metaFixture)
    }
    if (url.includes('/recordings/')) {
      return jsonResponse(options.recording ?? recordingFixture)
    }
    return jsonResponse({ detail: `Нет мока для ${url}` }, 404)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
