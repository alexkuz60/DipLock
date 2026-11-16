/**
 * Тесты тулс-хедера раздела «БД»: удаление выборки записей — разрушительное
 * действие в два шага («Удалить» → «Подтвердить удаление»), DELETE уходит
 * только после подтверждения, отказавшие записи остаются выбранными с текстом
 * ошибки, страница готовности перечитывается.
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDbView } from '@/shared/state/dbView'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DbToolActions } from './DbToolActions'

describe('DbToolActions: удаление выборки', () => {
  beforeEach(() => {
    useDbView.setState({ selectedIds: [] })
  })

  it('требует подтверждения и удаляет только после второго клика', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    useDbView.setState({ selectedIds: ['rec-a', 'rec-b'] })
    renderWithProviders(<DbToolActions />)

    await user.click(screen.getByRole('button', { name: 'Удалить (2)' }))
    // Первый клик — только подтверждение, DELETE ещё нет
    expect(screen.getByRole('button', { name: 'Подтвердить удаление (2)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeInTheDocument()
    expect(
      fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Подтвердить удаление (2)' }))
    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.filter(
          ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toHaveLength(2)
    })
    // Полное удаление — выборка снята
    expect(useDbView.getState().selectedIds).toEqual([])
  })

  it('«Отмена» снимает подтверждение без запросов', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    useDbView.setState({ selectedIds: ['rec-a'] })
    renderWithProviders(<DbToolActions />)

    await user.click(screen.getByRole('button', { name: 'Удалить (1)' }))
    await user.click(screen.getByRole('button', { name: 'Отмена' }))

    expect(screen.getByRole('button', { name: 'Удалить (1)' })).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('отказ записи показывается текстом, отказавшие остаются выбранными', async () => {
    const user = userEvent.setup()
    mockApiFetch({ deleteRecordingFails: { 'rec-b': 'Запись занята' } })
    useDbView.setState({ selectedIds: ['rec-a', 'rec-b'] })
    renderWithProviders(<DbToolActions />)

    await user.click(screen.getByRole('button', { name: 'Удалить (2)' }))
    await user.click(screen.getByRole('button', { name: 'Подтвердить удаление (2)' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('rec-b — Запись занята')
    // Успешная запись ушла из выборки, отказавшая осталась — её видно и можно повторить
    await waitFor(() => {
      expect(useDbView.getState().selectedIds).toEqual(['rec-b'])
    })
  })

  it('без выборки кнопка выключена и объясняет подсказкой', () => {
    mockApiFetch()
    renderWithProviders(<DbToolActions />)

    const button = screen.getByRole('button', { name: 'Удалить (0)' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Выберите записи, которые нужно удалить')
  })
})