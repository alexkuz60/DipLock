/**
 * Чат консилиума: адресаты чипами/`@`, отправка только кнопкой, живой текст
 * стрима, честный отказ и повтор ответа.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatSection } from './AgentChatSection'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { AgentMessage, AgentRole } from '@/shared/api/types'

const roles: AgentRole[] = [
  {
    id: 'psychologist', label: 'Психолог', instruction: 'x', provider_id: null,
    model: null, enabled: true, builtin: true, sort: 0,
  },
  {
    id: 'archivist', label: 'Архивариус', instruction: 'y', provider_id: null,
    model: null, enabled: true, builtin: true, sort: 1,
  },
]

function makeMessage(changes: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'm-1', thread_id: 't-1', author: 'researcher', role_id: null, addressees: [],
    status: 'ok', text: 'Вопрос', model: null, error: null, warnings: [],
    latency_ms: null, created_at: '2026-11-20T10:00:00', finished_at: '2026-11-20T10:00:00',
    ...changes,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
}

function sse(frames: unknown[]) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const item of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`))
        }
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

function mockServer(messages: AgentMessage[], streamFrames: unknown[] = []) {
  const items = [...messages]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/agent-chat', '')
    const method = init?.method ?? 'GET'
    if (path === '/roles') return response({ items: roles })
    if (path === '/threads' && method === 'GET') {
      return response({
        items: [{ id: 't-1', title: 'Беседа', messages: items.length, created_at: '2026-11-20T10:00:00' }],
      })
    }
    if (path === '/threads/t-1/messages' && method === 'GET') return response({ items })
    if (path === '/threads/t-1/messages' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; role_ids: string[] }
      const question = makeMessage({ id: 'm-q', text: body.text, addressees: body.role_ids })
      const reply = makeMessage({
        id: 'm-r', author: 'agent', role_id: body.role_ids[0] ?? 'archivist',
        status: 'running', text: null,
      })
      items.push(question, reply)
      return response({ message: question, replies: [reply] }, 202)
    }
    if (path.endsWith('/retry') && method === 'POST') {
      const target = items.find((item) => item.id === 'm-f')
      if (target) Object.assign(target, { status: 'running', error: null })
      return response(target, 202)
    }
    if (path.endsWith('/stream')) return sse(streamFrames)
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

function lastPost(fetchMock: ReturnType<typeof mockServer>) {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => String(input).endsWith('/threads/t-1/messages') && init?.method === 'POST',
  )
  return call ? JSON.parse(String(call[1]?.body)) : null
}

describe('AgentChatSection', () => {
  it('не отправляет без кнопки и шлёт выбранных адресатов', async () => {
    const fetchMock = mockServer([])
    renderWithProviders(<AgentChatSection />, { route: '/consilium?thread=t-1' })
    const field = await screen.findByLabelText('Сообщение')
    expect(screen.getByText(/Сообщения передаются провайдерам/)).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Психолог' }))
    fireEvent.change(field, { target: { value: 'Что скажете?' } })
    expect(lastPost(fetchMock)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() => expect(lastPost(fetchMock)).not.toBeNull())
    expect(lastPost(fetchMock)).toEqual({ text: 'Что скажете?', role_ids: ['psychologist'] })
  })

  it('показывает живой текст идущего ответа из стрима', async () => {
    mockServer(
      [makeMessage(), makeMessage({ id: 'm-r', author: 'agent', role_id: 'archivist', status: 'running', text: null })],
      [
        { type: 'role_started', role: 'archivist', status: 'streaming' },
        { type: 'delta', role: 'archivist', delta: 'Частичный ответ' },
      ],
    )
    renderWithProviders(<AgentChatSection />, { route: '/consilium?thread=t-1' })
    expect(await screen.findByText('Частичный ответ')).toBeInTheDocument()
  })

  it('честно показывает отказ и повторяет ответ', async () => {
    const fetchMock = mockServer([
      makeMessage(),
      makeMessage({
        id: 'm-f', author: 'agent', role_id: 'psychologist', status: 'failed',
        text: null, error: 'Сеть недоступна',
      }),
    ])
    renderWithProviders(<AgentChatSection />, { route: '/consilium?thread=t-1' })
    expect(await screen.findByText(/Сеть недоступна/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить ответ' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith('/m-f/retry')),
      ).toBe(true),
    )
  })
})
