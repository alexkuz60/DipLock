/**
 * Веб-поиск Архивариуса: запрос уходит поисковику только по кнопке «Найти»,
 * перевод — отдельной кнопкой, результаты и перевод видны в нити.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentWebSearch } from './AgentWebSearch'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { AgentWebSearch as AgentWebSearchItem } from '@/shared/api/types'

function makeSearch(changes: Partial<AgentWebSearchItem> = {}): AgentWebSearchItem {
  return {
    id: 's-1', thread_id: 't-1', role_id: 'archivist', query: 'EEG microstates',
    provider: 'duckduckgo', translated: false, created_at: '2026-11-22T10:00:00',
    translated_at: null,
    results: [
      {
        title: 'EEG microstates review', url: 'https://example.org/a',
        snippet: 'A review of EEG microstates.', title_ru: null, snippet_ru: null, error: null,
      },
    ],
    ...changes,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer(items: AgentWebSearchItem[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/agent-chat', '')
    const method = init?.method ?? 'GET'
    if (path === '/threads/t-1/web-search' && method === 'GET') return response({ items })
    if (path === '/threads/t-1/web-search' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
      const created = makeSearch({ id: 's-2', query: body.query, results: [] })
      items.unshift(created)
      return response(created, 201)
    }
    if (path === '/threads/t-1/web-search/s-1/translate' && method === 'POST') {
      const target = items.find((item) => item.id === 's-1')
      if (target) {
        target.translated = true
        target.translated_at = '2026-11-22T10:05:00'
        target.results = target.results.map((result) => ({
          ...result,
          title_ru: 'Обзор микросостояний ЭЭГ',
          snippet_ru: 'Обзор литературы по микросостояниям ЭЭГ.',
        }))
      }
      return response(target)
    }
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

function openBlock() {
  fireEvent.click(screen.getByText('Веб-поиск для Архивариуса'))
}

describe('AgentWebSearch', () => {
  it('ищет только по кнопке и предупреждает о передаче запроса', async () => {
    const fetchMock = mockServer([makeSearch()])
    renderWithProviders(<AgentWebSearch threadId="t-1" />)
    openBlock()
    expect(await screen.findByText('EEG microstates review')).toBeInTheDocument()
    expect(screen.getByText(/уходит поисковику/)).toBeInTheDocument()
    const field = screen.getByLabelText('Поисковый запрос')
    fireEvent.change(field, { target: { value: 'EEG microstates depression' } })
    const posts = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith('/threads/t-1/web-search') && init?.method === 'POST',
      )
    expect(posts()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Найти' }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(JSON.parse(String(posts()[0][1]?.body))).toEqual({
      query: 'EEG microstates depression',
    })
    expect(await screen.findByText('EEG microstates depression')).toBeInTheDocument()
  })

  it('переводит найденное на русский отдельной кнопкой', async () => {
    const fetchMock = mockServer([makeSearch()])
    renderWithProviders(<AgentWebSearch threadId="t-1" />)
    openBlock()
    expect(await screen.findByText('без перевода')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Перевести на русский' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith('/s-1/translate')),
      ).toBe(true),
    )
    expect(await screen.findByText('Обзор микросостояний ЭЭГ')).toBeInTheDocument()
    expect(screen.getByText('перевод есть')).toBeInTheDocument()
  })
})
