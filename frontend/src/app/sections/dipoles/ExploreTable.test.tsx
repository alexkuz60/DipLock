/**
 * Тесты разведочного прохода (С3): таблица отдельных частот — вход выбора полос.
 *
 * Проверяется главное правило: таблица показывает **измерения** сервера, ничего
 * не пересчитывая, неизмеренные доли — «—», а не «0,000», а сортировка —
 * параметр просмотра (правка порядка не делает ни одного запроса).
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { spectrumResultFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { ExploreTable } from './ExploreTable'

function exploreOf(overrides: Partial<NonNullable<ReturnType<typeof spectrumResultFixture>['explore']>> = {}) {
  const explore = spectrumResultFixture().explore
  if (!explore) throw new Error('spectrumResultFixture: неожиданно пустой explore')
  return { ...explore, ...overrides }
}

describe('разведочный спектральный проход (С3)', () => {
  it('рисует строки частот: ритм, доли и амплитудный диапазон по эпохам', () => {
    renderWithProviders(<ExploreTable explore={exploreOf()} />)

    const rows = screen.getAllByTestId('explore-row')
    expect(rows).toHaveLength(7)
    // Сетка по возрастанию частоты (порядок по умолчанию)
    expect(rows.map((row) => row.getAttribute('data-freq'))).toEqual([
      '1', '4', '8', '10', '13', '30', '40',
    ])
    expect(rows[3]).toHaveTextContent('10.00')
    expect(rows[3]).toHaveTextContent('α/низкий β — альфа/низкий бета')
    expect(rows[3]).toHaveTextContent('1.000')  // доля пика плотности своей полосы
  })

  it('неизмеренные доли показывает «—», а не ноль', () => {
    renderWithProviders(<ExploreTable explore={exploreOf()} />)

    const rows = screen.getAllByTestId('explore-row')
    const last = rows[6]
    expect(last).toHaveTextContent('40.00')
    expect(last).toHaveTextContent('—')
  })

  it('переключатель «по мощности» сортирует строки — без единого запроса', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ExploreTable explore={exploreOf()} />)

    await user.click(screen.getByRole('button', { name: 'по мощности' }))

    const rows = screen.getAllByTestId('explore-row')
    // 10 Гц — максимальная доля мощности (0.620); при равенстве — по частоте
    expect(rows.map((row) => row.getAttribute('data-freq'))).toEqual([
      '10', '8', '4', '13', '1', '30', '40',
    ])
  })

  it('пустой список частот — честное «не измерено», а не пустая таблица', () => {
    renderWithProviders(<ExploreTable explore={exploreOf({ lines: [] })} />)

    expect(screen.getByTestId('explore-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('explore-table')).toBeNull()
  })

  it('легенда называет базисы нормировки (паспорт С0)', () => {
    renderWithProviders(<ExploreTable explore={exploreOf()} />)

    const legend = screen.getByTestId('explore-legend')
    expect(legend).toHaveAttribute(
      'title',
      'power_basis=share_of_band_power_max; psd_basis=share_of_band_psd_peak',
    )
    expect(legend).toHaveTextContent('выбор остаётся за исследователем')
  })
})