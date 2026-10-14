/**
 * Разметка ответа (Jev, §5.3): карточка предложения и источники утверждений,
 * запуск кнопками, серверный вердикт порога, честная оговорка.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerJevMarks } from './AnswerJevMarks'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { ConsiliumAnswer, ConsiliumCase, ConsiliumJevMark } from '@/shared/api/types'

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

const answer: ConsiliumAnswer = {
  id: 'ans-1',
  case_id: 'case-a',
  round_id: 'round-1',
  role: 'psychological',
  status: 'ok',
  text: '## Замечено\nЗаметили изменение.',
  error: null,
  model: 'prov/model-x',
  instruction_version: '1',
  latency_ms: 500,
  created_at: '2026-10-10T12:00:00',
}

function makeMark(kind: 'proposal' | 'source_marks', changes: Partial<ConsiliumJevMark> = {}) {
  const base: ConsiliumJevMark =
    kind === 'proposal'
      ? {
          id: 'mark-p',
          case_id: 'case-a',
          kind: 'proposal',
          subject_type: 'answer',
          subject_id: 'ans-1',
          status: 'ok',
          model: 'prov/jev-test',
          questions_version: '1',
          probs: { has_proposal: 0.9, has_basis: 0.7, has_risks: 0.3, has_verification: 0.6 },
          present: ['has_proposal', 'has_basis', 'has_verification'],
          choice: 'run_probe',
          choice_confidence: 0.8,
          answers: {},
          warnings: [],
          error: null,
          latency_ms: 12,
          created_at: '2026-10-14T10:00:00',
        }
      : {
          id: 'mark-s',
          case_id: 'case-a',
          kind: 'source_marks',
          subject_type: 'answer',
          subject_id: 'ans-1',
          status: 'ok',
          model: 'prov/jev-test',
          questions_version: '1',
          probs: {
            uses_measurements: 0.8,
            uses_volunteer_report: 0.4,
            uses_observations: 0.6,
          },
          present: ['uses_measurements', 'uses_observations'],
          choice: null,
          choice_confidence: null,
          answers: {},
          warnings: [],
          error: null,
          latency_ms: 12,
          created_at: '2026-10-14T10:01:00',
        }
  return { ...base, ...changes }
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
    if (path === '/jev-marks/proposal' && method === 'POST') {
      const created = makeMark('proposal')
      items.unshift(created)
      return response(created, 201)
    }
    if (path === '/jev-marks/source-marks' && method === 'POST') {
      const created = makeMark('source_marks')
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

describe('AnswerJevMarks', () => {
  it('показывает карточку предложения: вид шага §7 и поля с серверным вердиктом', async () => {
    mockServer([makeMark('proposal')])
    renderWithProviders(<AnswerJevMarks current={testCase} answer={answer} />)

    expect(await screen.findByTestId('jev-mark-proposal')).toBeInTheDocument()
    expect(screen.getByText(/провести пробу/)).toBeInTheDocument()
    // ✓ только у меток present (has_risks 0.3 — прочерк, порог сервера)
    expect(screen.getByText(/риски и ограничения: — \(30%\)/)).toBeInTheDocument()
    expect(screen.getByText(/основание: ✓ \(70%\)/)).toBeInTheDocument()
    expect(screen.getByText(/не вердикт и не оценка ответа/)).toBeInTheDocument()
  })

  it('источники утверждений не смешиваются и запускаются кнопкой', async () => {
    const fetchMock = mockServer([])
    renderWithProviders(<AnswerJevMarks current={testCase} answer={answer} />)

    fireEvent.click(screen.getByRole('button', { name: 'Источники утверждений' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(await screen.findByTestId('jev-mark-source_marks')).toBeInTheDocument()
    expect(screen.getByText(/Три источника не смешиваются/)).toBeInTheDocument()
    expect(screen.getByText(/измерения и расчёты: ✓ \(80%\)/)).toBeInTheDocument()
    expect(screen.getByText(/рассказ добровольца: — \(40%\)/)).toBeInTheDocument()
  })

  it('у неудачного ответа кнопки разметки выключены', () => {
    mockServer([])
    renderWithProviders(
      <AnswerJevMarks
        current={testCase}
        answer={{ ...answer, status: 'failed', text: null }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Карточка предложения' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Источники утверждений' })).toBeDisabled()
  })
})