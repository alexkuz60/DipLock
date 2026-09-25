/**
 * Блок «АЧХ-отклик» (шаг 2.5): свёрнут по умолчанию, запрос — только по кнопке.
 *
 * Главный тест здесь — отрицательный: правка параметров не делает ни одного
 * запроса (правило UI), а раскрытие блока — единственное действие, шлющее
 * `GET /filter-response`.
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { FilterResponse } from './FilterResponse'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('FilterResponse (АЧХ)', () => {
  it('свёрнут по умолчанию и не делает запросов', () => {
    const fetchMock = mockApiFetch()
    renderWithProviders(<FilterResponse band={[1, 40]} notchHz={50} notchHarmonics={2} />)

    expect(screen.queryByTestId('filter-response-chart')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('правка параметров при свёрнутом блоке не делает запросов', () => {
    const fetchMock = mockApiFetch()
    const { rerender } = renderWithProviders(
      <FilterResponse band={[1, 40]} notchHz={50} notchHarmonics={0} />,
    )
    rerender(<FilterResponse band={[8, 13]} notchHz={60} notchHarmonics={3} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('раскрытие запрашивает АЧХ и рисует график с паспортом фильтра', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<FilterResponse band={[1, 40]} notchHz={50} notchHarmonics={2} />)

    await user.click(screen.getByRole('button', { name: /АЧХ-отклик/ }))

    expect(await screen.findByTestId('filter-response-chart')).toBeInTheDocument()
    expect(screen.getByTestId('filter-response-passport')).toHaveTextContent(/FIR/)
    // Параметры ушли в query: полоса, notch и гармоники
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/filter-response')
    expect(url).toContain('band_min=1')
    expect(url).toContain('band_max=40')
    expect(url).toContain('notch_hz=50')
    expect(url).toContain('notch_harmonics=2')
  })

  it('при открытой АЧХ правка не перезапрашивает график — обновляет кнопка', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    const { rerender } = renderWithProviders(
      <FilterResponse band={[1, 40]} notchHz={null} notchHarmonics={0} />,
    )
    await user.click(screen.getByRole('button', { name: /АЧХ-отклик/ }))
    await screen.findByTestId('filter-response-chart')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    rerender(<FilterResponse band={[8, 13]} notchHz={null} notchHarmonics={0} />)
    // Семантика «считает кнопка»: график прежних параметров + явное «обновить»
    expect(screen.getByText('параметры изменились')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Обновить' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('без фильтра кнопка выключена — АЧХ нечего показывать', () => {
    mockApiFetch()
    renderWithProviders(<FilterResponse band={null} notchHz={null} notchHarmonics={0} />)
    expect(screen.getByRole('button', { name: /АЧХ-отклик/ })).toBeDisabled()
  })
})