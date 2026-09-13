/**
 * Тесты вьюера треков (срез 2.3).
 *
 * uPlot подменён моком (см. `vitest.setup.ts`): тесты проверяют логику стека —
 * состав и порядок треков, окно времени, реакцию на клики по подписям каналов,
 * а не пиксели. Математика окна/огибающей покрыта в `viewerMath.test.ts`.
 */
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SignalData } from '@/shared/lib/demoSignal'
import { EDF_PARAM_DEFAULTS, emptyStageSnapshot, useEdfParams } from '@/shared/state/edfParams'
import { uplotCharts } from '@/test/uplot'

import { TrackStack } from './TrackStack'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Короткий сигнал: 3 канала, 10 с, 100 Гц — арифметика в тестах проверяема. */
function signalFixture(): SignalData {
  const sfreq = 100
  const durationSec = 10
  const n = sfreq * durationSec
  const make = (offset: number) => {
    const arr = new Float32Array(n)
    for (let i = 0; i < n; i++) arr[i] = 20 * Math.sin(offset + (i / sfreq) * 6)
    return arr
  }
  return {
    channels: ['F3', 'F4', 'C3'],
    sfreq,
    durationSec,
    data: { F3: make(0), F4: make(1), C3: make(2) },
  }
}

function paramsState(patch: Partial<typeof EDF_PARAM_DEFAULTS> = {}) {
  useEdfParams.setState({
    params: { ...EDF_PARAM_DEFAULTS, ...patch },
    availableChannels: [],
    stageApplied: emptyStageSnapshot(),
  })
}

describe('вьюер треков', () => {
  beforeEach(() => {
    uplotCharts().length = 0
    localStorage.clear()
  })

  it('рисует трек на каждый видимый канал в порядке монтажа', () => {
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'] })
    renderWithProviders(<TrackStack signal={signalFixture()} />)

    expect(screen.getByTestId('track-F3')).toBeInTheDocument()
    expect(screen.getByTestId('track-F4')).toBeInTheDocument()
    expect(screen.getByTestId('track-C3')).toBeInTheDocument()
    // Порядок — как в сигнале/монтаже, а не как пришёл из выбора
    const labels = screen.getAllByRole('button').map((node) => node.textContent)
    expect(labels).toEqual(['F3', 'F4', 'C3'])
    expect(uplotCharts()).toHaveLength(3)
  })

  it('не создаёт чарт для скрытого канала и показывает подсказку, если скрыто всё', () => {
    paramsState({ visibleChannels: [] })
    renderWithProviders(<TrackStack signal={signalFixture()} />)

    expect(screen.queryByTestId('track-F3')).not.toBeInTheDocument()
    expect(screen.getByText(/Все каналы скрыты/)).toBeInTheDocument()
    expect(uplotCharts()).toHaveLength(0)
  })

  it('по умолчанию показывает всю сессию, на уровне ×4 — окно вчетверо короче', () => {
    paramsState({ visibleChannels: ['F3'], timeLevel: 0 })
    const { unmount } = renderWithProviders(<TrackStack signal={signalFixture()} />)
    expect(screen.getByText('Окно 0.00–10.00 с')).toBeInTheDocument()
    unmount()

    paramsState({ visibleChannels: ['F3'], timeLevel: 2 })
    renderWithProviders(<TrackStack signal={signalFixture()} />)

    expect(screen.getByText('Окно 3.75–6.25 с')).toBeInTheDocument()
    expect(screen.getByText('×4')).toBeInTheDocument()
  })

  it('клик по подписи скрывает канал, Ctrl+клик оставляет только его', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'] })
    renderWithProviders(<TrackStack signal={signalFixture()} />)

    await user.click(screen.getByTestId('track-F4').querySelector('button')!)
    expect(useEdfParams.getState().params.visibleChannels).toEqual(['F3', 'C3'])

    await user.keyboard('{Control>}')
    await user.click(screen.getByTestId('track-F3').querySelector('button')!)
    await user.keyboard('{/Control}')

    expect(useEdfParams.getState().params.visibleChannels).toEqual(['F3'])
  })

  it('правка параметров вьюера не запускает обработку (только состояние)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4'] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    renderWithProviders(<TrackStack signal={signalFixture()} />)
    await user.click(screen.getByTestId('track-F3').querySelector('button')!)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ограничивает число точек на трек бюджетом по ширине (min/max-огибающая)', () => {
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={signalFixture()} />)

    expect(uplotCharts()).toHaveLength(1)
    const [[, min, max]] = uplotCharts()[0].setData.mock.calls.at(-1) as [
      [Float32Array, Float32Array, Float32Array],
      boolean,
    ]
    // 10 с × 100 Гц = 1000 отсчётов, бюджет = 1000 px × 2 = 2000 → без агрегации,
    // min и max совпадают с исходным сигналом
    expect(min.length).toBe(1000)
    expect(max.length).toBe(1000)
    expect(max[20]).toBeCloseTo(min[20], 6)

    act(() => {
      useEdfParams.getState().setParams({ timeLevel: 3 })
    })
    const [[times, zoomedMin, zoomedMax]] = uplotCharts()[0].setData.mock.calls.at(-1) as [
      [Float32Array, Float32Array, Float32Array],
      boolean,
    ]
    // Окно 10/8 = 1.25 с → 126 отсчётов (границы включительно): бюджет шире
    // окна, агрегация не нужна
    expect(times.length).toBe(126)
    expect(zoomedMin.length).toBe(126)
    expect(zoomedMax.length).toBe(126)
    expect(uplotCharts()[0].setScale).toHaveBeenCalledWith('x', { min: 4.375, max: 5.625 })
  })
})
