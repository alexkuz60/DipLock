/**
 * Тесты трекера «Нейромузыки»: бабочка (левый вверх / правый вниз), окно
 * зума с якорем, линейка времени, позиционер и отрисовка на фейковом 2D-контексте.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  drawButterfly,
  drawPlayhead,
  filePeaks,
  formatTime,
  peakColumns,
  rulerTicks,
  timeToX,
  viewWindow,
  xToTime,
  type TrackerTheme,
} from './waveformView'

const THEME: TrackerTheme = {
  waveUp: '#4da3ff',
  waveDown: '#b98cff',
  zero: '#c3ceda',
  grid: '#2c3a4d',
  text: '#8695a8',
  playhead: '#e8eef6',
}

/** Фейковый 2D-контекст: jsdom без пакета canvas не даёт настоящий. */
function fakeCtx() {
  const moves: number[][] = []
  const lines: number[][] = []
  /** Журнал штрихов: точка lineTo и момент stroke — проверяется порядок. */
  const journal: string[] = []
  /** Цвет strokeStyle в момент каждого штриха. */
  const styles: string[] = []
  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => moves.push([x, y])),
    lineTo: vi.fn((x: number, y: number) => {
      lines.push([x, y])
      journal.push(`L:${x},${y}`)
    }),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 6 })),
    setTransform: vi.fn(),
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textBaseline: '',
    textAlign: '',
  }
  // Снимок цвета в момент штриха: разные цвета полуволн — контракт рендера.
  ctx.stroke.mockImplementation(() => {
    journal.push('S')
    styles.push(ctx.strokeStyle)
  })
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    moves,
    lines,
    journal,
    styles,
    raw: ctx,
  }
}

describe('waveformView — бабочка и пики', () => {
  it('вверх идёт только положительная полуволна левого, вниз — только отрицательная правого', () => {
    const left = new Float32Array([0.5, -1])
    const right = new Float32Array([-0.75, 0.9])
    const peaks = filePeaks(left, right, 2)
    // Колонка 0: левый +0.5 вверх, правый −0.75 вниз (модуль).
    expect(peaks.up[0]).toBeCloseTo(0.5)
    expect(peaks.down[0]).toBeCloseTo(0.75)
    // Колонка 1: у левого нет положительных, у правого нет отрицательных.
    expect(peaks.up[1]).toBe(0)
    expect(peaks.down[1]).toBe(0)
    expect(peaks.maxUp).toBeCloseTo(0.5)
    expect(peaks.maxDown).toBeCloseTo(0.75)
  })

  it('колонки покрывают весь файл без провалов (границы стыкуются)', () => {
    const left = new Float32Array(7).fill(1)
    const right = new Float32Array(7).fill(-1)
    const peaks = filePeaks(left, right, 3)
    expect(peaks.up).toHaveLength(3)
    // 7 отсчётов на 3 колонки: 2+2+3 — пустых колонок нет.
    expect([...peaks.up]).toEqual([1, 1, 1])
    expect([...peaks.down]).toEqual([1, 1, 1])
  })

  it('peakColumns: ширина × зум, но не больше числа отсчётов и не меньше 1', () => {
    expect(peakColumns(100, 10, 1_000_000)).toBe(1000)
    expect(peakColumns(100, 100, 50)).toBe(50)
    expect(peakColumns(0, 1, 50)).toBe(1)
  })
})

describe('waveformView — окно зума', () => {
  it('×1 — весь файл целиком, независимо от якоря', () => {
    expect(viewWindow(120, 1, 37)).toEqual({ start: 0, end: 120 })
  })

  it('×10 — окно duration/10, якорь в центре (первый расчёт)', () => {
    const view = viewWindow(100, 10, 50)
    expect(view.start).toBeCloseTo(45)
    expect(view.end).toBeCloseTo(55)
  })

  it('окно держится, пока якорь внутри внутренней зоны, и прыгает у края', () => {
    const first = viewWindow(100, 10, 50) // старт 45, ширина 10
    // Якорь внутри 15…85 % окна (46.5…53.5) — окно не двигается.
    const held = viewWindow(100, 10, 53, first.start)
    expect(held.start).toBeCloseTo(45)
    // Якорь вышел за внутреннюю зону — окно центрируется заново.
    const jumped = viewWindow(100, 10, 70, first.start)
    expect(jumped.start).toBeCloseTo(65)
  })

  it('у краёв файла окно не вылезает за границы', () => {
    expect(viewWindow(100, 10, 0).start).toBe(0)
    const end = viewWindow(100, 10, 100)
    expect(end.end).toBeCloseTo(100)
    expect(end.start).toBeCloseTo(90)
  })

  it('нулевая длительность — пустое окно, а не NaN', () => {
    expect(viewWindow(0, 1, 0)).toEqual({ start: 0, end: 0 })
  })

  it('timeToX и xToTime — обратимая пара', () => {
    const view = { start: 10, end: 20 }
    expect(timeToX(15, view, 200)).toBeCloseTo(100)
    expect(xToTime(100, view, 200)).toBeCloseTo(15)
    expect(timeToX(15, { start: 5, end: 5 }, 200)).toBe(0)
  })
})

