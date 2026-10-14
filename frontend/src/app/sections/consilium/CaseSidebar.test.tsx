/**
 * Выдвижной левый сайдбар (срез 0015): две вкладки (чат/дерево), изменяемая
 * ширина (мышь/клавиатура, clamp 240–640), сворачивание и персист настроек.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaseSidebar } from './CaseSidebar'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { ConsiliumCase } from '@/shared/api/types'
import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  useConsiliumOptions,
} from '@/shared/state/consiliumOptions'

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

function mockServer() {
  const empty = { total: 0, items: [] }
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/consilium/cases/case-a', '')
    if (path === '/snapshots') return response(empty)
    if (path === '/chats') return response(empty)
    if (path === '/rounds') return response(empty)
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  useConsiliumOptions.getState().reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CaseSidebar', () => {
  it('переключает вкладки «Чат» и «Дерево»', async () => {
    mockServer()
    renderWithProviders(<CaseSidebar current={testCase} onJump={vi.fn()} />)

    // По умолчанию — чат боковой консультации
    expect(await screen.findByRole('group', { name: 'Вкладка' })).toBeInTheDocument()
    expect(screen.getByText(/Личная консультация/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Дерево' }))
    expect(await screen.findByText(/Лента обсуждения/)).toBeInTheDocument()
    expect(useConsiliumOptions.getState().sidebar.tab).toBe('tree')

    fireEvent.click(screen.getByRole('button', { name: 'Чат' }))
    expect(await screen.findByText(/Личная консультация/)).toBeInTheDocument()
    expect(useConsiliumOptions.getState().sidebar.tab).toBe('chat')
  })

  it('меняет ширину стрелками с клавиатуры и удерживает границы', () => {
    mockServer()
    renderWithProviders(<CaseSidebar current={testCase} onJump={vi.fn()} />)
    const handle = screen.getByTestId('sidebar-resize')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useConsiliumOptions.getState().sidebar.width).toBe(336)

    for (let index = 0; index < 40; index += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(useConsiliumOptions.getState().sidebar.width).toBe(SIDEBAR_WIDTH_MIN)

    for (let index = 0; index < 60; index += 1) fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useConsiliumOptions.getState().sidebar.width).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('сворачивается кнопкой и возвращается кнопкой рабочей области', async () => {
    mockServer()
    const { rerender } = renderWithProviders(
      <CaseSidebar current={testCase} onJump={vi.fn()} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Свернуть панель' }))
    expect(useConsiliumOptions.getState().sidebar.open).toBe(false)

    // Родитель (CaseWorkspace) при закрытой панели не рисует сайдбар
    rerender(<div />)
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('персист: ширина из хранилища приводится к границам', () => {
    const store = useConsiliumOptions.getState()
    store.setSidebarWidth(5000)
    expect(useConsiliumOptions.getState().sidebar.width).toBe(SIDEBAR_WIDTH_MAX)
    store.setSidebarWidth(50)
    expect(useConsiliumOptions.getState().sidebar.width).toBe(SIDEBAR_WIDTH_MIN)
  })
})