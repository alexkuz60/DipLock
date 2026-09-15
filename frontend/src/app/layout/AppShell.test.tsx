/**
 * Тесты каркаса: рейл, тулс-хедер, сворачивание правой панели, хоткеи.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { SECTION_ROUTES } from '@/app/sections/registry'
import { SectionRoute } from '@/app/sections/routes'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useUiStore } from '@/shared/state/uiStore'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

function renderApp(route = '/edf') {
  return renderWithProviders(
    <Routes>
      {SECTION_ROUTES.map(({ path, id }) => (
        <Route key={path} path={path} element={<SectionRoute id={id} />} />
      ))}
    </Routes>,
    { route },
  )
}

describe('каркас приложения', () => {
  beforeEach(() => {
    mockApiFetch()
    useUiStore.getState().resetUiState()
    // Выдвижная панель — состояние сессии: тесты не должны влиять друг на друга
    useDipoleCalc.setState({ view: 'none' })
  })

  it('рисует рейл разделов с доступными именами', () => {
    renderApp()
    expect(screen.getByRole('navigation', { name: 'Разделы приложения' })).toBeInTheDocument()
    for (const name of [
      'Главная',
      'EDF — просмотр записи',
      'Расчёт диполей и локализация',
      'Таблица локализации',
      'Групповой анализ',
      'Настройки приложения',
      'Состояние сервера',
    ]) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument()
    }
  })

  it('показывает тулс-хедер и рабочую область раздела', () => {
    renderApp()
    expect(
      screen.getByRole('heading', { level: 1, name: 'EDF — просмотр записи' }),
    ).toBeInTheDocument()
    // Рабочая область раздела EDF: зона загрузки записи (срезы 2.2–2.3)
    expect(screen.getByText('Файл записи не загружен')).toBeInTheDocument()
  })

  it('на Главной нет тулс-хедера раздела', () => {
    renderApp('/')
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Главная' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'DipLock' })).toBeInTheDocument()
  })

  it('сворачивает и разворачивает панель опций кнопкой и клавишей «[»', async () => {
    const user = userEvent.setup()
    renderApp()

    const panel = () => screen.queryByLabelText('Панель опций раздела «EDF»')
    expect(panel()).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Свернуть панель опций' }))
    expect(panel()).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Развернуть панель опций' }))
    expect(panel()).toBeInTheDocument()

    // хоткей обрабатывается на уровне окна (клавиша «[» экранируется в user-event)
    fireEvent.keyDown(window, { key: '[' })
    expect(panel()).not.toBeInTheDocument()

    // кнопка в тулс-хедере тоже управляет панелью
    await user.click(screen.getByRole('button', { name: 'Показать панель опций' }))
    expect(panel()).toBeInTheDocument()
  })

  it('переходит в раздел по горячей клавише', async () => {
    const user = userEvent.setup()
    renderApp('/')

    await user.keyboard('2')

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: 'EDF — просмотр записи' }),
      ).toBeInTheDocument(),
    )
  })

  it('держит рабочую область в высоте окна, а не в высоте содержимого', () => {
    // Каркас — grid со строкой `minmax(0,1fr)`: без неё неявная строка
    // растягивалась под треки, и внутренние скроллы не появлялись (срез 2.10)
    renderApp('/')

    const shell = document.querySelector('.grid.h-screen')
    expect(shell).not.toBeNull()
    expect(shell?.className).toContain('grid-rows-[minmax(0,1fr)]')

    const column = shell?.querySelector(':scope > div')
    expect(column?.className).toContain('min-h-0')
    expect(screen.getByRole('main')).toHaveClass('min-h-0')
  })

  it('показывает выдвижную панель раздела между шапкой и рабочей областью (срез 3.4)', () => {
    // Панель — полоса каркаса (`drawer`), а не часть прокручиваемого контента:
    // она объявлена в реестре разделов и появляется только у того раздела, у
    // которого она есть
    useDipoleCalc.setState({ view: 'topomap' })

    renderApp('/dipoles')

    const drawer = screen.getByTestId('dipoles-drawer')
    expect(drawer).toHaveAttribute('data-view', 'topomap')
    // Сосед сверху — тулс-хедер, снизу — рабочая область: панель между ними
    expect(drawer.previousElementSibling?.tagName).toBe('HEADER')
    expect(drawer.nextElementSibling?.tagName).toBe('MAIN')
  })

  it('не подсовывает открытую панель диполей разделам без панели', () => {
    // Панель объявлена в конфигурации раздела, а не в каркасе: открытая панель
    // диполей не должна «протекать» в раздел EDF
    useDipoleCalc.setState({ view: 'topomap' })
    cleanup()

    renderApp('/edf')

    expect(
      screen.getByRole('heading', { level: 1, name: 'EDF — просмотр записи' }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('dipoles-drawer')).not.toBeInTheDocument()
  })
})
