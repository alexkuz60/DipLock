/**
 * Страховка рендера (ручная проверка, 23.09.2026): исключение в компоненте
 * показывается блоком ошибки с кнопкой «Перезагрузить», а не белым экраном.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/renderWithProviders'
import { ErrorBoundary } from './ErrorBoundary'

/** Компонент-нарушитель: падает при рендере. */
function Boom(): never {
  throw new Error('сбой в треках')
}

describe('ErrorBoundary', () => {
  it('дети без ошибок рендерятся как есть', () => {
    renderWithProviders(
      <ErrorBoundary>
        <p>треки на месте</p>
      </ErrorBoundary>,
    )

    expect(screen.getByText('треки на месте')).toBeInTheDocument()
  })

  it('исключение рендера даёт блок ошибки с перезагрузкой, а не пустой экран', async () => {
    // React печатает ошибку сам — глушим, чтобы не засорять вывод тестов
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()

    renderWithProviders(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Ошибка отрисовки приложения')).toBeInTheDocument()
    expect(screen.getByText(/сбой в треках/)).toBeInTheDocument()
    // Кнопка перезагрузки на месте (сам reload в jsdom — «not implemented»)
    await user.click(screen.getByRole('button', { name: /Перезагрузить/ }))

    consoleSpy.mockRestore()
  })

  it('свой заголовок блока — для разных оболочек рендера', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    renderWithProviders(
      <ErrorBoundary title="Ошибка вьюера">
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Ошибка вьюера')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })
})