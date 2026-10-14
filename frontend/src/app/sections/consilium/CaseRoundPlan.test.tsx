/**
 * «Быстрый раунд» (Jev, §5.3): подсказка ролей и глубины, запуск кнопкой,
 * предзаполнение чекбоксов, честная оговорка «не вердикт».
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaseRoundPlan } from './CaseRoundPlan'
import { recommendedRoles } from './jevRoles'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { ConsiliumCase, ConsiliumJevMark } from '@/shared/api/types'

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

function makeMark(changes: Partial<ConsiliumJevMark> = {}): ConsiliumJevMark {
  return {
    id: 'mark-1',
    case_id: 'case-a',
    kind: 'round_plan',
    subject_type: 'snapshot',
    subject_id: 'snap-1',
    status: 'ok',
    model: 'prov/jev-test',
    questions_version: '1',
    probs: {
      role_psychological: 0.9,
      role_neurophysiological: 0.2,
      role_methodological: 0.7,
    },
    present: ['role_psychological', 'role_methodological'],
    choice: 'with_remarks',
    choice_confidence: 0.8,
    answers: {},
    warnings: [],
    error: null,
    latency_ms: 12,
    created_at: '2026-10-14T10:00:00',
    ...changes,
  }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer(marks: ConsiliumJevMark[]) {
  const items = [...marks]
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/consilium/cases/case-a', '')
    const method = init?.method ?? 'GET'
    if (path === '/jev-marks' && method === 'GET')
      return response({ total: items.length, items })
    if (path === '/jev-marks/round-plan' && method === 'POST') {
      const created = makeMark({ id: `mark-${items.length + 1}` })
      items.unshift(created)
      return response(created, 201)
    }
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CaseRoundPlan', () => {
  it('показывает подсказку ролей и глубины с оговоркой «не вердикт»', async () => {
    mockServer([makeMark()])
    const applied = vi.fn()
    renderWithProviders(
      <CaseRoundPlan current={testCase} snapshotId="snap-1" onApply={applied} />,
    )

    expect(await screen.findByTestId('round-plan-card')).toBeInTheDocument()
    expect(screen.getByText(/Психологический советник, Методологический советник/)).toBeInTheDocument()
    expect(screen.getByText(/ответы и замечания коллег/)).toBeInTheDocument()
    expect(screen.getByText(/не вердикт/)).toBeInTheDocument()
    expect(screen.getByText(/нейрофизиологический/i)).toBeInTheDocument() // 0.2 в списке вероятностей
  })

  it('запускает подбор только кнопкой и применяет роли к чекбоксам', async () => {
    const fetchMock = mockServer([])
    const applied = vi.fn()
    renderWithProviders(
      <CaseRoundPlan current={testCase} snapshotId="snap-1" onApply={applied} />,
    )

    expect(await screen.findByText(/ещё не запрашивалась/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Подобрать состав раунда' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const card = await screen.findByTestId('round-plan-card')
    expect(card).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Применить к выбору ролей' }))
    expect(applied).toHaveBeenCalledWith(['psychological', 'methodological'])
  })

  it('без снимка кнопка выключена; рекомендация ролей учитывает только present', () => {
    mockServer([])
    renderWithProviders(<CaseRoundPlan current={testCase} snapshotId="" />)
    expect(screen.getByRole('button', { name: 'Подобрать состав раунда' })).toBeDisabled()
    expect(recommendedRoles(makeMark())).toEqual(['psychological', 'methodological'])
  })
})