/**
 * Тесты меню быстрого перемещения по секциям панели опций: список секций,
 * выбор (раскрытие + прокрутка — на стороне `RightPanel`), закрытие меню.
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelNavMenu } from './PanelNavMenu'
import type { PanelNavItem } from './panelNav'
import { renderWithProviders } from '@/test/renderWithProviders'

const ITEMS: PanelNavItem[] = [
  { key: 'edf:Фильтры и референс', title: 'Фильтры и референс', el: document.createElement('section') },
  { key: 'edf:Эпохи', title: 'Эпохи', el: document.createElement('section') },
]

describe('меню быстрого перемещения по секциям панели', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('показывает секции панели и отдаёт выбранную наружу, закрываясь', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    renderWithProviders(<PanelNavMenu items={ITEMS} onPick={onPick} />)

    await user.click(screen.getByRole('button', { name: 'Меню быстрого перемещения по секциям' }))

    const menu = screen.getByRole('menu', { name: 'Секции панели опций' })
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Фильтры и референс', 'Эпохи'])

    await user.click(items[1])

    expect(onPick).toHaveBeenCalledWith(ITEMS[1])
    // Меню закрывается после выбора
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('закрывается Escape и кликом мимо (как меню пиуль легенды)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PanelNavMenu items={ITEMS} onPick={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Меню быстрого перемещения по секциям' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('без секций кнопка выключена, но подсказка доступна', () => {
    renderWithProviders(<PanelNavMenu items={[]} onPick={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Меню быстрого перемещения по секциям' })
    expect(trigger).toBeDisabled()
  })

  it('кнопка помечает открытое меню (aria-expanded)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<PanelNavMenu items={ITEMS} onPick={vi.fn()} />)

    const trigger = screen.getByRole('button', { name: 'Меню быстрого перемещения по секциям' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })
})