/**
 * Обсуждение (Т3): запуск только кнопками, скелетоны ожидания, повтор и итог,
 * границы раундов и обязательные действия ответа.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaseDiscussion } from './CaseDiscussion'
import { renderWithProviders } from '@/test/renderWithProviders'
import type {
  ConsiliumAnswer,
  ConsiliumCase,
  ConsiliumRound,
  ConsiliumTriage,
} from '@/shared/api/types'

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

const snapshot = {
  id: 'snap-1',
  case_id: 'case-a',
  case_version: 2,
  created_at: '2026-10-10T11:00:00',
  question: 'Что доброволец чувствовал?',
  title: 'Дело',
  subject_codes: ['V-1'],
  recording_ids: ['rec-a'],
  evidence: [],
  context: [],
  sha256: 'a'.repeat(64),
  warnings: [],
}

const answerText =
  '## Замечено\nЗаметили изменение.\n## Возможные объяснения\nВариант один.\n' +
  '## Чего не знаем\nПробел данных.\n## Вопрос добровольцу\nКак себя чувствовали?\n' +
  '## Следующий шаг\nУточнить условия.'

function makeAnswer(roundId: string, role: string, changes: Partial<ConsiliumAnswer> = {}) {
  return {
    id: `ans-${role}`,
    case_id: 'case-a',
    round_id: roundId,
    role,
    status: 'ok',
    text: answerText,
    error: null,
    model: 'prov/model-x',
    instruction_version: '1',
    latency_ms: 500,
    created_at: '2026-10-10T12:00:00',
    ...changes,
  } as ConsiliumAnswer
}

function makeRound(changes: Partial<ConsiliumRound> = {}): ConsiliumRound {
  return {
    id: 'round-1',
    case_id: 'case-a',
    kind: 'initial',
    snapshot_id: 'snap-1',
    source_round_id: null,
    status: 'done',
    model: 'prov/model-x',
    instruction_versions: {
      psychological: '1',
      neurophysiological: '1',
      methodological: '1',
    },
    limits: {
      roles: ['psychological', 'neurophysiological', 'methodological'],
      max_tokens: 4096,
      timeout_s: 180,
    },
    warnings: [],
    error: null,
    job_id: 'job-1',
    created_at: '2026-10-10T12:00:00',
    finished_at: '2026-10-10T12:01:00',
    answers: [
      makeAnswer('round-1', 'psychological'),
      makeAnswer('round-1', 'neurophysiological'),
      makeAnswer('round-1', 'methodological'),
    ],
    ...changes,
  }
}

function makeTriage(changes: Partial<ConsiliumTriage> = {}): ConsiliumTriage {
  return {
    id: 'triage-1',
    case_id: 'case-a',
    snapshot_id: 'snap-1',
    status: 'ok',
    model: 'prov/jev-test',
    questions_version: '1',
    sufficient: true,
    sufficient_prob: 0.9,
    deficit: 'no_measurements',
    deficit_confidence: 0.75,
    completeness_score: 2.5,
    answers: {
      sufficient: { type: 'noul', noul: 0.9 },
    },
    warnings: [],
    error: null,
    latency_ms: 12,
    created_at: '2026-10-13T10:00:00',
    ...changes,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer(rounds: ConsiliumRound[], triage: ConsiliumTriage[] = []) {
  const triageItems = [...triage]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/consilium/cases/case-a', '')
    const method = init?.method ?? 'GET'
    if (path === '/snapshots') return response({ total: 1, items: [snapshot] })
    if (path === '/triage' && method === 'GET')
      return response({ total: triageItems.length, items: triageItems })
    if (path === '/triage' && method === 'POST') {
      const created = makeTriage({ id: `triage-${triageItems.length + 1}` })
      triageItems.unshift(created)
      return response(created, 201)
    }
    if (path === '/rounds' && method === 'GET')
      return response({ total: rounds.length, items: rounds })
    if (path === '/rounds' && method === 'POST')
      return response({ ...makeRound({ id: 'round-new', status: 'running', answers: [] }) }, 202)
    if (path.endsWith('/summary'))
      return response(
        makeRound({ id: 'round-sum', kind: 'summary', source_round_id: 'round-1' }),
        202,
      )
    if (path.endsWith('/retry'))
      return response(makeRound({ status: 'running' }), 202)
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CaseDiscussion', () => {
  it('показывает ответы советников и раскрытия без запуска модели', async () => {
    const fetchMock = mockServer([makeRound()])
    renderWithProviders(<CaseDiscussion current={testCase} />)

    expect(await screen.findByText('Раунд ответов')).toBeInTheDocument()
    expect(screen.getAllByText('Ответ получен')).toHaveLength(3)
    // «Замечено» видно сразу, остальные разделы — по действиям
    expect(screen.getAllByText('Заметили изменение.').length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('button', { name: /Какие есть другие объяснения/ })[0])
    expect(await screen.findByText('Вариант один.')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /На чём основано/ })[0])
    expect(await screen.findByText(/зафиксированные материалы/)).toBeInTheDocument()
    // Рендер и раскрытия не запускают модель — POST отсутствует
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('running-раунд показывает скелетоны ролей', async () => {
    mockServer([makeRound({ status: 'running', answers: [] })])
    renderWithProviders(<CaseDiscussion current={testCase} />)

    const skeletons = await screen.findAllByTestId('answer-skeleton')
    expect(skeletons).toHaveLength(3)
    expect(screen.getByText('Психологический советник — ожидание ответа…')).toBeInTheDocument()
  })

  it('повтор неудавшегося ответа — кнопка с ролью', async () => {
    const fetchMock = mockServer([
      makeRound({
        status: 'partial',
        answers: [
          makeAnswer('round-1', 'psychological'),
          makeAnswer('round-1', 'neurophysiological', {
            status: 'failed',
            text: null,
            error: 'Сеть недоступна',
          }),
          makeAnswer('round-1', 'methodological'),
        ],
      }),
    ])
    renderWithProviders(<CaseDiscussion current={testCase} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Повторить ответ' }))
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      const body = JSON.parse(String(posts[0][1]?.body))
      expect(body.role).toBe('neurophysiological')
    })
  })

  it('итог запускается кнопкой и один раз на снимок', async () => {
    const fetchMock = mockServer([makeRound()])
    const { unmount } = renderWithProviders(<CaseDiscussion current={testCase} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Составить итог' }))
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(String(posts[0][0])).toContain('/rounds/round-1/summary')
    })
    unmount()

    // Итог уже есть — кнопка исчезает
    mockServer([
      makeRound(),
      makeRound({ id: 'round-sum', kind: 'summary', source_round_id: 'round-1' }),
    ])
    renderWithProviders(<CaseDiscussion current={testCase} />)
    expect(await screen.findByText('Итог консилиума')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Составить итог' })).not.toBeInTheDocument()
  })

  it('границы: ответы один раз на снимок, замечания — к завершённому источнику', async () => {
    const fetchMock = mockServer([makeRound()])
    renderWithProviders(<CaseDiscussion current={testCase} />)

    await screen.findByText('Раунд ответов')
    expect(screen.getByRole('button', { name: 'Ответы советников' })).toBeDisabled()
    const remarks = screen.getByRole('button', { name: 'Замечания коллег' })
    expect(remarks).toBeEnabled()
    fireEvent.click(remarks)
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      const body = JSON.parse(String(posts[0][1]?.body))
      expect(body.kind).toBe('remarks')
      expect(body.source_round_id).toBe('round-1')
    })
  })

  it('триаж: кнопка запускает проверку и карточка показывает решения', async () => {
    const fetchMock = mockServer([makeRound()])
    renderWithProviders(<CaseDiscussion current={testCase} />)

    // До запуска — честное «не запускался», без фиктивных решений
    expect(await screen.findByText(/Триаж этого снимка ещё не запускался/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Проверить готовность досье' }))
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(String(posts[0][0])).toContain('/triage')
      const body = JSON.parse(String(posts[0][1]?.body))
      expect(body.snapshot_id).toBe('snap-1')
    })
    expect(await screen.findByText(/Материалов достаточно/)).toBeInTheDocument()
    expect(screen.getByText(/нет измерений и расчётов/)).toBeInTheDocument()
    expect(screen.getByText(/не гарантирует правильность/)).toBeInTheDocument()
  })

  it('триаж: ошибка классификатора показывается без достроенных решений', async () => {
    mockServer(
      [],
      [
        makeTriage({
          id: 'triage-2',
          status: 'failed',
          sufficient: null,
          sufficient_prob: null,
          deficit: null,
          deficit_confidence: null,
          completeness_score: null,
          answers: {},
          error: 'Сеть недоступна',
        }),
      ],
    )
    renderWithProviders(<CaseDiscussion current={testCase} />)

    expect(await screen.findByText(/Решения не получены: Сеть недоступна/)).toBeInTheDocument()
    expect(screen.queryByText(/Материалов достаточно/)).not.toBeInTheDocument()
  })
})