/**
 * Тесты вьюера треков (срез 2.3).
 *
 * uPlot подменён моком (см. `vitest.setup.ts`): тесты проверяют логику стека —
 * состав и порядок треков, окно времени, разворот трека стрелкой у названия,
 * переход в раздел «ЭЭГ» кликом по названию канала, листание окна по команде из
 * шапки и курсор по клику, а не пиксели.
 * Математика окна/огибающей покрыта в `viewerMath.test.ts`.
 */
import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SignalData } from '@/shared/lib/demoSignal'
import { frameFromSignalData, type SignalFrame } from '@/shared/lib/signalFrame'
import type { EdfViewerLayers } from '@/shared/lib/viewerLayers'
import { EDF_PARAM_DEFAULTS, emptyStageSnapshot, useEdfParams } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { EEG_PARAM_DEFAULTS, useEegParams } from '@/shared/state/eegParams'
import { perfReset, perfStats } from '@/shared/lib/perf'
import { uplotCharts, type MockUPlotChart } from '@/test/uplot'

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
    // Канал в «ЭЭГ» — состояние раздела назначения: тесты перехода не должны влиять друг на друга
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, filter: { ...EEG_PARAM_DEFAULTS.filter } },
      job: null,
      result: null,
      grid: null,
      error: null,
      gridError: null,
      eegNav: null,
    })
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

  /**
   * Колесо мыши (ручная проверка, 18.09.2026): **вертикальная прокрутка** стека,
   * а не зум. Раньше вьюер вешал нативный `wheel`-слушатель с `preventDefault` и
   * менял уровень зума с якорем в точке курсора — при 18+ каналах до нижних
   * треков было не добраться колесом. Теперь событие не отменяется (браузер
   * прокручивает контейнер), а зум меняют контролы шапки/панели.
   */
  it('не перехватывает колесо мыши: прокрутка треков, зум — только у контролов', () => {
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'], timeLevel: 2 })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    const region = screen.getByRole('region', { name: 'Треки ЭЭГ' })
    const before = useEdfParams.getState().params.timeLevel

    // `fireEvent` возвращает результат `dispatchEvent`: `true` — событие не отменено,
    // значит браузер прокрутит контейнер своим механизмом
    expect(fireEvent.wheel(region, { deltaY: -120 })).toBe(true)
    expect(fireEvent.wheel(region, { deltaY: 120 })).toBe(true)
    // Уровень зума колесом не меняется — зум переключают селект шапки и панели
    expect(useEdfParams.getState().params.timeLevel).toBe(before)
  })

  it('стрелка у названия канала разворачивает трек, повторный клик — сворачивает (срез 2.9)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    const expand = screen.getByTestId('track-expand-F4')
    expect(screen.getByTestId('track-F4')).toHaveStyle({ height: '64px' })

    await user.click(expand)

    // Высота области — 600 px (заглушка ResizeObserver), трек занимает её минус отступы
    expect(screen.getByTestId('track-F4')).toHaveStyle({ height: '592px' })
    expect(expand).toHaveAttribute('data-expanded', 'true')
    // Развёрнутый трек не скрывает соседей: видимость каналов — только у панели «Каналы»
    expect(useEdfParams.getState().params.visibleChannels).toEqual(['F3', 'F4', 'C3'])
    expect(screen.getByTestId('track-F3')).toBeInTheDocument()

    // Клик по другой стрелке переключает разворот, повторный по той же — сворачивает
    await user.click(screen.getByTestId('track-expand-F3'))
    expect(screen.getByTestId('track-F4')).toHaveStyle({ height: '64px' })
    expect(screen.getByTestId('track-F3')).toHaveStyle({ height: '592px' })

    await user.click(screen.getByTestId('track-expand-F3'))
    expect(screen.getByTestId('track-F3')).toHaveStyle({ height: '64px' })
    expect(screen.getByTestId('track-expand-F3')).toHaveAttribute('data-expanded', 'false')
  })

  it('клик по названию канала открывает его в разделе «ЭЭГ» (срез 5)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4'] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    renderWithProviders(
      <Routes>
        <Route path="/edf" element={<TrackStack signal={frameFixture()} />} />
        <Route path="/eeg" element={<p>раздел «ЭЭГ»</p>} />
      </Routes>,
      { route: '/edf' },
    )

    await user.click(screen.getByTestId('track-label-F4'))

    // Название — это выбор канала: он уезжает в «ЭЭГ» явно, а не «если там пусто»
    expect(useEegParams.getState().params.channel).toBe('F4')
    expect(screen.getByText('раздел «ЭЭГ»')).toBeInTheDocument()
    // Переход — смена раздела: обработку он не запускает
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('нажатие и движение по названию канала не начинают панораму (срез 5)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4'] })
    // В jsdom метода может не быть — определяем сами. Проверяем первопричину сбоя:
    // контейнер **не должен** захватывать указатель, если жест начался на кнопке.
    // Захват отдаёт `click` контейнеру (общий предок pointerdown/pointerup), и
    // кнопка теряет свой обработчик — на экране это «переход в „ЭЭГ“ не работает».
    const proto = Element.prototype as unknown as { setPointerCapture?: (id: number) => void }
    const original = proto.setPointerCapture
    const capture = vi.fn()
    proto.setPointerCapture = capture
    try {
      renderWithProviders(<TrackStack signal={frameFixture()} />)

      await user.pointer([
        {
          keys: '[MouseLeft>]',
          target: screen.getByTestId('track-label-F4'),
          coords: { clientX: 100, clientY: 20 },
        },
        { coords: { clientX: 220, clientY: 20 } },
        { keys: '[/MouseLeft]', coords: { clientX: 220, clientY: 20 } },
      ])

      expect(capture).not.toHaveBeenCalled()
      // Окно не сдвинулось: движение по подписи — не панорама
      expect(screen.getByText('Окно 0.00–10.00 с')).toBeInTheDocument()
    } finally {
      if (original) proto.setPointerCapture = original
      else delete proto.setPointerCapture
    }
  })

  it('скрытый в панели канал сбрасывает разворот трека', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4'] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    await user.click(screen.getByTestId('track-expand-F4'))
    expect(screen.getByTestId('track-F4')).toHaveStyle({ height: '592px' })

    act(() => useEdfParams.getState().toggleChannel('F4'))
    expect(screen.queryByTestId('track-F4')).not.toBeInTheDocument()

    act(() => useEdfParams.getState().toggleChannel('F4'))
    expect(screen.getByTestId('track-F4')).toHaveStyle({ height: '64px' })
  })

  it('панорама копит движение за жест и рендерит стек по кадру (P1)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3'], timeLevel: 2 })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    const region = screen.getByRole('region', { name: 'Треки ЭЭГ' })
    // jsdom не считает раскладку: ширину области задаём сами (1024 − 56 − 8 = 960 px)
    Object.defineProperty(region, 'clientWidth', { value: 1024, configurable: true })

    // Окно ×4: 10 с / 4 = 2.5 с (3.75–6.25)
    expect(screen.getByText('Окно 3.75–6.25 с')).toBeInTheDocument()
    perfReset()

    // Два сдвига по 96 px = 0.25 с каждый: окно сдвигается на 0.5 с целиком, а не
    // на один шаг — раньше переподписка слушателей сбрасывала жест после первого
    // движения, и «хвост» панорамы терялся (P5)
    await user.pointer([
      { keys: '[MouseLeft>]', target: region, coords: { clientX: 300, clientY: 40 } },
      { coords: { clientX: 396, clientY: 40 } },
      { coords: { clientX: 492, clientY: 40 } },
      { keys: '[/MouseLeft]', coords: { clientX: 492, clientY: 40 } },
    ])

    expect(screen.getByText('Окно 3.25–5.75 с')).toBeInTheDocument()
    // Кадр панорамы — счётчик P0: перерисовка сведена к кадрам, а не к событиям мыши
    const panFrames = perfStats().find((stat) => stat.name === 'edf.pan.frame')
    expect(panFrames?.count).toBeGreaterThan(0)
    expect(panFrames?.count).toBeLessThanOrEqual(3)
  })

  it('клик по треку не пересчитывает огибающие каналов (P4)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'], timeLevel: 0 })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    const region = screen.getByRole('region', { name: 'Треки ЭЭГ' })
    region.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1024, height: 600, right: 1024, bottom: 600 }) as DOMRect
    perfReset()

    await user.pointer({ keys: '[MouseLeft]', target: region, coords: { clientX: 300, clientY: 40 } })

    // Курсор — только отрисовка: окно то же, значит огибающие не пересчитываются
    expect(screen.getByText('2.500 с')).toBeInTheDocument()
    expect(perfStats().find((stat) => stat.name === 'edf.envelope.recompute')).toBeUndefined()
  })

  it('разворот трека не пересобирает чарт: размер идёт через setSize (P1)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(uplotCharts()).toHaveLength(1)
    const chart = uplotCharts()[0] as MockUPlotChart

    await user.click(screen.getByTestId('track-expand-F3'))

    // Чарт тот же: пересоздание добавило бы в список второй, а старый уничтожило
    expect(uplotCharts()).toHaveLength(1)
    expect(chart.destroy).not.toHaveBeenCalled()
    // Ширина области треков: 1024 − 56 (подписи) − 8 (зазор), высота — видимой области
    expect(chart.setSize).toHaveBeenCalledWith({ width: 960, height: 592 })
  })

  it('клик по треку ставит курсор, а не гонится за мышью (срез 2.9)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3'], timeLevel: 0 })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    const region = screen.getByRole('region', { name: 'Треки ЭЭГ' })
    region.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1024, height: 600, right: 1024, bottom: 600 }) as DOMRect

    expect(screen.queryByText(/^\d+\.\d{3} с$/)).not.toBeInTheDocument()

    // Колонка подписей 56 px + зазор 4 px: clientX 300 → 240/960 = четверть окна 10 с
    await user.pointer({ keys: '[MouseLeft]', target: region, coords: { clientX: 300, clientY: 40 } })

    expect(screen.getByText('2.500 с')).toBeInTheDocument()

    // Курсор остаётся на месте: мышь уходит, линия не следует за ней
    await user.hover(screen.getByTestId('track-F3'))
    expect(screen.getByText('2.500 с')).toBeInTheDocument()
  })

  it('курсор тянется на весь стек и живёт в прокручиваемом контенте (срез 2.11)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4', 'C3'], timeLevel: 0 })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    const region = screen.getByRole('region', { name: 'Треки ЭЭГ' })
    region.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1024, height: 600, right: 1024, bottom: 600 }) as DOMRect

    await user.pointer({ keys: '[MouseLeft]', target: region, coords: { clientX: 300, clientY: 40 } })

    const content = screen.getByTestId('viewer-content')
    const line = screen.getByTestId('cursor-line')
    // Линия — ребёнок прокручиваемого контента, а не самого скролл-контейнера:
    // иначе при прокрутке треков вниз она «уезжала» на высоту видимой области
    // и обрывалась на середине стека (замечание ручного просмотра)
    expect(line.parentElement).toBe(content)
    expect(line.className).toContain('inset-y-0')

    // Подпись времени липнет к верху видимой области: время видно при скролле
    const label = screen.getByTestId('cursor-time')
    expect(content.contains(label)).toBe(true)
    expect(label.parentElement?.className).toContain('sticky')
  })

  it('команда навигации из шапки листает окно без запросов к серверу (срез 2.9)', () => {
    paramsState({ visibleChannels: ['F3'], timeLevel: 2 })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.getByText('Окно 3.75–6.25 с')).toBeInTheDocument()

    act(() => useEdfRecording.getState().requestNav('end'))
    expect(screen.getByText('Окно 7.50–10.00 с')).toBeInTheDocument()

    // «Назад на ширину окна»: 8.75 − 2.5 = 6.25 → 5.00–7.50 с
    act(() => useEdfRecording.getState().requestNav('prev'))
    expect(screen.getByText('Окно 5.00–7.50 с')).toBeInTheDocument()

    act(() => useEdfRecording.getState().requestNav('start'))
    expect(screen.getByText('Окно 0.00–2.50 с')).toBeInTheDocument()

    // Навигация — только перерисовка окна: данные уже в браузере
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('правка параметров вьюера не запускает обработку (только состояние)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3', 'F4'] })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    renderWithProviders(<TrackStack signal={frameFixture()} />)
    await user.click(screen.getByTestId('track-expand-F3'))

    // Разворот трека — тоже параметр отрисовки: обработку он не запускает
    expect(screen.getByTestId('track-F3')).toHaveStyle({ height: '592px' })
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
    // Ручные пометки эпох живут в сторе записи: тесты не должны видеть чужие
    useEdfRecording.setState({ epochMarks: [] })
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
      epochLengthMs: null,
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

  it('демо-кадру без пропа даёт фикстуру под длину сигнала', () => {
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.getByTestId('track-layers')).toBeInTheDocument()
    expect(screen.getByText('слои: демо-фикстура')).toBeInTheDocument()
    // Фикстура даёт минимум две зоны каждого типа — легенда не пустая
    expect(screen.getByTestId('legend-ica_eog').textContent).toMatch(/[2-4]/)
  })

  it('кадру записи без пропа слоёв не рисует: фикстура только демо', () => {
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={decimatedFrameFixture()} />)

    // У записи до первого расчёта нет ни зон, ни легенды, ни подписи «слои:»
    expect(screen.queryByTestId(/^zone-/)).not.toBeInTheDocument()
    expect(screen.queryByTestId(/^legend-/)).not.toBeInTheDocument()
    expect(screen.queryByTestId(/^epoch-hatch-/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^слои:/)).not.toBeInTheDocument()
    // Сетка эпох — геометрия по параметру панели, а не результат: она остаётся
    expect(screen.getByTestId('epoch-edge-1')).toBeInTheDocument()
  })

  it('результат расчёта помечается в подписи иначе, чем фикстура', () => {
    paramsState({ visibleChannels: ['F3'] })
    const layers: EdfViewerLayers = { ...layersFixture(), source: 'result' }
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layers} />)

    expect(screen.getByText('слои: результат расчёта')).toBeInTheDocument()
  })

  it('Ctrl+двойной клик блокирует эпоху под курсором, повторный — снимает правку', () => {
    paramsState({ visibleChannels: ['F3'], epochLengthMs: 2000 })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    const region = screen.getByRole('region', { name: 'Треки ЭЭГ' })
    region.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1024, height: 600, right: 1024, bottom: 600 }) as DOMRect

    // Без Ctrl правки не ставим: одиночный клик — это курсор
    fireEvent.doubleClick(region, { clientX: 492, clientY: 40 })
    expect(useEdfRecording.getState().epochMarks).toEqual([])

    // 10 с, 2 с/эпоха: clientX 492 → 4.5 с — эпоха 2 (4–6 с), алгоритм её не отбрасывал
    fireEvent.doubleClick(region, { ctrlKey: true, clientX: 492, clientY: 40 })

    expect(useEdfRecording.getState().epochMarks).toEqual([
      { onsetSec: 4, durationSec: 2, blocked: true },
    ])
    expect(screen.getByTestId('epoch-hatch-2')).toHaveAttribute('data-manual', 'blocked')
    expect(screen.getByText('ручных пометок: 1')).toBeInTheDocument()

    // Повторный Ctrl+двойной клик возвращает вердикт алгоритма: правки нет,
    // штриховки тоже (эпоху алгоритм не отбрасывал)
    fireEvent.doubleClick(region, { ctrlKey: true, clientX: 492, clientY: 40 })
    expect(useEdfRecording.getState().epochMarks).toEqual([])
    expect(screen.queryByTestId('epoch-hatch-2')).not.toBeInTheDocument()
    expect(screen.queryByText('ручных пометок: 1')).not.toBeInTheDocument()
  })

  it('Ctrl+двойной клик снимает штриховку эпохи, отброшенной reject-фильтром', () => {
    paramsState({ visibleChannels: ['F3'], epochLengthMs: 2000 })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    const region = screen.getByRole('region', { name: 'Треки ЭЭГ' })
    region.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1024, height: 600, right: 1024, bottom: 600 }) as DOMRect

    // Эпоха 1 (2–4 с) отброшена фикстурой результата — штриховка есть
    expect(screen.getByTestId('epoch-hatch-1')).toBeInTheDocument()

    // clientX 252 → 2.0 с — ровно начало эпохи 1
    fireEvent.doubleClick(region, { ctrlKey: true, clientX: 252, clientY: 40 })

    expect(useEdfRecording.getState().epochMarks).toEqual([
      { onsetSec: 2, durationSec: 2, blocked: false },
    ])
    const hatch = screen.getByTestId('epoch-hatch-1')
    expect(hatch).toHaveAttribute('data-manual', 'allowed')
    // Разблокировано вручную — штриховки нет, остался только контур правки
    expect(hatch.style.backgroundImage).toBe('')
  })

  it('ручная пометка видна, даже когда штриховка эпох выключена', () => {
    paramsState({ visibleChannels: ['F3'], epochLengthMs: 2000, droppedEpochsHatched: false })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    // Пока правок нет, слой эпох молчит: тумблеры не включены
    expect(screen.queryByTestId('epoch-hatch-1')).not.toBeInTheDocument()

    act(() => useEdfRecording.getState().toggleEpochBlock({ onsetSec: 0, durationSec: 2 }, false))

    expect(screen.getByTestId('epoch-hatch-0')).toHaveAttribute('data-manual', 'blocked')
  })

  it('сетка эпох берётся из результата, а не из параметра панели (срез 2.10)', () => {
    paramsState({ visibleChannels: ['F3'], epochLengthMs: 500, droppedEpochsHatched: true })
    const layers: EdfViewerLayers = {
      ...layersFixture(),
      source: 'result',
      rejectedEpochs: [4],
      epochLengthMs: 2000,
    }
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layers} />)

    // Результат нарезан по 2 с: штриховка осталась на интервале 8–10 с,
    // а не «переехала» на пятую эпоху сетки 500 мс (2.0–2.5 с)
    expect(screen.getByTestId('epoch-hatch-4')).toBeInTheDocument()
    expect(screen.queryByTestId('epoch-hatch-8')).not.toBeInTheDocument()
    // И вьюер честно говорит, что разметка построена по другой длине эпохи
    expect(screen.getByText('разметка эпох: 2000 мс')).toBeInTheDocument()
  })

  it('счётчик ручных пометок считает пометки, а не ячейки сетки (срез 2.11)', () => {
    // Сетка 500 мс, а пометки поставлены на нарезке 2 с: одна правка накрывает
    // четыре эпохи новой нарезки, но штриховки сливаются в одну видимую полосу
    paramsState({ visibleChannels: ['F3'], epochLengthMs: 500, droppedEpochsHatched: true })
    act(() =>
      useEdfRecording.setState({
        epochMarks: [
          { onsetSec: 2, durationSec: 2, blocked: true },
          { onsetSec: 6, durationSec: 2, blocked: true },
        ],
      }),
    )
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    const hatched = screen
      .getByRole('region', { name: 'Треки ЭЭГ' })
      .querySelectorAll('[data-testid^="epoch-hatch"][data-manual]')
    // Ячеек со штриховкой восемь, а пометок две — счётчик не «размножает» правки
    expect(hatched).toHaveLength(8)
    expect(screen.getByText('ручных пометок: 2')).toBeInTheDocument()
    expect(screen.queryByText('ручных пометок: 8')).not.toBeInTheDocument()
  })

  it('детали зоны не уезжают за верх области при прокрутке треков (срез 2.11)', async () => {
    const user = userEvent.setup()
    paramsState({ visibleChannels: ['F3'] })
    renderWithProviders(<TrackStack signal={frameFixture()} layers={layersFixture()} />)

    await user.click(screen.getByTestId('zone-zscore_outlier-1'))

    const details = screen.getByTestId('zone-details')
    expect(screen.getByTestId('viewer-content').contains(details)).toBe(true)
    // Карточка «липнет» к верху области, а её кнопки остаются кликабельными:
    // контейнер событий не ловит, карточка — ловит
    expect(details.parentElement?.className).toContain('sticky')
    expect(details.className).toContain('pointer-events-auto')
  })
})

/**
 * Экспорт окна (срез 2.8) — кнопки в полосе вьюера. Проверяем связку
 * «видимые каналы → доступность кнопки»: без данных экспортировать нечего,
 * и вьюер не запускает никаких запросов (экспорт клиентский).
 */
describe('экспорт окна вьюера', () => {
  beforeEach(() => {
    uplotCharts().length = 0
    localStorage.clear()
  })

  it('держит кнопки PNG и CSV в полосе окна и включает их при видимых каналах', () => {
    paramsState({ visibleChannels: ['F3', 'F4'] })
    const { unmount } = renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.getByRole('button', { name: 'Скачать PNG окна' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Скачать CSV окна' })).toBeEnabled()
    unmount()

    paramsState({ visibleChannels: [] })
    renderWithProviders(<TrackStack signal={frameFixture()} />)

    expect(screen.getByRole('button', { name: 'Скачать PNG окна' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Скачать CSV окна' })).toBeDisabled()
  })
})

