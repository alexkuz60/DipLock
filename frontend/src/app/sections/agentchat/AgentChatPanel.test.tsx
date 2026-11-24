/**
 * Панель «Опции» чата консилиума: роли советников — провайдер/модель, уровень
 * размышления, навыки специалиста и добавление нового советника.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChatPanel } from './AgentChatPanel'
import { llmRouterFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

const role = {
  id: 'psychologist',
  label: 'Психолог',
  instruction: 'Спрашивай бережно.',
  provider_id: null,
  model: null,
  reasoning: 'medium' as const,
  skills: ['ненаводящие вопросы'],
  enabled: true,
  builtin: true,
  sort: 0,
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1', '')
    const method = init?.method ?? 'GET'
    if (path === '/agent-chat/roles' && method === 'GET') return response({ items: [role] })
    if (path === '/agent-chat/roles' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return response({ ...role, id: 'custom-1', builtin: false, ...body }, 201)
    }
    if (path.startsWith('/agent-chat/roles/') && method === 'PUT') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return response({ ...role, ...body })
    }
    if (path === '/llm-router') return response(llmRouterFixture())
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bodies(fetchMock: ReturnType<typeof mockServer>, method: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes('/agent-chat/roles') && init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body)))
}

/** Панель по заголовку: подписи полей повторяются в редакторе роли и в «Новом советнике». */
function panel(title: string): HTMLElement {
  return screen.getByText(title).closest('section') as HTMLElement
}

afterEach(() => vi.unstubAllGlobals())

describe('панель советников чата консилиума', () => {
  it('показывает роль с уровнем размышления и навыками', async () => {
    mockServer()
    renderWithProviders(<AgentChatPanel />)

    expect(await screen.findByText('Психолог')).toBeInTheDocument()
    const experts = within(panel('Эксперты'))
    expect(experts.getByLabelText('Уровень размышления')).toHaveValue('medium')
    expect(experts.getByLabelText('Навыки специалиста (через запятую)')).toHaveValue(
      'ненаводящие вопросы',
    )
    expect(experts.getByLabelText('Провайдер')).toHaveValue('')
  })

  it('сохраняет роль только кнопкой и отправляет размышление с навыками', async () => {
    const user = userEvent.setup()
    const fetchMock = mockServer()
    renderWithProviders(<AgentChatPanel />)

    const experts = within(panel('Эксперты'))
    await screen.findByText('Психолог')
    await user.selectOptions(experts.getByLabelText('Уровень размышления'), 'high')
    const skills = experts.getByLabelText('Навыки специалиста (через запятую)')
    await user.clear(skills)
    await user.type(skills, 'статистика, ЭЭГ-артефакты')
    expect(bodies(fetchMock, 'PUT')).toHaveLength(0)

    fireEvent.click(experts.getByRole('button', { name: 'Сохранить роль' }))
    await waitFor(() => expect(bodies(fetchMock, 'PUT')).toHaveLength(1))
    expect(bodies(fetchMock, 'PUT')[0]).toMatchObject({
      reasoning: 'high',
      skills: ['статистика', 'ЭЭГ-артефакты'],
    })
  })

  it('добавляет нового советника с провайдером, моделью и навыками', async () => {
    const user = userEvent.setup()
    const fetchMock = mockServer()
    renderWithProviders(<AgentChatPanel />)

    await screen.findByText('Психолог')
    const fresh = within(panel('Новый советник'))
    await user.type(fresh.getByLabelText('Название'), 'Скептик')
    await user.type(fresh.getByLabelText('Инструкция'), 'Ищи слабые места.')
    await user.selectOptions(fresh.getByLabelText('Провайдер'), 'prov-full')
    await user.selectOptions(fresh.getByLabelText('Уровень размышления'), 'low')
    await user.type(fresh.getByLabelText('Навыки специалиста (через запятую)'), 'методология')
    fireEvent.click(fresh.getByRole('button', { name: 'Добавить советника' }))

    await waitFor(() => expect(bodies(fetchMock, 'POST')).toHaveLength(1))
    expect(bodies(fetchMock, 'POST')[0]).toMatchObject({
      label: 'Скептик',
      instruction: 'Ищи слабые места.',
      provider_id: 'prov-full',
      model: 'big-model-1',
      reasoning: 'low',
      skills: ['методология'],
    })
  })
})
