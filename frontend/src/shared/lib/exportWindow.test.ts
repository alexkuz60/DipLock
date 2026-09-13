/**
 * Тесты экспорта окна (срез 2.8): CSV, имя файла, шкала времени, геометрия
 * слоёв и сборка PNG-снапшота.
 *
 * jsdom не умеет 2D-canvas, поэтому `getContext` подменяется заглушкой: тесты
 * проверяют, что и куда рисуется (drawImage по треку, заливки зон/эпох), а не
 * пиксели. Вся арифметика (CSV, окно, обрезка слоёв) — чистые функции.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import {
  CSV_HEADER,
  drawSnapshot,
  epochMarks,
  exportFileName,
  formatSeconds,
  SNAPSHOT_SIZES,
  snapshotLayout,
  timeTicks,
  windowCsv,
  withAlpha,
  zoneRects,
} from '@/shared/lib/exportWindow'
import { buildEpochCells, type ArtifactZone } from '@/shared/lib/viewerLayers'

/** Кадр огибающей: 10 корзин по 1 с за 10 с, min/max = ±amp канала. */
function decimatedFrame(): SignalFrame {
  const nPoints = 10
  const durationSec = 10
  const times = new Float32Array(nPoints)
  for (let i = 0; i < nPoints; i++) times[i] = i + 0.5
  const channels = ['F3', 'F4']
  const min: Record<string, Float32Array> = {}
  const max: Record<string, Float32Array> = {}
  channels.forEach((name, channelIndex) => {
    const lo = new Float32Array(nPoints)
    const hi = new Float32Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      lo[i] = -(i + 1) - channelIndex
      hi[i] = i + 1 + channelIndex
    }
    min[name] = lo
    max[name] = hi
  })
  return { sourceId: 'rec-1', channels, durationSec, times, min, max, decimated: true, level: 2 }
}

describe('CSV окна', () => {
  it('пишет строку на (корзина × канал) в порядке каналов', () => {
    const csv = windowCsv(decimatedFrame(), { t0: 0, t1: 10 }, ['F3', 'F4'])
    const lines = csv.trimEnd().split('\n')

    expect(lines[0]).toBe(CSV_HEADER)
    // 10 корзин × 2 канала
    expect(lines).toHaveLength(1 + 20)
    expect(lines[1]).toBe('0.500,F3,-1.0000,1.0000')
    expect(lines[2]).toBe('0.500,F4,-2.0000,2.0000')
    expect(lines[3]).toBe('1.500,F3,-2.0000,2.0000')
    expect(csv.endsWith('\n')).toBe(true)
  })

  it('обрезает CSV по окну и пропускает каналы, которых нет в кадре', () => {
    const csv = windowCsv(decimatedFrame(), { t0: 2, t1: 5 }, ['F3', 'Cz'])
    const lines = csv.trimEnd().split('\n')

    // Корзины 2.5, 3.5, 4.5 — границы окна включительно
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual(['2.500', '3.500', '4.500'])
    expect(lines.every((line) => !line.includes('Cz'))).toBe(true)
  })

  it('окно вне кадра даёт только заголовок и не падает', () => {
    const csv = windowCsv(decimatedFrame(), { t0: 100, t1: 200 }, ['F3'])
    expect(csv).toBe(`${CSV_HEADER}\n`)

    const empty = windowCsv(decimatedFrame(), { t0: 0, t1: 10 }, [])
    expect(empty).toBe(`${CSV_HEADER}\n`)
  })

  it('не выдаёт −0.0000 вместо нуля', () => {
    const frame = decimatedFrame()
    frame.min.F3 = Float32Array.from({ length: 10 }, () => -0)
    const csv = windowCsv(frame, { t0: 0, t1: 1 }, ['F3'])
    expect(csv.split('\n')[1]).toBe('0.500,F3,0.0000,1.0000')
  })
})

describe('имя файла экспорта', () => {
  it('собирает имя с окном и уровнем пирамиды', () => {
    expect(exportFileName('probe.edf', { t0: 1.5, t1: 30 }, 2, 'csv')).toBe(
      'probe-win1.50-30.00s-level2.csv',
    )
    // Демо-сигнал (уровень 0) — это полный сигнал, а не «уровень 0»
    expect(exportFileName('demo', { t0: 0, t1: 10 }, 0, 'png')).toBe('demo-win0.00-10.00s-full.png')
  })

  it('санитизирует имя записи: экспорт не пишет за пределы каталога загрузок', () => {
    const name = exportFileName('../../etc/pa ss word.edf', { t0: 0, t1: 1 }, 1, 'csv')
    expect(name).not.toMatch(/[/\\]/)
    expect(name.endsWith('.csv')).toBe(true)
    expect(name.startsWith('..')).toBe(false)
  })

  it('пустое имя превращается в запись по умолчанию', () => {
    expect(exportFileName('   ', { t0: 0, t1: 1 }, 1, 'csv')).toBe(
      'recording-win0.00-1.00s-level1.csv',
    )
  })
})

