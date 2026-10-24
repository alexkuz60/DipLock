/**
 * Тесты квинтово-квартового круга (`keyCircle.ts`): позиции тональностей,
 * имена ячеек, роли подсветок активного аккорда (легенда образца) и
 * геометрия ячеек.
 */
import { describe, expect, it } from 'vitest'
import {
  CIRCLE_MAJORS,
  CIRCLE_MINORS,
  CIRCLE_SIGNATURES,
  circleCellPath,
  circleHighlightRoles,
  circleLabelPoint,
  circleNameOf,
  circleSlotOf,
} from './keyCircle'

describe('circleSlotOf — позиция тональности в круге', () => {
  it('мажор: C = 0, G = 1 … F = 11 (квинтовый ход по часовой)', () => {
    // Коды 1…12: C, C#, D, D#, E, F, F#, G, G#, A, A#, B.
    const expected: Record<number, number> = {
      1: 0, // C
      8: 1, // G
      3: 2, // D
      10: 3, // A
      5: 4, // E
      12: 5, // B
      7: 6, // F#
      2: 7, // C# = Db
      9: 8, // G# = Ab
      4: 9, // D# = Eb
      11: 10, // A# = Bb
      6: 11, // F
    }
    for (const [code, position] of Object.entries(expected)) {
      const slot = circleSlotOf(Number(code))
      expect(slot?.ring).toBe('major')
      expect(slot?.position).toBe(position)
    }
  })

  it('минор: Am = 0, Em = 1 … Dm = 11 (позиция параллельного мажора)', () => {
    // Коды 13…24: Cm, C#m, Dm, D#m, Em, Fm, F#m, Gm, G#m, Am, A#m, Bm.
    const expected: Record<number, number> = {
      22: 0, // Am
      17: 1, // Em
      24: 2, // Bm
      19: 3, // F#m
      14: 4, // C#m
      21: 5, // G#m
      16: 6, // D#m
      23: 7, // A#m = Bbm
      18: 8, // Fm
      13: 9, // Cm
      20: 10, // Gm
      15: 11, // Dm
    }
    for (const [code, position] of Object.entries(expected)) {
      const slot = circleSlotOf(Number(code))
      expect(slot?.ring).toBe('minor')
      expect(slot?.position).toBe(position)
    }
  })

  it('код вне 1…24, не число — null; имена ячеек — из колец', () => {
    expect(circleSlotOf(0)).toBeNull()
    expect(circleSlotOf(25)).toBeNull()
    expect(circleSlotOf(Number.NaN)).toBeNull()
    expect(circleNameOf(1)).toBe('C')
    expect(circleNameOf(8)).toBe('G')
    expect(circleNameOf(22)).toBe('Am')
    expect(circleNameOf(15)).toBe('Dm')
    expect(circleNameOf(0)).toBeNull()
    expect(CIRCLE_MAJORS).toHaveLength(12)
    expect(CIRCLE_MINORS).toHaveLength(12)
    expect(CIRCLE_SIGNATURES).toHaveLength(12)
    expect(CIRCLE_MAJORS[0]).toBe('C')
    expect(CIRCLE_MAJORS[6]).toBe('F#')
    expect(CIRCLE_MINORS[0]).toBe('Am')
    expect(CIRCLE_MINORS[11]).toBe('Dm')
  })
})

describe('circleHighlightRoles — подсветки активного аккорда (легенда образца)', () => {
  it('C мажор: тоника C, суб/доминанта F+G, параллельная Am, одноимённая Cm', () => {
    const roles = circleHighlightRoles(1) // C major
    expect(roles.major[0]).toBe('tonic') // C
    expect(roles.major[1]).toBe('dominant') // G
    expect(roles.major[11]).toBe('subdominant') // F
    expect(roles.minor[0]).toBe('parallel') // Am
    expect(roles.minor[9]).toBe('sameName') // Cm
    // Остальные ячейки без подсветки.
    expect(roles.major.filter((role) => role === null)).toHaveLength(9)
    expect(roles.minor.filter((role) => role === null)).toHaveLength(10)
  })

  it('Am минор: тоника Am, суб/доминанта Dm+Em, параллельная C, одноимённая A', () => {
    const roles = circleHighlightRoles(22) // Am
    expect(roles.minor[0]).toBe('tonic') // Am
    expect(roles.minor[1]).toBe('dominant') // Em
    expect(roles.minor[11]).toBe('subdominant') // Dm
    expect(roles.major[0]).toBe('parallel') // C
    expect(roles.major[3]).toBe('sameName') // A
  })

  it('нет активной тональности — все роли null', () => {
    const roles = circleHighlightRoles(Number.NaN)
    expect(roles.major.every((role) => role === null)).toBe(true)
    expect(roles.minor.every((role) => role === null)).toBe(true)
  })
})

describe('геометрия ячеек круга', () => {
  it('circleLabelPoint: позиция 0 — верх, позиция 3 — восток (по часовой)', () => {
    const top = circleLabelPoint(100, 100, 90, 0)
    expect(top.x).toBeCloseTo(100, 10)
    expect(top.y).toBeCloseTo(10, 10) // вверх — y меньше (SVG)
    const east = circleLabelPoint(100, 100, 90, 3)
    expect(east.x).toBeCloseTo(190, 10)
    expect(east.y).toBeCloseTo(100, 10)
  })

  it('circleCellPath: дуга + радиусы + замыкание, центр ячейки на месте подписи', () => {
    const path = circleCellPath(100, 100, 30, 90, 0)
    expect(path.startsWith('M ')).toBe(true)
    expect(path).toContain('A 90 90')
    expect(path).toContain('A 30 30')
    expect(path.endsWith('Z')).toBe(true)
  })
})