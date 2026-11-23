/** Раздел «Консилиум» после удаления режима «Исследование»: две вкладки. */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsiliumSection } from './ConsiliumSection'
import { renderWithProviders } from '@/test/renderWithProviders'

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/agent-chat', '')
    if (path === '/roles') return response({ items: [] })
    if (path === '/threads') return response({ items: [] })
    return response({ detail: 'нет' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('Консилиум: чат экспертов и знания', () => {
  it('по умолчанию открывает чат экспертов и не показывает вкладку исследования', async () => {
    mockServer()
    renderWithProviders(<ConsiliumSection />, { route: '/consilium' })
    await screen.findByText(/Создайте обсуждение/)
    expect(screen.queryByRole('button', { name: 'Исследование' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Чат экспертов' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('переключается на знания и обратно', async () => {
    mockServer()
    renderWithProviders(<ConsiliumSection />, { route: '/consilium' })
    await screen.findByText(/Создайте обсуждение/)
    fireEvent.click(screen.getByRole('button', { name: 'Знания' }))
    await screen.findByRole('button', { name: 'Источники' })
    fireEvent.click(screen.getByRole('button', { name: 'Чат экспертов' }))
    await screen.findByText(/Создайте обсуждение/)
  })

  it('старая ссылка с view=research открывает чат, а не удалённый режим', async () => {
    mockServer()
    renderWithProviders(<ConsiliumSection />, { route: '/consilium?view=research' })
    await screen.findByText(/Создайте обсуждение/)
    expect(screen.queryByRole('button', { name: 'Исследование' })).not.toBeInTheDocument()
  })
})