describe('шкала времени снапшота', () => {
  it('выбирает «круглый» шаг и держит деления внутри окна', () => {
    const ticks = timeTicks({ t0: 0, t1: 10 }, 1000)
    expect(ticks.map((tick) => tick.label)).toEqual([
      '0.00 с',
      '2.00 с',
      '4.00 с',
      '6.00 с',
      '8.00 с',
      '10.00 с',
    ])
    // Пиксели: 0 и 1000 по краям окна, позиции возрастают
    expect(ticks[0]!.x).toBe(0)
    expect(ticks.at(-1)!.x).toBe(1000)
    expect(ticks[1]!.x).toBeCloseTo(200)
  })

  it('на узком окне переходит на доли секунды', () => {
    const ticks = timeTicks({ t0: 0.2, t1: 0.4 }, 100)
    expect(ticks.length).toBeGreaterThan(2)
    expect(ticks[0]!.label).toBe('0.200 с')
    expect(ticks.every((tick) => tick.x >= 0 && tick.x <= 100)).toBe(true)
  })

  it('вырожденное окно не даёт делений', () => {
    expect(timeTicks({ t0: 5, t1: 5 }, 500)).toEqual([])
    expect(timeTicks({ t0: 0, t1: 10 }, 0)).toEqual([])
  })

  it('форматирует секунды по ширине окна', () => {
    expect(formatSeconds(0.125)).toBe('0.125 с')
    expect(formatSeconds(12.5)).toBe('12.50 с')
    expect(formatSeconds(125)).toBe('125.0 с')
  })
})

describe('раскладка и геометрия снапшота', () => {
  it('считает высоту по числу треков и не добавляет подвал пустой картинке', () => {
    const layout = snapshotLayout(3, 600)
    expect(layout.trackTops).toEqual([
      SNAPSHOT_SIZES.headerHeight,
      SNAPSHOT_SIZES.headerHeight + SNAPSHOT_SIZES.trackHeight,
      SNAPSHOT_SIZES.headerHeight + 2 * SNAPSHOT_SIZES.trackHeight,
    ])
    expect(layout.height).toBe(
      SNAPSHOT_SIZES.headerHeight + 3 * SNAPSHOT_SIZES.trackHeight + SNAPSHOT_SIZES.footerHeight,
    )
    expect(layout.width).toBe(SNAPSHOT_SIZES.labelWidth + SNAPSHOT_SIZES.padding * 2 + 600)

    expect(snapshotLayout(0, 600).height).toBe(SNAPSHOT_SIZES.headerHeight)
    expect(snapshotLayout(0, 600).trackTops).toEqual([])
  })

  function zone(patch: Partial<ArtifactZone> = {}): ArtifactZone {
    return {
      id: 'z-1',
      kind: 'peak_to_peak',
      onsetSec: 2,
      durationSec: 1,
      channels: ['F3'],
      ...patch,
    }
  }

  it('обрезает зоны по окну и не рисует то, что за ним', () => {
    const window = { t0: 0, t1: 10 }
    const rects = zoneRects(
      [
        zone(), // внутри окна
        zone({ id: 'z-2', onsetSec: -5, durationSec: 6 }), // заходит слева
        zone({ id: 'z-3', onsetSec: 50, durationSec: 1 }), // вне окна
        zone({ id: 'z-4', onsetSec: 5, durationSec: 0.001 }), // слишком узкая
      ],
      window,
      1000,
    )

    expect(rects).toHaveLength(3)
    expect(rects[0]).toMatchObject({ x: 200, width: 100, kind: 'peak_to_peak' })
    expect(rects[1]).toMatchObject({ x: 0, width: 100 })
    // Короткий всплеск не исчезает: минимальная ширина 2 px
    expect(rects[2]!.width).toBe(2)
  })

  it('сетка эпох зависит от тумблеров вьюера', () => {
    const cells = buildEpochCells(10, 1000, [1, 3])
    const window = { t0: 0, t1: 10 }

    const all = epochMarks(cells, window, 1000, { boundaries: true, dropped: true })
    // Первая эпоха начинается с края окна — лишней линии на краю нет
    expect(all.boundaries).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900])
    expect(all.dropped.map((rect) => rect.x)).toEqual([100, 300])

    const none = epochMarks(cells, window, 1000, { boundaries: false, dropped: false })
    expect(none.boundaries).toEqual([])
    expect(none.dropped).toEqual([])
  })

  it('обрезает отброшенную эпоху, заходящую за левый край окна', () => {
    const cells = buildEpochCells(10, 1000, [0, 1])
    const marks = epochMarks(cells, { t0: 1.5, t1: 10 }, 850, { boundaries: false, dropped: true })
    // Эпоха 0 (0–1 с) вне окна; эпоха 1 (1–2 с) видна частично
    expect(marks.dropped).toHaveLength(1)
    expect(marks.dropped[0]!.x).toBe(0)
    expect(marks.dropped[0]!.width).toBeCloseTo(50)
  })

  it('withAlpha превращает токен темы в rgba и зажимает прозрачность', () => {
    expect(withAlpha('#ff7b72', 0.18)).toBe('rgba(255, 123, 114, 0.18)')
    expect(withAlpha('#ff7b72', 5)).toBe('rgba(255, 123, 114, 1)')
    expect(withAlpha('#ff7b72', -1)).toBe('rgba(255, 123, 114, 0)')
    // Не hex (например, уже готовый rgba) — отдаём как есть
    expect(withAlpha('rgb(1,2,3)', 0.5)).toBe('rgb(1,2,3)')
  })
})

