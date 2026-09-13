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
import { frameFromSignalData, type SignalFrame } from '@/shared/lib/signalFrame'
import type { EdfViewerLayers } from '@/shared/lib/viewerLayers'
import { EDF_PARAM_DEFAULTS, emptyStageSnapshot, useEdfParams } from '@/shared/state/edfParams'
import { uplotCharts } from '@/test/uplot'

import { TrackStack } from './TrackStack'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Короткий сигнал: 3 канала, 10 с, 100 Гц — арифметика в тестах проверяема. */
function signalDataFixture(): SignalData {
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

/** Кадр «полный сигнал»: min == max, уровень 0 (как демо-фикстура). */
function frameFixture(): SignalFrame {
  return frameFromSignalData(signalDataFixture())
}

/** Кадр огибающей: 100 корзин за 10 с, min = −amp, max = +amp (уровень ×1). */
function decimatedFrameFixture(): SignalFrame {
  const nPoints = 100
  const durationSec = 10
  const times = new Float32Array(nPoints)
  for (let i = 0; i < nPoints; i++) times[i] = ((i + 0.5) * durationSec) / nPoints
  const min: Record<string, Float32Array> = {}
  const max: Record<string, Float32Array> = {}
  for (const name of ['F3', 'F4', 'C3']) {
    const lo = new Float32Array(nPoints)
    const hi = new Float32Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      // Каждая корзина: пик +60 мкВ по всем каналам — артефакт должен остаться
      lo[i] = i === 50 ? -60 : -5
      hi[i] = i === 50 ? 60 : 5
    }
    min[name] = lo
    max[name] = hi
  }
  return {
    sourceId: 'rec-1',
    channels: ['F3', 'F4', 'C3'],
    durationSec,
    times,
    min,
    max,
    decimated: true,
    level: 1,
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
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.getByTestId('track-F3')).toBeInTheDocument()
    expect(screen.getByTestId('track-F4')).toBeInTheDocument()
    expect(screen.getByTestId('track-C3')).toBeInTheDocument()
    // Порядок — как в сигнале/монтаже, а не как пришёл из выбора
    const labels = screen
      .getAllByTestId(/^track-label-/)
      .map((node) => node.textContent)
    expect(labels).toEqual(['F3', 'F4', 'C3'])
    expect(uplotCharts()).toHaveLength(3)
  })

  it('не создаёт чарт для скрытого канала и показывает подсказку, если скрыто всё', () => {
    paramsState({ visibleChannels: [] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.queryByTestId('track-F3')).not.toBeInTheDocument()
    expect(screen.getByText(/Все каналы скрыты/)).toBeInTheDocument()
    expect(uplotCharts()).toHaveLength(0)
  })

  it('по умолчанию показывает всю сессию, на уровне ×4 — окно вчетверо короче', () => {
    paramsState({ visibleChannels: ['F3'], timeLevel: 0 })
    const { unmount } = renderWithProviders(<TrackStack signal={frameFixture()} />)
    expect(screen.getByText('Окно 0.00–10.00 с')).toBeInTheDocument()
    unmount()

    paramsState({ visibleChannels: ['F3'], timeLevel: 2 })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.getByText('Окно 3.75–6.25 с')).toBeInTheDocument()
    expect(screen.getByText('×4')).toBeInTheDocument()
  })

  it('клик по подписи скрывает канал, Ctrl+клик оставляет только его', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

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

    renderWithProviders(<TrackStack signal={frameFixture()} />)
    await user.click(screen.getByTestId('track-F3').querySelector('button')!)

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ограничивает число точек на трек бюджетом по ширине (min/max-огибающая)', () => {
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

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
    // Окно 10/8 = 1.25 с (4.375–5.625) → 125 отсчётов 100 Гц: бюджет шире окна,
    // агрегация не нужна
    expect(times.length).toBe(125)
    expect(zoomedMin.length).toBe(125)
    expect(zoomedMax.length).toBe(125)
    expect(uplotCharts()[0].setScale).toHaveBeenCalledWith('x', { min: 4.375, max: 5.625 })
  })

  it('прореженный кадр растягивается бюджетом, но сохраняет пик артефакта', () => {
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={decimatedFrameFixture()} />)

    // Полная сессия: 100 корзин меньше бюджета (2048) — огибающая как есть
    let call = uplotCharts()[0].setData.mock.calls.at(-1) as [
      [Float32Array, Float32Array, Float32Array],
      boolean,
    ]
    expect(call[0][1].length).toBe(100)
    expect(call[0][2][50]).toBe(60)
    expect(call[0][1][50]).toBe(-60)

    // Зум ×16: окно 0.625 с ≈ 6 корзин, агрегации нет — пик остаётся
    act(() => {
      useEdfParams.getState().setParams({ timeLevel: 4 })
    })
    call = uplotCharts()[0].setData.mock.calls.at(-1) as [
      [Float32Array, Float32Array, Float32Array],
      boolean,
    ]
    expect(call[0][2].length).toBe(6)
    expect(Math.max(...call[0][2])).toBe(60)
  })

  it('подписывает источник: огибающая с числом точек против полного сигнала', () => {
    paramsState({ visibleChannels: ['F3'] })
    const { unmount } = renderWithProviders(<TrackStack signal={frameFixture()} />)
    expect(screen.getByTestId('signal-source')).toHaveTextContent('полный сигнал')
    unmount()

    renderWithProviders(<TrackStack signal={decimatedFrameFixture()} />)
    expect(screen.getByTestId('signal-source')).toHaveTextContent('огибающая, 100 т/канал')
  })
})

