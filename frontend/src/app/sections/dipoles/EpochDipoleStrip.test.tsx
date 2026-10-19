/**
 * Тесты индикатора эпох/диполей (`EpochDipoleStrip`, второй ряд шапки):
 * ячейка на эпоху нарезки включая BAD, готовность/полосные заливки, выбор эпохи
 * кликом (3.3) и индикатор кадра анимации (3.4).
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS, PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import {
  dipoleBatchResultFixture,
  dipoleScanResultFixture,
} from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { EpochDipoleStrip } from './EpochDipoleStrip'

/** Состояние с набором пакета: 4 эпохи, обе полосы отображаются, эпоха 4 — BAD. */
function setBatchState() {
  useDipoleCalc.setState({
    params: { ...CALC_PARAM_DEFAULTS },
    batch: dipoleBatchResultFixture(),
    batchJob: null,
    result: dipoleScanResultFixture(),
    playbackBandKeys: ['alpha', 'beta'],
    activeBandKey: 'alpha',
    selectedEpochIndex: null,
    playback: { ...PLAYBACK_DEFAULTS },
  })
}

describe('индикатор эпох/диполей', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      batch: null,
      batchJob: null,
      result: null,
      playbackBandKeys: [],
      selectedEpochIndex: null,
      playback: { ...PLAYBACK_DEFAULTS },
    })
  })

  it('без результата и идущей задачи не рисует ничего (не «пустой ряд»)', () => {
    renderWithProviders(<EpochDipoleStrip />)

    expect(screen.queryByTestId('epoch-strip')).not.toBeInTheDocument()
  })

  it('рисует ячейку на эпоху нарезки включая BAD и называет их в тултипах', () => {
    setBatchState()
    renderWithProviders(<EpochDipoleStrip />)

    const cells = screen.getAllByTestId('epoch-strip-cell')
    expect(cells).toHaveLength(4) // n_epochs_total фикстуры, включая BAD
    expect(cells.map((cell) => cell.getAttribute('data-epoch'))).toEqual(['0', '1', '2', '3'])

    // Готовая эпоха называет полосы с диполями, BAD — эпоху с причиной
    expect(cells[1]).toHaveAttribute('title', 'Эпоха 2 · диполи: alpha, beta')
    expect(cells[3]).toHaveAttribute('title', 'Эпоха 4 · BAD — отброшена')
    // Номер BAD-серии подписан под рядом («4» — эпоха №4)
    expect(screen.getByText('4')).toBeInTheDocument()
  })

  it('клик по ячейке выбирает эпоху и перематывает кадр; повторный — снимает выбор (3.3/3.4)', async () => {
    const user = userEvent.setup()
    setBatchState()
    renderWithProviders(<EpochDipoleStrip />)

    await user.click(screen.getAllByTestId('epoch-strip-cell')[1])

    expect(useDipoleCalc.getState().selectedEpochIndex).toBe(1)
    expect(useDipoleCalc.getState().playback).toMatchObject({
      active: true,
      playing: false,
      epochIndex: 1,
    })
    // Выбранная ячейка помечена рамкой (aria-pressed переключателя)
    expect(screen.getAllByTestId('epoch-strip-cell')[1]).toHaveAttribute('aria-pressed', 'true')

    // Повторный клик снимает выбор, кадр остаётся на месте
    await user.click(screen.getAllByTestId('epoch-strip-cell')[1])
    expect(useDipoleCalc.getState().selectedEpochIndex).toBeNull()
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(1)
  })

  it('ячейка кадра анимации помечена кольцом (3.4)', () => {
    setBatchState()
    useDipoleCalc.setState({
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 2 },
    })
    renderWithProviders(<EpochDipoleStrip />)

    const cells = screen.getAllByTestId('epoch-strip-cell')
    expect(cells[2].className).toContain('ring-2')
    expect(cells[0].className).not.toContain('ring-2')
  })

  it('во время задачи ряд предзаливается по прогрессу эпох (3.1)', () => {
    useDipoleCalc.setState({
      batchJob: {
        status: 'running',
        progress: 0.25,
        message: 'Диполи: 1 из 4',
        stage: 'scan',
        epochsDone: 1,
        epochsTotal: 4,
        error: null,
      },
      result: dipoleScanResultFixture(),
    })
    renderWithProviders(<EpochDipoleStrip />)

    // Сетка уже известна (по задаче/результату), первая ячейка предзалита
    const cells = screen.getAllByTestId('epoch-strip-cell')
    expect(cells).toHaveLength(4)
    expect(cells[0].querySelector('[class*="opacity-25"]')).not.toBeNull()
    expect(cells[3].querySelector('[class*="opacity-25"]')).toBeNull()
  })
})
