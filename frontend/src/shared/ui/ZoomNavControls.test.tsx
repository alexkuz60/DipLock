/**
 * Навигатор зума: режимы «окно» (листание) и «Навигация» (шаги по артефактам),
 * счётчик шага «3/47». Разметка общая для EDF и «ЭЭГ», состояние приходит пропсами.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/renderWithProviders'
import { ZoomNavControls } from './ZoomNavControls'

function renderNav(props: Partial<ComponentProps<typeof ZoomNavControls>> = {}) {
  const onNav = vi.fn()
  renderWithProviders(
    <ZoomNavControls
      timeLevel={2}
      onTimeLevel={() => {}}
      onNav={onNav}
      zoomLabel="Зум отрисовки ЭЭГ"
      zoomTitle="Масштаб по времени"
      {...props}
    />,
  )
  return { onNav }
}

describe('навигатор зума: режимы «окно»/«Навигация»', () => {
  it('режим «окно» (по умолчанию): привычные подписи, счётчика нет', () => {
    renderNav()

    expect(screen.getByRole('button', { name: 'Предыдущее окно' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Следующее окно' })).toBeEnabled()
    expect(screen.queryByTestId('artifact-nav-step')).not.toBeInTheDocument()
  })

  it('режим «Навигация»: подписи по артефактам и счётчик шага «3/47»', () => {
    renderNav({ navMode: 'artifact', step: { index: 2, total: 47 } })

    expect(screen.getByRole('button', { name: 'Предыдущий артефакт' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Следующий артефакт' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'К первому артефакту' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'К последнему артефакту' })).toBeInTheDocument()
    expect(screen.getByTestId('artifact-nav-step')).toHaveTextContent('3/47')
  })

  it('режим «Навигация» без видимых зон: кнопки выключены, счётчика нет', () => {
    renderNav({ navMode: 'artifact', step: { index: 0, total: 0 } })

    expect(screen.getByRole('button', { name: 'Следующий артефакт' })).toBeDisabled()
    expect(screen.queryByTestId('artifact-nav-step')).not.toBeInTheDocument()
  })

  it('кнопки шлют команду навигатора', async () => {
    const user = userEvent.setup()
    const { onNav } = renderNav({ navMode: 'artifact', step: { index: 0, total: 5 } })

    await user.click(screen.getByRole('button', { name: 'Следующий артефакт' }))
    expect(onNav).toHaveBeenCalledWith('next')
  })
})