/**
 * Боковая консультация (срез 0015): отправка только кнопкой, живой текст стрима,
 * честный отказ и повтор ответа новой попыткой; без снимка — ввод выключен.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsultationChat } from './ConsultationChat'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { ConsiliumCase, ConsiliumChat, ConsiliumChatMessage } from '@/shared/api/types'
import { useConsiliumOptions } from '@/shared/state/consiliumOptions'

const testCase: ConsiliumCase = {
  id: 'case-a',
  title: 'Музыка',
  question: 'Что доброволец чувствовал?',
  version: 2,
  status: 'open',
  direction: 'music',
  subject_codes: ['V-1'],
  recording_ids: [],
  created_at: '2026-10-10T10:00:00',
  updated_at: '2026-10-10T10:00:00',
}

const snapshot = {
  id: 'snap-1',
  case_id: 'case-a',
  case_version: 2,
  created_at: '2026-10-14T09:00:00',
  question: 'Что доброволец чувствовал?',
  title: 'Музыка',
  subject_codes: ['V-1'],
  recording_ids: [],
  evidence: [],
  context: [],
  sha256: 'a'.repeat(64),
}

const chat: ConsiliumChat = {
  id: 'chat-1',
  case_id: 'case-a',
  role: 'psychological',
  messages: 2,
  created_at: '2026-10-14T10:00:00',
}

function makeMessage(changes: Partial<ConsiliumChatMessage> = {}): ConsiliumChatMessage {
  return {
    id: 'msg-1',
    case_id: 'case-a',
    chat_id: 'chat-1',
    author: 'researcher',
    role: 'psychological',
    status: 'ok',
    text: 'Что стоит уточнить у добровольца?',
    model: null,
    instruction_version: null,
    snapshot_id: null,
    warnings: [],
    error: null,
    latency_ms: null,
    created_at: '2026-10-14T10:00:00',
    finished_at: '2026-10-14T10:00:00',
    ...changes,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(frames: unknown[]) {
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

function mockServer(
  messages: ConsiliumChatMessage[],
  options: { snapshots?: number; chats?: ConsiliumChat[]; streamFrames?: unknown[] } = {},
) {
  const items = [...messages]
  const chats = [...(options.chats ?? [])]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/consilium/cases/case-a', '')
    const method = init?.method ?? 'GET'
    if (path === '/snapshots') {
      const count = options.snapshots ?? 1
      return response({
        total: count,
        items: count ? [snapshot] : [],
      })
    }
    if (path === '/chats' && method === 'GET')
      return response({ total: chats.length, items: chats })
    if (path.endsWith('/messages') && method === 'GET')
      return response({ total: items.length, items })
    if (path === '/chat-messages' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string }
      const user = makeMessage({ id: `msg-${items.length + 1}`, text: body.text })
      const reply = makeMessage({
        id: `msg-${items.length + 2}`,
        author: 'advisor',
        status: 'running',
        text: null,
        instruction_version: '1',
        snapshot_id: 'snap-1',
      })
      items.push(user, reply)
      if (!chats.length) chats.push({ ...chat, messages: items.length })
      return response({ message: user, reply }, 202)
    }
    if (path.endsWith('/retry') && method === 'POST') {
      const attempt = makeMessage({
        id: `msg-${items.length + 1}`,
        author: 'advisor',
        status: 'running',
        text: null,
        model: null,
        error: null,
      })
      items.push(attempt)
      return response(attempt, 202)
    }
    if (path.endsWith('/stream')) return sseResponse(options.streamFrames ?? [])
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  useConsiliumOptions.getState().reset()
})

describe('ConsultationChat', () => {
  it('отправка — только кнопкой; реплика уходит с ключом повтора и очищает ввод', async () => {
    const fetchMock = mockServer([])
    renderWithProviders(<ConsultationChat current={testCase} />)

    expect(await screen.findByText(/Переписка пуста/)).toBeInTheDocument()
    const input = screen.getByPlaceholderText('Вопрос или уточнение…')
    fireEvent.change(input, { target: { value: 'Что спросить у добровольца?' } })
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/chat-messages'),
      expect.objectContaining({ method: 'POST' }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/chat-messages'),
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const call = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST')
    const body = JSON.parse(String(call?.[1]?.body ?? '{}'))
    expect(body.text).toBe('Что спросить у добровольца?')
    expect(body.role).toBe('psychological')
    expect(body.expected_version).toBe(2)
    expect(typeof body.request_id).toBe('string')
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('без снимка досье консультация недоступна — ввод и отправка выключены', async () => {
    mockServer([], { snapshots: 0 })
    renderWithProviders(<ConsultationChat current={testCase} />)

    expect(await screen.findByText(/Нет опубликованного снимка досье/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Вопрос или уточнение…')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled()
  })

  it('стриминг: растущий текст ответа виден до завершения задачи', async () => {
    mockServer(
      [
        makeMessage(),
        makeMessage({
          id: 'msg-2',
          author: 'advisor',
          status: 'running',
          text: null,
          instruction_version: '1',
          snapshot_id: 'snap-1',
        }),
      ],
      {
        chats: [chat],
        streamFrames: [
          { type: 'role_started', role: 'psychological', status: 'streaming' },
          { type: 'delta', role: 'psychological', delta: 'Уточните, как ' },
          { type: 'delta', role: 'psychological', delta: 'менялось самочувствие…' },
        ],
      },
    )
    renderWithProviders(<ConsultationChat current={testCase} />)

    expect(await screen.findByText(/Запрос к внешней модели выполняется…/)).toBeInTheDocument()
    expect(await screen.findByText(/Уточните, как менялось самочувствие…/)).toBeInTheDocument()
  })

  it('неудавшийся ответ показывает ошибку и повторяется новой попыткой', async () => {
    const fetchMock = mockServer(
      [
        makeMessage(),
        makeMessage({
          id: 'msg-2',
          author: 'advisor',
          status: 'failed',
          text: null,
          error: 'Сеть недоступна',
          instruction_version: '1',
          snapshot_id: 'snap-1',
        }),
      ],
      { chats: [chat] },
    )
    renderWithProviders(<ConsultationChat current={testCase} />)

    expect(await screen.findByText(/Модель не ответила: Сеть недоступна/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить ответ' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/chat-messages/msg-2/retry'),
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('архивированное дело — только чтение: ввод выключен', async () => {
    mockServer([], { chats: [chat] })
    renderWithProviders(<ConsultationChat current={{ ...testCase, status: 'archived' }} />)
    await screen.findByText(/Личная консультация/)
    expect(screen.getByPlaceholderText('Вопрос или уточнение…')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled()
  })
})