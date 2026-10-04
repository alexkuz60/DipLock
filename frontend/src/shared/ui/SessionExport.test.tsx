/** Тесты панели «Экспорт записи» (N40/4.6): пакет задачей, CSV-ссылка, параметры. */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SessionExport } from './SessionExport'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

const REC = 'rec-1'

describe('SessionExport', () => {
  it('без записи панель честно говорит, что экспортировать нечего', () => {
    mockApiFetch()
    renderWithProviders(<SessionExport recordingId={null} />)

    expect(screen.getByText('Запись не загружена — экспортировать пока нечего.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Собрать пакет/ })).not.toBeInTheDocument()
  })

  it('кнопка запускает задачу пакета и показывает ссылку на zip', async () => {
    const fetchMock = mockApiFetch()
    renderWithProviders(<SessionExport recordingId={REC} />)

    // Правка формата ничего не запускает (правило «кнопка считает»)
    const group = screen.getByRole('group', { name: 'Формат пакета' })
    await userEvent.click(within(group).getByRole('button', { name: 'bids' }))
    expect(fetchMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /Собрать пакет/ }))

    // Запуск — POST на /bundle с выбранным форматом (плюс поллинг /jobs/)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const startCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/bundle') && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(startCall).toBeDefined()
    const form = startCall?.[1]?.body as FormData
    expect(form.get('format')).toBe('bids')

    const result = await screen.findByTestId('bundle-result')
    expect(result).toHaveTextContent('Готово')
    const zipLink = screen.getByRole('link', { name: /Скачать zip/ })
    expect(zipLink.getAttribute('href')).toContain('/bundle/job-bundle-1/zip')
  })

  it('CSV-ссылка ведёт на выгрузку диполей записи', () => {
    mockApiFetch()
    renderWithProviders(<SessionExport recordingId={REC} />)

    const csvLink = screen.getByTestId('dipoles-csv-link')
    expect(csvLink.getAttribute('href')).toBe(`/api/v1/recordings/${REC}/dipoles.csv`)
  })

  it('ошибка задачи показывается текстом сервера', async () => {
    mockApiFetch({ calcStartFails: true })
    renderWithProviders(<SessionExport recordingId={REC} />)

    await userEvent.click(screen.getByRole('button', { name: /Собрать пакет/ }))

    const error = await screen.findByTestId('bundle-error')
    expect(error).toHaveTextContent('Запись не найдена или уже удалена')
  })
})
