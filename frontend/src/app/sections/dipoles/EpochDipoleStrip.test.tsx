/**
 * Тесты индикатора эпох/диполей (`EpochDipoleStrip`, второй ряд шапки):
 * ячейка на эпоху нарезки включая BAD, заливка-микс готовых полос (суммарно ≤
 * 75%), выбор эпохи кликом и белая рамка текущей эпохи (3.3/3.4) — она следует
 * за кадром анимации в Плей. На время задачи раскраска стёрта и виден прогресс.
 */
import { act, screen } from '@testing-library/react'
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

  it('белая рамка следует за кадром анимации в Плей (3.3/3.4)', () => {
    setBatchState()
    useDipoleCalc.setState({
      playback: { ...PLAYBACK_DEFAULTS, playing: true, active: true, epochIndex: 0 },
      selectedEpochIndex: 0,
    })
    renderWithProviders(<EpochDipoleStrip />)

    let cells = screen.getAllByTestId('epoch-strip-cell')
    expect(cells[0].className).toContain('outline-fg-0')
    expect(cells[2].className).not.toContain('outline-fg-0')

    // Часы анимации сдвигают кадр (`setPlaybackEpoch`) — выделение переезжает
    act(() => useDipoleCalc.getState().setPlaybackEpoch(2))

    expect(useDipoleCalc.getState().selectedEpochIndex).toBe(2)
    cells = screen.getAllByTestId('epoch-strip-cell')
    expect(cells[2].className).toContain('outline-fg-0')
    expect(cells[0].className).not.toContain('outline-fg-0')
  })

  it('заливает готовые ячейки миксом цветов полос на весь прямоугольник', () => {
    setBatchState()
    renderWithProviders(<EpochDipoleStrip />)

    const cells = screen.getAllByTestId('epoch-strip-cell')
    // Эпоха 2 (index 1): обе полосы готовы — два слоя, доля каждого 0.75 / 2
    const layers = cells[1].querySelectorAll('span[style*="background-color"]')
    expect(layers).toHaveLength(2)
    for (const layer of layers) {
      expect((layer as HTMLElement).className).toContain('absolute')
      expect((layer as HTMLElement).style.opacity).toBe('0.375')
    }
    // Вертикальных сегментов-полосок больше нет (правка 19.10.2026)
    expect(cells[1].querySelectorAll('span[class*="flex-1"]')).toHaveLength(0)
  })

  it('во время перерасчёта раскраска стёрта и ряд предзаливается по прогрессу (3.1)', () => {
    setBatchState()
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
    })
    renderWithProviders(<EpochDipoleStrip />)

    // Сетка уже известна (по задаче/результату), первая ячейка предзалита
    const cells = screen.getAllByTestId('epoch-strip-cell')
    expect(cells).toHaveLength(4)
    expect(cells[0].querySelector('[class*="opacity-25"]')).not.toBeNull()
    expect(cells[3].querySelector('[class*="opacity-25"]')).toBeNull()
    // Прежняя раскраска (микс готовых полос и BAD) стёрта: прогресс виден, а не
    // прячется под слоем старых цветов (правка 19.10.2026)
    expect(cells[1].querySelector('span[style*="background-color"]')).toBeNull()
    expect(cells[3].querySelector('[class*="bg-warn"]')).toBeNull()
    // Подписи BAD-серий на время перерасчёта тоже стёрты
    expect(screen.queryByText('4')).not.toBeInTheDocument()
  })
})
