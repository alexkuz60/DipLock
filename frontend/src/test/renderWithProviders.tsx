/**
 * Рендер компонента с провайдерами (react-query, тултипы, роутер) для тестов.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/shared/ui/Tooltip'

export type RenderOptions = {
  route?: string
}

export function renderWithProviders(ui: ReactNode, options: RenderOptions = {}): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[options.route ?? '/']}>{ui}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  )
}