describe('waveformView — линейка и таймкод', () => {
  it('деления попадают в окно и подписаны форматом М:СС', () => {
    const ticks = rulerTicks({ start: 0, end: 60 }, 6)
    expect(ticks.length).toBeGreaterThan(1)
    for (const tick of ticks) {
      expect(tick.time).toBeGreaterThanOrEqual(0)
      expect(tick.time).toBeLessThanOrEqual(60)
      expect(tick.label).toMatch(/^\d+:\d{2}$/)
    }
  })

  it('узкое окно ×100 даёт шаг меньше секунды и подписи с десятыми', () => {
    const ticks = rulerTicks({ start: 0, end: 1.2 }, 6)
    expect(ticks.some((tick) => tick.label.includes('.'))).toBe(true)
  })

  it('formatTime: минуты, ведущие нули и десятые', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(65.4, true)).toBe('1:05.4')
    expect(formatTime(-3)).toBe('0:00')
  })
})

describe('waveformView — отрисовка на фейковом контексте', () => {
  it('drawButterfly без пиков рисует только линию нуля', () => {
    const { ctx, raw } = fakeCtx()
    drawButterfly(ctx, null, { start: 0, end: 4 }, 4, 100, 100, THEME)
    expect(raw.clearRect).toHaveBeenCalledWith(0, 0, 100, 100)
    expect(raw.stroke).toHaveBeenCalledTimes(1)
    expect(raw.moveTo).toHaveBeenCalledWith(0, 50.5)
    expect(raw.lineTo).toHaveBeenCalledWith(100, 50.5)
  })

  it('drawButterfly: пики левого канала уходят вверх, правого — вниз от нуля', () => {
    const { ctx, lines, raw } = fakeCtx()
    const peaks = {
      up: new Float32Array([1, 0]),
      down: new Float32Array([0, 1]),
      maxUp: 1,
      maxDown: 1,
    }
    drawButterfly(ctx, peaks, { start: 0, end: 4 }, 4, 100, 100, THEME)
    // mid = 50.5, шкала = (100/2 − 1)/1 = 49 → вверх до 1.5, вниз до 99.5.
    expect(lines).toContainEqual([25, 1.5])
    expect(lines).toContainEqual([75, 99.5])
    // Три штриха: верх (левый), низ (правый), линия нуля поверх.
    expect(raw.stroke).toHaveBeenCalledTimes(3)
  })

  it('линия нуля — последним штрихом поверх волны (уточнение владельца)', () => {
    const { ctx, journal } = fakeCtx()
    const peaks = {
      up: new Float32Array([1, 0]),
      down: new Float32Array([0, 1]),
      maxUp: 1,
      maxDown: 1,
    }
    drawButterfly(ctx, peaks, { start: 0, end: 4 }, 4, 100, 100, THEME)
    // Порядок: вверх (левый), вниз (правый), затем ноль (lineTo по середине).
    expect(journal).toEqual(['L:25,1.5', 'S', 'L:75,99.5', 'S', 'L:100,50.5', 'S'])
  })

  it('полуволны каналов — разные цвета, ноль — своим', () => {
    const { ctx, styles } = fakeCtx()
    const peaks = {
      up: new Float32Array([1, 0]),
      down: new Float32Array([0, 1]),
      maxUp: 1,
      maxDown: 1,
    }
    drawButterfly(ctx, peaks, { start: 0, end: 4 }, 4, 100, 100, THEME)
    expect(THEME.waveUp).not.toBe(THEME.waveDown)
    expect(styles).toEqual([THEME.waveUp, THEME.waveDown, THEME.zero])
  })

  it('drawPlayhead: внутри окна — линия и ручка, за пределами — только очистка', () => {
    const { ctx, raw } = fakeCtx()
    drawPlayhead(ctx, 2, { start: 0, end: 4 }, 100, 120, THEME)
    expect(raw.clearRect).toHaveBeenCalledWith(0, 0, 100, 120)
    expect(raw.stroke).toHaveBeenCalledTimes(1)
    expect(raw.fill).toHaveBeenCalledTimes(1)
    // Второй вызов вне окна — только очистка.
    drawPlayhead(ctx, -5, { start: 0, end: 4 }, 100, 120, THEME)
    expect(raw.stroke).toHaveBeenCalledTimes(1)
  })
})

