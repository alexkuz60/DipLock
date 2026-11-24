/** Панель опций «Консилиума»: в чате — советники, в «Знаниях» — отсылка к ним. */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsiliumPanel } from './ConsiliumPanel'
import { llmRouterFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace('/api/v1', '')
      if (path === '/agent-chat/roles') return response({ items: [] })
      if (path === '/llm-router') return response(llmRouterFixture())
      return response({ detail: 'нет' }, 404)
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('панель опций «Консилиума»', () => {
  it('в чате показывает настройки советников', async () => {
    mockServer()
    renderWithProviders(<ConsiliumPanel />, { route: '/consilium' })
    expect(await screen.findByText('Эксперты')).toBeInTheDocument()
    expect(screen.getByText('Новый советник')).toBeInTheDocument()
  })

  it('в «Знаниях» отсылает к настройкам советников', async () => {
    mockServer()
    renderWithProviders(<ConsiliumPanel />, { route: '/consilium?view=knowledge' })
    expect(await screen.findByText('Настройки советников')).toBeInTheDocument()
    expect(screen.queryByText('Эксперты')).not.toBeInTheDocument()
  })
})
