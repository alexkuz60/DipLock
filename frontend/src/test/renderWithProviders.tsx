/**
 * Рендер компонента с провайдерами (react-query, тултипы, роутер) для тестов.
 * Провайдеры идут через `wrapper` RTL: `rerender` перерисовывает дерево внутри
 * тех же провайдеров (иначе повторный рендер терял QueryClient).
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

  function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[options.route ?? '/']}>{children}</MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    )
  }

  return render(ui, { wrapper: Providers })
}
