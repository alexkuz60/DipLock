/**
 * Панель «Опции» раздела «БД»: фильтры пишут состояние просмотра и ничего не
 * запускают (в тестах — ни одного fetch).
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDbView } from '@/shared/state/dbView'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DbPanel } from './DbPanel'

describe('панель «Опции» раздела «БД»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDbView.setState({
      onlyProcessed: true,
      search: '',
      groupByPatient: true,
      sortKey: 'created',
      pageLimit: 50,
      pageOffset: 0,
      selectedIds: [],
      expandedId: null,
    })
    vi.stubGlobal('fetch', vi.fn())
  })

  it('фильтры, группировка и сортировка пишут состояние без запросов', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DbPanel />)

    await user.click(screen.getByText('Только обработанные'))
    expect(useDbView.getState().onlyProcessed).toBe(false)

    await user.click(screen.getByText('Плоский список'))
    expect(useDbView.getState().groupByPatient).toBe(false)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'name')
    expect(useDbView.getState().sortKey).toBe('name')

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Записей на странице' }),
      '100',
    )
    expect(useDbView.getState().pageLimit).toBe(100)
    expect(useDbView.getState().pageOffset).toBe(0) // смена страницы сбрасывает смещение

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('кнопка «Снять выделение» очищает выборку', async () => {
    const user = userEvent.setup()
    useDbView.setState({ selectedIds: ['rec-a', 'rec-b'] })
    renderWithProviders(<DbPanel />)

    expect(screen.getByText('Выбрано записей: 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Снять выделение' }))
    expect(useDbView.getState().selectedIds).toEqual([])
  })
})