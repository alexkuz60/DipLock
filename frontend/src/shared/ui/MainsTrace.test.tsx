/**
 * Блок «Сетевой фон» (Части 1 §7): свёрнут по умолчанию, запрос — только по кнопке.
 *
 * Главные тесты — отрицательные: правка параметров не делает ни одного
 * запроса (правило UI), а раскрытие блока — единственное действие, шлющее
 * `GET /recordings/{id}/mains`.
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MainsTrace } from './MainsTrace'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('MainsTrace (сетевой фон)', () => {
  it('свёрнут по умолчанию и не делает запросов', () => {
    const fetchMock = mockApiFetch()
    renderWithProviders(<MainsTrace recordingId="rec-1" notchHz={50} notchHarmonics={2} />)

    expect(screen.queryByTestId('mains-chart')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('правка параметров при свёрнутом блоке не делает запросов', () => {
    const fetchMock = mockApiFetch()
    const { rerender } = renderWithProviders(
      <MainsTrace recordingId="rec-1" notchHz={50} notchHarmonics={0} />,
    )
    rerender(<MainsTrace recordingId="rec-1" notchHz={60} notchHarmonics={3} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('раскрытие запрашивает данные и рисует трассу с уровнями L1', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<MainsTrace recordingId="rec-1" notchHz={50} notchHarmonics={1} />)

    await user.click(screen.getByRole('button', { name: /Сетевой фон/ }))

    expect(await screen.findByTestId('mains-chart')).toBeInTheDocument()
    expect(screen.getByTestId('mains-levels')).toHaveTextContent(/50 Гц \+18.4 дБ/)
    expect(screen.getByTestId('mains-passport')).toHaveTextContent(/канал T7/i)
    // Параметры ушли в query: запись, notch и гармоники
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/recordings/rec-1/mains')
    expect(url).toContain('notch_hz=50')
    expect(url).toContain('notch_harmonics=1')
  })

  it('при открытом блоке смена notch не перезапрашивает — обновляет кнопка', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    const { rerender } = renderWithProviders(
      <MainsTrace recordingId="rec-1" notchHz={50} notchHarmonics={0} />,
    )
    await user.click(screen.getByRole('button', { name: /Сетевой фон/ }))
    await screen.findByTestId('mains-chart')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    rerender(<MainsTrace recordingId="rec-1" notchHz={60} notchHarmonics={0} />)
    // Семантика «считает кнопка»: прежняя трасса + явное «обновить»
    expect(screen.getByText('параметры изменились')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Обновить' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1][0])).toContain('notch_hz=60')
  })

  it('без записи или без notch кнопка выключена — считать нечего', () => {
    mockApiFetch()
    const { rerender } = renderWithProviders(
      <MainsTrace recordingId="rec-1" notchHz={50} notchHarmonics={0} />,
    )
    expect(screen.getByRole('button', { name: /Сетевой фон/ })).toBeEnabled()
    rerender(<MainsTrace recordingId={null} notchHz={50} notchHarmonics={0} />)
    expect(screen.getByRole('button', { name: /Сетевой фон/ })).toBeDisabled()
    rerender(<MainsTrace recordingId="rec-1" notchHz={null} notchHarmonics={0} />)
    expect(screen.getByRole('button', { name: /Сетевой фон/ })).toBeDisabled()
  })
})
