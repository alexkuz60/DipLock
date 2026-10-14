/** Дерево навигации (срез 0015): узлы ленты раундов и переходы к карточкам. */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundsTree } from './RoundsTree'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { ConsiliumRound } from '@/shared/api/types'

function makeRound(changes: Partial<ConsiliumRound> = {}): ConsiliumRound {
  return {
    id: 'round-1',
    case_id: 'case-a',
    kind: 'initial',
    snapshot_id: 'snap-1',
    source_round_id: null,
    status: 'done',
    model: 'prov/model-x',
    instruction_versions: { psychological: '1' },
    limits: { roles: ['psychological', 'neurophysiological'] },
    warnings: [],
    error: null,
    job_id: 'job-1',
    created_at: '2026-10-14T10:00:00',
    finished_at: '2026-10-14T10:00:05',
    answers: [
      {
        id: 'answer-1',
        case_id: 'case-a',
        round_id: 'round-1',
        role: 'psychological',
        status: 'ok',
        text: '## Замечено\nВсё спокойно.',
        error: null,
        model: 'prov/model-x',
        instruction_version: '1',
        latency_ms: 5,
        created_at: '2026-10-14T10:00:05',
      },
    ],
    ...changes,
  }
}

function mockRounds(items: ConsiliumRound[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/rounds')) {
      return new Response(JSON.stringify({ total: items.length, items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ detail: 'нет' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RoundsTree', () => {
  it('строит дерево раундов и шлёт переход к карточке', async () => {
    mockRounds([makeRound()])
    const onJump = vi.fn()
    renderWithProviders(<RoundsTree caseId="case-a" onJump={onJump} />)

    expect(await screen.findByRole('button', { name: /Раунд ответов · Готов/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Раунд ответов/ }))
    expect(onJump).toHaveBeenLastCalledWith('round-round-1')

    // Ответ советника есть — переход к его карточке
    fireEvent.click(screen.getByRole('button', { name: /Психологический советник/ }))
    expect(onJump).toHaveBeenLastCalledWith('answer-answer-1')

    // Ответа ещё нет — честное «ожидание» и переход к карточке раунда
    fireEvent.click(screen.getByRole('button', { name: /Нейрофизиологический советник/ }))
    expect(onJump).toHaveBeenLastCalledWith('round-round-1')
    expect(screen.getByText(/Нейрофизиологический советник · ожидание/)).toBeInTheDocument()
  })

  it('пустая лента показывает честную подсказку', async () => {
    mockRounds([])
    renderWithProviders(<RoundsTree caseId="case-a" onJump={vi.fn()} />)
    expect(await screen.findByText(/Обсуждение ещё не запускалось/)).toBeInTheDocument()
  })
})