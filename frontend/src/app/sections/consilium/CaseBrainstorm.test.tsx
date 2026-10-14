/**
 * Мозговой штурм (срез 0012): запуск только кнопкой, резюме по кнопке в досье,
 * карточки идей §7 и внесение идеи в библиотеку; нераспознанное — предупреждение.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaseBrainstorm } from './CaseBrainstorm'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { ConsiliumBrainstorm, ConsiliumCase } from '@/shared/api/types'

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

function makeRun(changes: Partial<ConsiliumBrainstorm> = {}): ConsiliumBrainstorm {
  return {
    id: 'run-1',
    case_id: 'case-a',
    snapshot_id: 'snap-1',
    status: 'done',
    model: 'prov/model-x',
    instruction_version: '1',
    summary: 'Материалы фрагментарны: видна доля α.',
    draft: '## Резюме\nМатериалы фрагментарны: видна доля α.',
    ideas: [
      {
        id: 'idea-1',
        brainstorm_id: 'run-1',
        ordinal: 1,
        kind: 'run_probe',
        title: 'Повторная запись в тишине',
        hypothesis: 'фон сети вносит вклад',
        rationale: 'спектр смещён низкими частотами',
        risks: 'условия записи отличаются',
        check_method: 'доля α до и после',
      },
    ],
    warnings: [],
    error: null,
    job_id: 'job-1',
    created_at: '2026-10-14T10:00:00',
    finished_at: '2026-10-14T10:00:05',
    ...changes,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer(runs: ConsiliumBrainstorm[], options: { snapshots?: number } = {}) {
  const items = [...runs]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/consilium/cases/case-a', '')
    const method = init?.method ?? 'GET'
    if (path === '/brainstorms' && method === 'GET')
      return response({ total: items.length, items })
    if (path === '/snapshots' && method === 'GET') {
      const count = options.snapshots ?? 1
      return response({
        total: count,
        items: Array.from({ length: count }, (_, index) => ({
          id: `snap-${index + 1}`,
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
        })),
      })
    }
    if (path === '/brainstorms' && method === 'POST') {
      const created = makeRun({ id: `run-${items.length + 1}`, status: 'done' })
      items.unshift(created)
      return response(created, 202)
    }
    if (path === '/proposals' && method === 'POST') return response({ id: 'proposal-1' }, 201)
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CaseBrainstorm', () => {
  it('запускает штурм только кнопкой и показывает резюме и идеи', async () => {
    const fetchMock = mockServer([])
    renderWithProviders(<CaseBrainstorm current={testCase} />)

    expect(await screen.findByText(/Штурм ещё не запускался/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/brainstorms'),
      expect.objectContaining({ method: 'POST' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Запустить мозговой штурм' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/brainstorms'),
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    // POST уходит с последним снимком и ключом повтора
    const call = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST')
    const body = JSON.parse(String(call?.[1]?.body ?? '{}'))
    expect(body.snapshot_id).toBe('snap-1')
    expect(typeof body.request_id).toBe('string')
    expect(body.expected_version).toBe(2)

    expect(await screen.findByTestId('brainstorm-card')).toBeInTheDocument()
    expect(screen.getByTestId('brainstorm-summary')).toHaveTextContent('Материалы фрагментарны')
    expect(screen.getByTestId('brainstorm-idea')).toHaveTextContent('Повторная запись в тишине')
    expect(screen.getByTestId('brainstorm-idea')).toHaveTextContent('Проверка: доля α до и после')
  })

  it('вносит идею в библиотеку с источником «brainstorm»', async () => {
    const fetchMock = mockServer([makeRun()])
    renderWithProviders(<CaseBrainstorm current={testCase} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Внести в библиотеку' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/proposals'),
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    const call = fetchMock.mock.calls.find(([, init]) => (init?.method ?? 'GET') === 'POST')
    const body = JSON.parse(String(call?.[1]?.body ?? '{}'))
    expect(body.source).toBe('brainstorm')
    expect(body.source_id).toBe('idea-1')
    expect(body.title).toBe('Повторная запись в тишине')
    expect(await screen.findByText(/Идея внесена в библиотеку/)).toBeInTheDocument()
  })

  it('без снимка кнопка выключена; предупреждения показываются честно', async () => {
    mockServer(
      [
        makeRun({
          summary: null,
          ideas: [],
          warnings: ['Раздел «Идеи» не распознан — карточки идей не созданы'],
        }),
      ],
      { snapshots: 0 },
    )
    renderWithProviders(<CaseBrainstorm current={testCase} />)

    expect(await screen.findByRole('button', { name: 'Запустить мозговой штурм' })).toBeDisabled()
    expect(await screen.findByText(/не распознан — карточки идей/)).toBeInTheDocument()
    expect(screen.queryByTestId('brainstorm-summary')).not.toBeInTheDocument()
  })
})