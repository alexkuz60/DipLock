/** Точка входа приложения: провайдеры, маршруты разделов, тултипы. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { SECTION_ROUTES } from '@/app/sections/registry'
import { SectionRoute } from '@/app/sections/routes'
import { TooltipProvider } from '@/shared/ui/Tooltip'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Фоновое обновление в скрытой вкладке не нужно: поллинг только на экране
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* basename соответствует base '/ui/' в vite.config.ts (dev и prod) */}
        <BrowserRouter basename="/ui">
          <Routes>
            {SECTION_ROUTES.map(({ path, id }) => (
              <Route key={path} path={path} element={<SectionRoute id={id} />} />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
