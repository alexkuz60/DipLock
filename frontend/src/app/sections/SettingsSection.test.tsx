/** Тесты раздела «Настройки»: масштаб текста, плотность, параметры расчёта. */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { SettingsSection } from './SettingsSection'
import { useUiStore } from '@/shared/state/uiStore'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('раздел «Настройки»', () => {
  beforeEach(() => {
    mockApiFetch()
    useUiStore.getState().resetUiState()
  })

  it('меняет масштаб текста и запоминает выбор', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsSection />)

    await user.click(screen.getByRole('button', { name: 'Очень крупный' }))

    expect(useUiStore.getState().fontScale).toBe('xlarge')
    expect(document.documentElement.dataset.fontScale).toBe('xlarge')
    expect(localStorage.getItem('diplock.ui')).toContain('xlarge')
  })

  it('переключает плотность списков', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsSection />)

    await user.click(screen.getByRole('button', { name: 'Плотная' }))

    expect(useUiStore.getState().density).toBe('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
  })

  it('сбрасывает раскладку разделов', async () => {
    const user = userEvent.setup()
    useUiStore.getState().setRightPanel('edf', false)
    renderWithProviders(<SettingsSection />)

    await user.click(screen.getByRole('button', { name: 'Сбросить раскладку разделов' }))

    expect(useUiStore.getState().rightPanelOpen.edf).toBe(true)
  })

  it('показывает параметры расчёта только для чтения', async () => {
    renderWithProviders(<SettingsSection />)

    expect(await screen.findByText('Диапазоны, Гц')).toBeInTheDocument()
    expect(screen.getByText(/"alpha":\[8,13\]/)).toBeInTheDocument()
    expect(screen.getByText(/backend\/\.env/)).toBeInTheDocument()
  })
})