/** Заглушка 2D-контекста: jsdom без пакета `canvas` его не создаёт. */
function fakeContext() {
  const calls: { drawImage: unknown[][]; fillRect: unknown[][] } = { drawImage: [], fillRect: [] }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'top' as CanvasTextBaseline,
    fillRect: vi.fn((...args: unknown[]) => calls.fillRect.push(args)),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 20 }) as TextMetrics),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    drawImage: vi.fn((...args: unknown[]) => calls.drawImage.push(args)),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

describe('сборка PNG-снапшота', () => {
  it('без 2D-контекста возвращает пустой холст нужного размера, а не падает', () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

    const canvas = drawSnapshot({
      title: 'probe.edf',
      subtitle: 'Окно 0.00–10.00 с',
      window: { t0: 0, t1: 10 },
      trackWidth: 600,
      tracks: [
        { name: 'F3', canvas: null },
        { name: 'F4', canvas: null },
      ],
      zones: [],
      epochs: [],
      showZones: true,
      showEpochBoundaries: true,
      showDroppedEpochs: true,
      scaleLabel: 'общая шкала ±100 мкВ',
    })

    expect(canvas.width).toBe(SNAPSHOT_SIZES.labelWidth + SNAPSHOT_SIZES.padding * 2 + 600)
    expect(canvas.height).toBe(
      SNAPSHOT_SIZES.headerHeight + 2 * SNAPSHOT_SIZES.trackHeight + SNAPSHOT_SIZES.footerHeight,
    )
    spy.mockRestore()
  })

  it('кладёт canvas трека на его место и заливает зоны только при включённых слоях', () => {
    const { ctx, calls } = fakeContext()
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    const track = document.createElement('canvas')

    drawSnapshot({
      title: 'probe.edf',
      subtitle: 'Окно 0.00–10.00 с',
      window: { t0: 0, t1: 10 },
      trackWidth: 600,
      tracks: [{ name: 'F3', canvas: track }],
      zones: [
        { id: 'z-1', kind: 'zscore_outlier', onsetSec: 1, durationSec: 1, channels: ['F3'] },
      ],
      epochs: buildEpochCells(10, 1000, [0]),
      showZones: false,
      showEpochBoundaries: true,
      showDroppedEpochs: true,
      scaleLabel: 'общая шкала ±100 мкВ',
    })

    // Один трек — один drawImage, в область треков (после колонки подписей)
    expect(calls.drawImage).toHaveLength(1)
    expect(calls.drawImage[0]).toEqual([
      track,
      SNAPSHOT_SIZES.labelWidth + SNAPSHOT_SIZES.padding,
      SNAPSHOT_SIZES.headerHeight,
      600,
      SNAPSHOT_SIZES.trackHeight,
    ])
    // Зоны выключены: по трекам залита только отброшенная эпоха (высота трека)
    const overTracks = calls.fillRect.filter((args) => args[3] === SNAPSHOT_SIZES.trackHeight)
    expect(overTracks).toHaveLength(1)
    spy.mockRestore()
  })

  it('при включённых слоях заливает зоны артефактов', () => {
    const { ctx, calls } = fakeContext()
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)

    drawSnapshot({
      title: 'probe.edf',
      subtitle: 'Окно 0.00–10.00 с',
      window: { t0: 0, t1: 10 },
      trackWidth: 600,
      tracks: [{ name: 'F3', canvas: null }],
      zones: [
        { id: 'z-1', kind: 'zscore_outlier', onsetSec: 1, durationSec: 1, channels: ['F3'] },
        { id: 'z-2', kind: 'flat_line', onsetSec: 4, durationSec: 1, channels: ['F3'] },
      ],
      epochs: [],
      showZones: true,
      showEpochBoundaries: false,
      showDroppedEpochs: false,
      scaleLabel: 'общая шкала ±100 мкВ',
    })

    // По трекам залиты обе зоны (высота = высота трека)…
    const overTracks = calls.fillRect.filter((args) => args[3] === SNAPSHOT_SIZES.trackHeight)
    expect(overTracks).toHaveLength(2)
    // …а надписи легенды — маленькие квадратики (высота 8 px)
    const swatches = calls.fillRect.filter((args) => args[3] === 8)
    expect(swatches).toHaveLength(2)
    spy.mockRestore()
  })
})