/**
 * Тесты правого сайдбара: хедер с меню быстрого перемещения собирает секции
 * панели (`Panel` регистрирует себя), выбор пункта раскрывает секцию и прокручивает
 * к ней панель.
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RightPanel } from './RightPanel'
import { getSection } from '@/app/sections/registry'
import { useUiStore } from '@/shared/state/uiStore'
import { Panel } from '@/shared/ui/Panel'
import { PanelNavContext } from '@/shared/ui/panelNav'
import { renderWithProviders } from '@/test/renderWithProviders'

const SECTION = getSection('edf')

function renderPanel() {
  return renderWithProviders(
    <RightPanel section={SECTION}>
      <Panel title="Фильтры и референс">
        <span>фильтры</span>
      </Panel>
      <Panel title="Пороги артефактов">
        <span>пороги</span>
      </Panel>
      <Panel title="Эпохи" defaultOpen={false}>
        <span>эпохи</span>
      </Panel>
    </RightPanel>,
  )
}

describe('правый сайдбар: меню быстрого перемещения', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.getState().resetUiState()
    vi.restoreAllMocks()
  })

  it('показывает в хедере секции панели в порядке их следования', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'Меню быстрого перемещения по секциям' }))

    const menu = screen.getByRole('menu', { name: 'Секции панели опций' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Фильтры и референс',
      'Пороги артефактов',
      'Эпохи',
    ])
  })

  it('выбор секции раскрывает её и прокручивает к ней панель', async () => {
    const user = userEvent.setup()
    const scrollSpy = vi.fn()
    // jsdom не реализует scrollIntoView — как в LocalizationTable, компонент
    // вызывает его только когда он есть; здесь подменяем на шпиона
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView
    renderPanel()

    // «Эпохи» свёрнута по умолчанию (defaultOpen=false)
    expect(
      useUiStore.getState().collapsedPanels['edf:Эпохи'] ?? true,
    ).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Меню быстрого перемещения по секциям' }))
    await user.click(
      within(screen.getByRole('menu', { name: 'Секции панели опций' })).getByRole('menuitem', {
        name: 'Эпохи',
      }),
    )

    // Секция раскрыта (свёрнутость снята) и к ней прокрутили панель
    expect(useUiStore.getState().collapsedPanels['edf:Эпохи']).toBe(false)
    expect(screen.getByRole('button', { name: 'Эпохи' })).toHaveAttribute('aria-expanded', 'true')
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'start' })
    // Меню закрылось после выбора
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('раскрытая секция остаётся раскрытой, прокрутка всё равно срабатывает', async () => {
    const user = userEvent.setup()
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'Меню быстрого перемещения по секциям' }))
    await user.click(
      within(screen.getByRole('menu', { name: 'Секции панели опций' })).getByRole('menuitem', {
        name: 'Пороги артефактов',
      }),
    )

    expect(screen.getByRole('button', { name: 'Пороги артефактов' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('секция вне панели опций не регистрируется в реестре меню (scope пуст)', () => {
    const register = vi.fn(() => () => {})
    renderWithProviders(
      <PanelNavContext.Provider value={{ register }}>
        <Panel title="Настройки рабочей области">
          <span>вне панели</span>
        </Panel>
      </PanelNavContext.Provider>,
    )

    // У PanelScopeContext нет провайдера — секция рисуется как обычно и в меню не попадает
    expect(register).not.toHaveBeenCalled()
    expect(screen.getByText('Настройки рабочей области')).toBeInTheDocument()
  })
})