/**
 * Слои результата (срез 2.6): зоны артефактов и эпохи поверх треков.
 *
 * Проверяем связку «параметры отрисовки → слои»: легенда и чекбоксы панели
 * управляют одним состоянием (`artifactVisibility`), клик по зоне даёт тултип
 * с типом/интервалом/каналами, а переключатели эпох убирают границы и штриховку.
 */
describe('слои результата вьюера', () => {
  beforeEach(() => {
    uplotCharts().length = 0
    localStorage.clear()
  })

  /** Слои: две зоны в начале сессии и отброшенные эпохи 1 и 3 (10 с, 2 с/эпоха). */
  function layersFixture(): EdfViewerLayers {
    return {
      source: 'demo',
      artifacts: [
        {
          id: 'zscore_outlier-1',
          kind: 'zscore_outlier',
          onsetSec: 1,
          durationSec: 1,
          channels: ['F3'],
        },
        { id: 'flat_line-1', kind: 'flat_line', onsetSec: 5, durationSec: 0.5, channels: [] },
      ],
      rejectedEpochs: [1, 3],
    }
  }

  it('рисует зоны, легенду с числом зон по типам и помечает источник фикстурой', () => {
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    expect(screen.getByTestId('track-layers')).toBeInTheDocument()
    expect(screen.getByTestId('zone-zscore_outlier-1')).toBeInTheDocument()
    expect(screen.getByTestId('zone-flat_line-1')).toBeInTheDocument()
    expect(screen.getByTestId('legend-zscore_outlier')).toHaveTextContent('1')
    expect(screen.getByTestId('legend-peak_to_peak')).toHaveTextContent('0')
    expect(screen.getByTestId('legend-ica_eog')).toHaveTextContent('0')
    expect(screen.getByText('слои: демо-фикстура')).toBeInTheDocument()
  })

  it('границы эпох: первая совпадает с краем записи и не рисуется, штриховка — только отброшенные', () => {
    paramsState({ visibleChannels: ['F3'], epochLengthMs: 2000 })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    // 10 с / 2 с = 5 эпох: границы есть у 1…4, край записи линией не помечаем
    expect(screen.queryByTestId('epoch-edge-0')).not.toBeInTheDocument()
    expect(screen.getByTestId('epoch-edge-1')).toBeInTheDocument()
    expect(screen.getByTestId('epoch-edge-4')).toBeInTheDocument()
    expect(screen.getByTestId('epoch-hatch-1')).toBeInTheDocument()
    expect(screen.getByTestId('epoch-hatch-3')).toBeInTheDocument()
    expect(screen.queryByTestId('epoch-hatch-0')).not.toBeInTheDocument()
  })

  it('тумблеры панели убирают слои: видимость типа и геометрию эпох', () => {
    paramsState({
      visibleChannels: ['F3'],
      artifactVisibility: {
        zscore_outlier: false,
        peak_to_peak: true,
        flat_line: true,
        ica_eog: true,
      },
      epochBoundaries: false,
      droppedEpochsHatched: false,
    })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    expect(screen.queryByTestId('zone-zscore_outlier-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('zone-flat_line-1')).toBeInTheDocument()
    // Эпохи не строятся вовсе — ни линий, ни штриховки
    expect(screen.queryByTestId('epoch-edge-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('epoch-hatch-1')).not.toBeInTheDocument()
  })

  it('клик по зоне показывает детали (тип, интервал, каналы), крестик их скрывает', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    const zone = screen.getByTestId('zone-zscore_outlier-1')
    expect(screen.queryByTestId('zone-details')).not.toBeInTheDocument()

    await user.click(zone)

    const details = screen.getByTestId('zone-details')
    expect(details).toHaveTextContent('z-score')
    expect(details).toHaveTextContent('1.000–2.000 с')
    expect(details).toHaveTextContent('Каналы: F3')
    expect(zone).toHaveAttribute('aria-pressed', 'true')
    // Зона без каналов говорит «весь монтаж», а не пустой список
    await user.click(screen.getByTestId('zone-flat_line-1'))
    expect(screen.getByTestId('zone-details')).toHaveTextContent('весь монтаж')

    await user.click(screen.getByRole('button', { name: 'Скрыть детали зоны' }))
    expect(screen.queryByTestId('zone-details')).not.toBeInTheDocument()
  })

  it('легенда переключает видимость без запросов к серверу (правило «только по кнопке»)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3'] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    await user.click(screen.getByTestId('legend-zscore_outlier'))

    expect(useEdfParams.getState().params.artifactVisibility.zscore_outlier).toBe(false)
    expect(screen.queryByTestId('zone-zscore_outlier-1')).not.toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('без пропа слоёв берёт демо-фикстуру под длину сигнала', () => {
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.getByTestId('track-layers')).toBeInTheDocument()
    expect(screen.getByText('слои: демо-фикстура')).toBeInTheDocument()
    // Фикстура даёт минимум две зоны каждого типа — легенда не пустая
    expect(screen.getByTestId('legend-ica_eog').textContent).toMatch(/[2-4]/)
  })

  it('результат расчёта помечается в подписи иначе, чем фикстура', () => {
    paramsState({ visibleChannels: ['F3'] })
    const layers: EdfViewerLayers = { ...layersFixture(), source: 'result' }
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layers} />)

    expect(screen.getByText('слои: результат расчёта')).toBeInTheDocument()
  })
})

