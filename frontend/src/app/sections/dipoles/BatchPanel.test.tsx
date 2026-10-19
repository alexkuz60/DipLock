/**
 * Тесты панели «Пакет поддиапазонов» (С1/С2).
 *
 * Прогон всегда идёт по всему каталогу кнопкой «Рассчитать пакет» в шапке — в
 * панели выбора полос прогона, чипов полос и кнопки запуска нет (правка
 * **ничего не запускает**, из запросов возможны только статические `/meta`).
 * Результат — набор: активная полоса (для таблицы) выбирается в разделе
 * «Таблица локализации», здесь — чекбоксы отображения, сопоставление только
 * нормированными величинами (колонки GOF нет — принцип 3) и кластеры с
 * устойчивостью по поддиапазонам.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { dipoleBatchResultFixture, recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { BatchPanel } from './BatchPanel'

describe('панель «Пакет поддиапазонов»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS },
      batch: null,
      batchJob: null,
      batchError: null,
      activeBandKey: null,
      playbackBandKeys: [],
      result: null,
    })
    useEdfRecording.setState({ recording: recordingFixture })
  })

  it('без результата объясняет запуск из шапки и не делает запросов', async () => {
    const fetchSpy = mockApiFetch()
    renderWithProviders(<BatchPanel />)

    expect(
      screen.getByText(/Прогон идёт по всем полосам каталога кнопкой «Рассчитать пакет»/),
    ).toBeInTheDocument()
    // Ни чекбоксов полос прогона, ни кнопки запуска здесь больше нет
    expect(screen.queryByRole('button', { name: 'Считать пакет' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('показывает набор: чекбоксы отображения и сопоставление', async () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
      playbackBandKeys: ['alpha', 'beta'],
    })
    renderWithProviders(<BatchPanel />)

    // Секция «Полосы прогона» (чипы) удалена вместе с выбором полос прогона:
    // полосу таблицы выбирает сама таблица, здесь — только отображение
    expect(screen.queryByRole('button', { name: 'alpha (8–13 Гц)' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'alpha' })).toBeInTheDocument()
    expect(useDipoleCalc.getState().activeBandKey).toBe('alpha')
    // Сопоставление: нормированные величины подписаны процентами
    expect(screen.getByText('Сопоставление полос')).toBeInTheDocument()
    expect(screen.getByText('62%')).toBeInTheDocument()
  })

  it('в сопоставлении нет колонки GOF — GOF между полосами не сравним', async () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    expect(screen.getByText('Сопоставление полос')).toBeInTheDocument()
    expect(
      screen.getByText(/GOF между полосами не сравним/),
    ).toBeInTheDocument()
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers.some((name) => name?.includes('GOF'))).toBe(false)
    expect(headers).toContain('RIV') // единственный кросс-полосной фильтр доверия
  })

  it('переключение активной полосы — забота таблицы: панель её не трогает', async () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    // Ни чипов, ни списка полос в панели нет — активную полосу меняет только
    // «Полоса таблицы» в разделе «Таблица локализации»
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(useDipoleCalc.getState().activeBandKey).toBe('alpha')
  })

  it('чекбоксы полос управляют анимацией и облаком: от всех до одной', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
      playbackBandKeys: ['alpha', 'beta'],
    })
    renderWithProviders(<BatchPanel />)

    // Снять полосу — её больше нет в кадре и облаке
    await user.click(screen.getByRole('checkbox', { name: 'alpha' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['beta'])
    // Вернуть — снова обе
    await user.click(screen.getByRole('checkbox', { name: 'alpha' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['beta', 'alpha'])
    // Быстрая комбинация «только активная»
    await user.click(screen.getByRole('button', { name: 'Только активная' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['alpha'])
    // …и «все полосы»
    await user.click(screen.getByRole('button', { name: 'Все полосы' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['alpha', 'beta'])
  })

  it('показывает кластеры с паспортом нормировки и устойчивостью по поддиапазонам', () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    expect(screen.getByText('Кластеры диполей (С2)')).toBeInTheDocument()
    expect(
      screen.getByText(/Воксель 0.1 от диаметра области поиска \(14 мм\)/),
    ).toBeInTheDocument()
    expect(screen.getByText(/устойчивость 1\/2 полос/)).toBeInTheDocument()
    // В кластеры взяты прошедшие КД — так подписано в паспорте
    expect(screen.getByText(/в кластеры взяты точки, прошедшие КД/)).toBeInTheDocument()
  })
})
