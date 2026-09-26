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

describe('хедер панели: триггер «все секции»', () => {
  const TITLES = ['Фильтры и референс', 'Пороги артефактов', 'Эпохи'] as const

  beforeEach(() => {
    localStorage.clear()
    useUiStore.getState().resetUiState()
    vi.restoreAllMocks()
  })

  it('закрытая панель схлопывается совсем, без полоски-дублёра', () => {
    useUiStore.getState().setRightPanel('edf', false)
    renderPanel()

    // Ни самой панели, ни полоски с кнопкой «Развернуть панель опций» —
    // возвращать её может только тулс-хедер и хоткей «[»
    expect(screen.queryByLabelText('Панель опций раздела «EDF»')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Развернуть панель опций' })).toBeNull()
  })

  it('в хедере нет дублёра тулс-хендера, есть одна кнопка-триггер', async () => {
    renderPanel()

    // Кнопка закрытия панели — только в тулс-хедере и хоткей «[»
    expect(screen.queryByRole('button', { name: 'Скрыть панель опций' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Свернуть панель опций' })).toBeNull()
    // Есть раскрытые секции — триггер предлагает свернуть все
    expect(await screen.findByRole('button', { name: 'Свернуть все секции' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Развернуть все секции' })).toBeNull()
  })

  it('секции, свёрнутые по умолчанию, не считаются раскрытыми', () => {
    renderWithProviders(
      <RightPanel section={SECTION}>
        <Panel title="Эпохи" defaultOpen={false}>
          <span>эпохи</span>
        </Panel>
      </RightPanel>,
    )

    // Единственная секция свёрнута по умолчанию — триггер сразу предлагает развернуть
    expect(screen.getByRole('button', { name: 'Развернуть все секции' })).toBeInTheDocument()
  })

  it('первый клик сворачивает все секции разом и меняет подпись кнопки', async () => {
    const user = userEvent.setup()
    renderPanel()

    // «Эпохи» свёрнута по умолчанию, остальные раскрыты
    expect(screen.getByRole('button', { name: 'Фильтры и референс' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Эпохи' })).toHaveAttribute('aria-expanded', 'false')

    await user.click(screen.getByRole('button', { name: 'Свернуть все секции' }))

    for (const title of TITLES) {
      expect(screen.getByRole('button', { name: title })).toHaveAttribute('aria-expanded', 'false')
    }
    expect(useUiStore.getState().collapsedPanels).toEqual({
      'edf:Фильтры и референс': true,
      'edf:Пороги артефактов': true,
      'edf:Эпохи': true,
    })
    // Триггер переключился: теперь он предлагает развернуть все
    expect(screen.getByRole('button', { name: 'Развернуть все секции' })).toBeInTheDocument()
  })

  it('второй клик той же кнопки разворачивает все, включая свёрнутые по умолчанию', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'Свернуть все секции' }))
    await user.click(screen.getByRole('button', { name: 'Развернуть все секции' }))

    for (const title of TITLES) {
      expect(screen.getByRole('button', { name: title })).toHaveAttribute('aria-expanded', 'true')
    }
    expect(useUiStore.getState().collapsedPanels).toEqual({
      'edf:Фильтры и референс': false,
      'edf:Пороги артефактов': false,
      'edf:Эпохи': false,
    })
    // Снова «Свернуть все секции»
    expect(screen.getByRole('button', { name: 'Свернуть все секции' })).toBeInTheDocument()
  })
})