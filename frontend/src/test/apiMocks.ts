/**
 * Подмена fetch для тестов UI: отдаёт фикстуры бэкенда по путям API.
 */
import { vi } from 'vitest'
import { initStatusFixture, metaFixture, recordingFixture } from './fixtures'
import { encodeSignalBlob } from './signalBlob'
import type { InitStatus, MetaResponse, RecordingMeta } from '@/shared/api/types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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
}

export function mockApiFetch(options: MockApiOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes('/init-status')) {
      if (options.initStatusFails) {
        return jsonResponse({ detail: 'Сервис недоступен' }, 500)
      }
      return jsonResponse(options.initStatus ?? initStatusFixture)
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
