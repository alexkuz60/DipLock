/**
 * Тесты помощников индикатора эпох/диполей (`shared/lib/epochStrip.ts`):
 * готовность, BAD и полосные заливки считаются чистыми функциями.
 */
import { describe, expect, it } from 'vitest'
import {
  STRIP_MIX_MAX_OPACITY,
  epochStripCellMix,
  epochStripCells,
  epochStripCellTitle,
  stripProgressCells,
  type EpochStripBand,
} from './epochStrip'

/** Полоса-заготовка: готовые эпохи и отброшенные задаются явно. */
function band(
  bandKey: string,
  ready: number[],
  bad: number[],
  label = bandKey,
): EpochStripBand {
  return {
    bandKey,
    label,
    color: 'hsl(0, 85%, 55%)',
    readyEpochs: new Set(ready),
    badEpochs: new Set(bad),
  }
}

describe('индикатор эпох/диполей', () => {
  it('даёт ровно одну ячейку на эпоху нарезки, включая BAD', () => {
    const cells = epochStripCells(5, [band('alpha', [1, 2], [0, 4])])
    expect(cells.map((cell) => cell.epochIndex)).toEqual([0, 1, 2, 3, 4])
  })

  it('готовность: ячейка с диполем ready, без — нет', () => {
    const cells = epochStripCells(3, [band('alpha', [1], [])])
    expect(cells.map((cell) => cell.ready)).toEqual([false, true, false])
  })

  it('BAD — только когда эпоха отброшена во всех отображаемых полосах', () => {
    // Эпоха 0 отброшена в обеих полосах — чистый BAD; эпоха 1 — только в beta,
    // и её готовая alpha-полоска не даёт метке BAD появиться
    const cells = epochStripCells(3, [
      band('alpha', [1], [0]),
      band('beta', [], [0, 1]),
    ])
    expect(cells[0].bad).toBe(true)
    expect(cells[1].bad).toBe(false)
    expect(cells[2].bad).toBe(false)
    // Расхождение полос видно как неготовые полоски, а не как ложный BAD
    expect(cells[1].fills.map((fill) => [fill.ready, fill.bad])).toEqual([
      [true, false],
      [false, true],
    ])
  })

  it('без отображаемых полос BAD не выдумывается (нет данных ≠ всё BAD)', () => {
    const cells = epochStripCells(2, [])
    expect(cells.every((cell) => !cell.bad && !cell.ready)).toBe(true)
  })

  it('тултип называет номер эпохи (с 1), BAD и готовые полосы', () => {
    const cells = epochStripCells(3, [
      band('alpha', [1], [0], 'α (8–16 Гц)'),
      band('beta', [], [0], 'β (16–32 Гц)'),
    ])
    expect(epochStripCellTitle(cells[0])).toBe('Эпоха 1 · BAD — отброшена')
    expect(epochStripCellTitle(cells[1])).toBe('Эпоха 2 · диполи: α (8–16 Гц)')
    expect(epochStripCellTitle(cells[2])).toBe('Эпоха 3 · диполей нет')
  })

  it('заливка-микс: слой на готовую полосу, суммарная непрозрачность ровно 75%', () => {
    const cells = epochStripCells(3, [
      band('alpha', [0, 1], [], 'α'),
      band('beta', [1], [], 'β'),
      band('gamma', [1], [], 'γ'),
    ])
    // Эпоха 0: одна готовая полоса — её слой несёт всю непрозрачность микса
    expect(cells[0].mix.map((layer) => layer.bandKey)).toEqual(['alpha'])
    expect(cells[0].mix[0].opacity).toBeCloseTo(STRIP_MIX_MAX_OPACITY, 6)
    // Эпоха 1: три готовые — доля каждого слоя делится поровну (0.75 / 3)
    expect(cells[1].mix).toHaveLength(3)
    const total = cells[1].mix.reduce((sum, layer) => sum + layer.opacity, 0)
    expect(total).toBeCloseTo(STRIP_MIX_MAX_OPACITY, 6)
    for (const layer of cells[1].mix) {
      expect(layer.opacity).toBeCloseTo(STRIP_MIX_MAX_OPACITY / 3, 6)
    }
    // Эпоха 2: диполей нет — заливки нет (готовность читается «плотностью» микса)
    expect(cells[2].mix).toEqual([])
  })

  it('BAD-полосы и неготовые в микс не входят', () => {
    const cells = epochStripCells(2, [
      band('alpha', [0], [1], 'α'),
      band('beta', [], [1], 'β'),
      band('gamma', [], [1], 'γ'),
    ])
    expect(cells[0].mix).toHaveLength(1) // готова только alpha
    // Эпоха 1: все полосы отброшены — микса нет (ячейка BAD)
    expect(cells[1].bad).toBe(true)
    expect(epochStripCellMix(cells[1].fills)).toEqual([])
  })

  it('предзаливка задачи пропорциональна прогрессу по эпохам', () => {
    expect(stripProgressCells(10, 5, 10)).toBe(5)
    expect(stripProgressCells(10, 0, 10)).toBe(0)
    expect(stripProgressCells(10, 10, 10)).toBe(10)
    // Прогресс больше сетки зажимается, а не рисует ячейки за её пределами
    expect(stripProgressCells(10, 12, 10)).toBe(10)
    // Без знания сетки или общего числа эпох предзаливки нет
    expect(stripProgressCells(0, 5, 10)).toBe(0)
    expect(stripProgressCells(10, 5, 0)).toBe(0)
  })
})
