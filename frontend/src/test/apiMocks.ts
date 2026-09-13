/**
 * Подмена fetch для тестов UI: отдаёт фикстуры бэкенда по путям API.
 */
import { vi } from 'vitest'
import { initStatusFixture, metaFixture } from './fixtures'
import type { InitStatus, MetaResponse } from '@/shared/api/types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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
  /** Смоделировать недоступность сервера (500 на /init-status) */
  initStatusFails?: boolean
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
    if (url.includes('/meta')) {
      return jsonResponse(options.meta ?? metaFixture)
    }
    return jsonResponse({ detail: `Нет мока для ${url}` }, 404)
  })

  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
