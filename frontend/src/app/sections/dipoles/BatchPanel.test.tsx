/**
 * Тесты панели «Пакет поддиапазонов» (С1/С2).
 *
 * Правило раздела: правка выбора полос **ничего не запускает** (из запросов
 * возможны только статические `/meta`), считает кнопка. Результат — набор:
 * чипы полос переключают активную (её точки показывают проекции/таблица), в
 * сопоставлении — только нормированные величины (колонки GOF нет — принцип 3),
 * кластеры показаны с устойчивостью по поддиапазонам.
 */
import { screen, waitFor } from '@testing-library/react'
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
      batchBandKeys: [],
      activeBandKey: null,
      result: null,
      job: null,
    })
    useEdfRecording.setState({ recording: recordingFixture })
  })

  it('правка выбора полос ничего не запускает; кнопка ждёт минимум две полосы', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<BatchPanel />)

    await waitFor(() => expect(screen.getByLabelText(/alpha/)).toBeInTheDocument())
    const button = screen.getByRole('button', { name: 'Считать пакет' })
    expect(button).toBeDisabled()

    await user.click(screen.getByLabelText(/alpha/))
    // Правка — ни одного запроса (из запросов возможны только статические /meta)
    const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(0)
    expect(button).toBeDisabled() // одной полосы пакету мало

    await user.click(screen.getByLabelText(/beta/))
    expect(button).toBeEnabled()
    expect(useDipoleCalc.getState().batchBandKeys).toEqual(['alpha', 'beta'])
    expect(
      fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(0)
  })

  it('считает пакет по кнопке и показывает набор: чипы полос и сопоставление', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<BatchPanel />)

    await waitFor(() => expect(screen.getByLabelText(/alpha/)).toBeInTheDocument())
    await user.click(screen.getByLabelText(/alpha/))
    await user.click(screen.getByLabelText(/beta/))
    await user.click(screen.getByRole('button', { name: 'Считать пакет' }))

    await waitFor(() =>
      expect(useDipoleCalc.getState().batch?.bands).toHaveLength(2),
    )
    // Чипы полос: активная — первая полоса набора
    expect(screen.getByRole('button', { name: 'alpha (8–13 Гц)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'beta (13–30 Гц)' })).toBeInTheDocument()
    expect(useDipoleCalc.getState().activeBandKey).toBe('alpha')
    // Сопоставление: нормированные величины подписаны процентами
    expect(screen.getByText('Сопоставление полос')).toBeInTheDocument()
    expect(screen.getByText('62%')).toBeInTheDocument()
  })

  it('в сопоставлении нет колонки GOF — GOF между полосами не сравним', async () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      batchBandKeys: ['alpha', 'beta'],
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

  it('переключение чипа меняет активную полосу и точки в result', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      batchBandKeys: ['alpha', 'beta'],
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    await user.click(screen.getByRole('button', { name: 'beta (13–30 Гц)' }))

    const state = useDipoleCalc.getState()
    expect(state.activeBandKey).toBe('beta')
    // Проекции/таблица читают `result` — в нём скан активной полосы
    expect(state.result?.filter_band_hz).toEqual([13, 30])
  })

  it('показывает кластеры с паспортом нормировки и устойчивостью по поддиапазонам', () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      batchBandKeys: ['alpha', 'beta'],
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
