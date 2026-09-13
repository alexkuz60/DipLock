/**
 * Тесты каркаса: рейл, тулс-хедер, сворачивание правой панели, хоткеи.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'
import { SECTION_ROUTES } from '@/app/sections/registry'
import { SectionRoute } from '@/app/sections/routes'
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
})
