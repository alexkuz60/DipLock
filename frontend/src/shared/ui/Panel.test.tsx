/**
 * Тесты секции правой панели: внутри панели опций (`PanelScopeContext`) секция —
 * аккордеон с запоминанием свёрнутости по разделу; вне панели — обычная секция.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { Panel } from './Panel'
import { PanelScopeContext } from './panelScope'
import { useUiStore } from '@/shared/state/uiStore'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Панель внутри области раздела: так `Panel` видит `RightPanel`. */
function scoped(sectionId: string, ui: ReactElement): ReactElement {
  return <PanelScopeContext.Provider value={sectionId}>{ui}</PanelScopeContext.Provider>
}

describe('Panel (секция правой панели)', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.getState().resetUiState()
  })

  it('сворачивается по клику и помнит это после перезахода в раздел', async () => {
    const user = userEvent.setup()
    const body = (
      <Panel title="Пороги артефактов">
        <span>z-score</span>
      </Panel>
    )
    const first = renderWithProviders(scoped('edf', body))

    const toggle = screen.getByRole('button', { name: 'Пороги артефактов' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(toggle)

    expect(screen.getByRole('button', { name: 'Пороги артефактов' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(useUiStore.getState().collapsedPanels['edf:Пороги артефактов']).toBe(true)
    // Содержимое не размонтируется: контролы остаются в DOM и хранят своё состояние
    expect(screen.getByText('z-score')).toBeInTheDocument()

    // Перезаход в раздел (перемонтирование) свёрнутость сохраняет
    first.unmount()
    renderWithProviders(scoped('edf', body))
    expect(screen.getByRole('button', { name: 'Пороги артефактов' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('держит свёрнутость отдельно для каждого раздела', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <>
        {scoped(
          'edf',
          <Panel title="Каналы">
            <span>каналы EDF</span>
          </Panel>,
        )}
        {scoped(
          'eeg',
          <Panel title="Каналы">
            <span>каналы ЭЭГ</span>
          </Panel>,
        )}
      </>,
    )

    await user.click(screen.getAllByRole('button', { name: 'Каналы' })[0])

    const buttons = screen.getAllByRole('button', { name: 'Каналы' })
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'true')
    expect(useUiStore.getState().collapsedPanels).toEqual({ 'edf:Каналы': true })
  })

  it('вне панели опций остаётся прежней секцией — без кнопки', () => {
    renderWithProviders(
      <Panel title="Состояние сервера">
        <span>контент рабочей области</span>
      </Panel>,
    )

    expect(screen.queryByRole('button', { name: 'Состояние сервера' })).toBeNull()
    expect(screen.getByText('Состояние сервера')).toBeInTheDocument()
    expect(screen.getByText('контент рабочей области')).toBeInTheDocument()
  })

  it('слушает defaultOpen и collapsible=false', () => {
    renderWithProviders(
      <>
        {scoped(
          'edf',
          <Panel title="Свёрнутая" defaultOpen={false}>
            <span>внутри свёрнутой</span>
          </Panel>,
        )}
        {scoped(
          'edf',
          <Panel title="Без аккордеона" collapsible={false}>
            <span>видно всегда</span>
          </Panel>,
        )}
      </>,
    )

    expect(screen.getByRole('button', { name: 'Свёрнутая' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'Без аккордеона' })).toBeNull()
    expect(screen.getByText('видно всегда')).toBeInTheDocument()
  })
})
