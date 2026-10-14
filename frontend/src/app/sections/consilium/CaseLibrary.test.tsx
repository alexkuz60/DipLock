/**
 * Библиотека исследования (Т5, срез 0013): карточки предложений, решения
 * человека (append-only) и ручные исполнения; запусков расчётов нет.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaseLibrary } from './CaseLibrary'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { ConsiliumCase, ConsiliumProposal } from '@/shared/api/types'

const testCase: ConsiliumCase = {
  id: 'case-a',
  title: 'Музыка',
  question: 'Что доброволец чувствовал?',
  version: 2,
  status: 'open',
  direction: 'music',
  subject_codes: ['V-1'],
  recording_ids: ['rec-a'],
  created_at: '2026-10-10T10:00:00',
  updated_at: '2026-10-10T10:00:00',
}

function makeProposal(changes: Partial<ConsiliumProposal> = {}): ConsiliumProposal {
  return {
    id: 'proposal-1',
    case_id: 'case-a',
    source: 'brainstorm',
    source_id: 'idea-1',
    version: 2,
    kind: 'run_probe',
    title: 'Повторная запись в тишине',
    hypothesis: 'фон сети вносит вклад',
    rationale: 'спектр смещён низкими частотами',
    risks: 'условия записи отличаются',
    check_method: 'доля α до и после',
    decisions: [
      {
        id: 'decision-1',
        proposal_id: 'proposal-1',
        decision: 'rejected',
        proposal_version: 1,
        comment: 'рано — сначала контекст',
        created_at: '2026-10-14T11:00:00',
      },
    ],
    executions: [
      {
        id: 'execution-1',
        proposal_id: 'proposal-1',
        note: 'записал пробу в тишине',
        result: 'доля α выросла на 8%',
        created_at: '2026-10-14T12:00:00',
      },
    ],
    created_at: '2026-10-14T10:00:00',
    updated_at: '2026-10-14T10:30:00',
    ...changes,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer(proposals: ConsiliumProposal[]) {
  const items = [...proposals]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/consilium/cases/case-a', '')
    const method = init?.method ?? 'GET'
    if (path === '/proposals' && method === 'GET')
      return response({ total: items.length, items })
    if (path === '/proposals' && method === 'POST') {
      const created = makeProposal({ id: `proposal-${items.length + 1}`, decisions: [], executions: [] })
      items.unshift(created)
      return response(created, 201)
    }
    if (path.endsWith('/decisions') && method === 'POST')
      return response({ id: 'decision-2', proposal_id: 'proposal-1' }, 201)
    if (path.endsWith('/executions') && method === 'POST')
      return response({ id: 'execution-2', proposal_id: 'proposal-1' }, 201)
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CaseLibrary', () => {
  it('показывает карточку: решение прошлой версии, исполнения и поля §7', async () => {
    mockServer([makeProposal()])
    renderWithProviders(<CaseLibrary current={testCase} />)

    const card = await screen.findByTestId('proposal-card')
    expect(card).toHaveTextContent('Повторная запись в тишине')
    expect(card).toHaveTextContent('Основание: спектр смещён низкими частотами')
    expect(card).toHaveTextContent('Проверка: доля α до и после')
    expect(card).toHaveTextContent('версия 2 · из мозгового штурма')
    expect(card).toHaveTextContent('отклонено')
    fireEvent.click(screen.getByText(/Решения \(1\)/))
    expect(await screen.findByText(/версия карточки 1/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Исполнения \(1\)/))
    expect(await screen.findByText(/доля α выросла на 8%/)).toBeInTheDocument()
  })

  it('решение и исполнение отправляются кнопками; история не правится', async () => {
    const fetchMock = mockServer([makeProposal()])
    renderWithProviders(<CaseLibrary current={testCase} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Принять' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/decisions'),
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const decision = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST')?.[1]?.body),
    )
    expect(decision.decision).toBe('accepted')
    expect(typeof decision.request_id).toBe('string')

    fireEvent.change(screen.getByLabelText('Что сделано вручную'), {
      target: { value: 'повторил пробу' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить исполнение' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/executions'),
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('новое предложение — формой с названием; архив скрывает действия', async () => {
    const fetchMock = mockServer([])
    renderWithProviders(<CaseLibrary current={testCase} />)

    fireEvent.click(screen.getByRole('button', { name: 'Новое предложение' }))
    const submit = screen.getByRole('button', { name: 'Добавить в библиотеку' })
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Название'), {
      target: { value: 'Вопрос добровольцу о сне' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'спросить добровольца' }))
    fireEvent.click(submit)
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/proposals'),
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const body = JSON.parse(
      String(fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST')?.[1]?.body),
    )
    expect(body.kind).toBe('ask_volunteer')
    expect(body.title).toBe('Вопрос добровольцу о сне')
  })

  it('архив: библиотека только для чтения, действия скрыты', async () => {
    mockServer([makeProposal()])
    renderWithProviders(<CaseLibrary current={{ ...testCase, status: 'archived' }} />)
    expect(await screen.findByText(/только для чтения/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Новое предложение' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Принять' })).not.toBeInTheDocument()
  })
})