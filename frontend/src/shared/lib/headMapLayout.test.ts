/**
 * Тесты компоновки карты-силуэта головы: прямой центральный ряд, раздвинутый
 * боковой и подписи, которые не прячутся под датчиками (правки 26.09.2026).
 *
 * Позиции — нормированные координаты монтажа 10-20, как их отдаёт `/meta`.
 */
import { describe, expect, it } from 'vitest'
import { CENTER, DOT_R, HEAD_R, VIEW, layoutSensors } from './headMapLayout'

const POSITIONS: Record<string, number[]> = {
  Fp1: [-0.253, 0.722],
  Fp2: [0.257, 0.73],
  F3: [-0.432, 0.457],
  F4: [0.446, 0.467],
  C3: [-0.562, -0.1],
  C4: [0.577, -0.094],
  P3: [-0.456, -0.678],
  P4: [0.479, -0.676],
  O1: [-0.253, -0.967],
  O2: [0.257, -0.965],
  F7: [-0.605, 0.365],
  F8: [0.628, 0.382],
  T7: [-0.724, -0.138],
  T8: [0.732, -0.129],
  P7: [-0.623, -0.632],
  P8: [0.629, -0.629],
  Fz: [0.003, 0.503],
  Cz: [0.003, -0.079],
  Pz: [0.003, -0.698],
  Oz: [0.001, -0.988],
}
const CHANNELS = Object.keys(POSITIONS)

/** Полуширина подписи — та же формула, что в модуле (моно 9 px) */
function labelHalf(name: string): number {
  return name.length * 2.7 + 1
}
const LABEL_HALF_H = 3.8

describe('layoutSensors', () => {
  it('центральный ряд T7–C3–Cz–C4–T8 выровнен по одной прямой', () => {
    const { sensors } = layoutSensors(CHANNELS, POSITIONS)
    const row = sensors.filter((s) => ['T7', 'C3', 'Cz', 'C4', 'T8'].includes(s.name))

    expect(row.map((s) => s.name).sort()).toEqual(['C3', 'C4', 'Cz', 'T7', 'T8'])
    for (const sensor of row) {
      expect(sensor.y).toBeCloseTo(row[0]!.y, 6)
    }
    // По горизонтали ряд идёт слева направо: T7 < C3 < Cz < C4 < T8
    const byName = new Map(row.map((s) => [s.name, s.x]))
    expect(byName.get('T7')!).toBeLessThan(byName.get('C3')!)
    expect(byName.get('C3')!).toBeLessThan(byName.get('Cz')!)
    expect(byName.get('Cz')!).toBeLessThan(byName.get('C4')!)
    expect(byName.get('C4')!).toBeLessThan(byName.get('T8')!)
  })

  it('боковой ряд раздвинут с внутренним кольцом — точки не слипаются', () => {
    const { sensors } = layoutSensors(CHANNELS, POSITIONS)
    const byName = new Map(sensors.map((s) => [s.name, s]))
    // Диаметр точки ≈ 13 ед. viewBox — раньше пары F7/F3, T7/C3, P7/P3 ≈ 14 слипались
    const pairs = [
      ['F7', 'F3'],
      ['F8', 'F4'],
      ['T7', 'C3'],
      ['T8', 'C4'],
      ['P7', 'P3'],
      ['P8', 'P4'],
    ] as const
    for (const [lateral, inner] of pairs) {
      const a = byName.get(lateral)!
      const b = byName.get(inner)!
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(16)
    }
    // И внутри ряда (T7–C3–Cz–C4–T8) соседи отстоят друг от друга
    expect(Math.hypot(byName.get('T7')!.x - byName.get('C3')!.x, 0)).toBeGreaterThanOrEqual(16)
    expect(Math.hypot(byName.get('C4')!.x - byName.get('T8')!.x, 0)).toBeGreaterThanOrEqual(16)
  })

  it('ни одна подпись не лежит на датчике и ближе к своей точке', () => {
    const { sensors } = layoutSensors(CHANNELS, POSITIONS)

    for (const sensor of sensors) {
      const hw = labelHalf(sensor.name)
      for (const dot of sensors) {
        const dx = Math.max(Math.abs(dot.x - sensor.labelX) - hw, 0)
        const dy = Math.max(Math.abs(dot.y - sensor.labelY) - LABEL_HALF_H, 0)
        // Своя точка тоже не должна быть закрыта подписью (случай C3/C4)
        expect(Math.hypot(dx, dy)).toBeGreaterThan(DOT_R + 1)
      }
      const own = Math.hypot(sensor.x - sensor.labelX, sensor.y - sensor.labelY)
      for (const dot of sensors) {
        if (dot.name === sensor.name) continue
        expect(Math.hypot(dot.x - sensor.labelX, dot.y - sensor.labelY)).toBeGreaterThan(own)
      }
    }
  })

  it('подписи целиком внутри контура головы и поля карты', () => {
    const { sensors } = layoutSensors(CHANNELS, POSITIONS)

    for (const sensor of sensors) {
      const hw = labelHalf(sensor.name)
      expect(sensor.labelX - hw).toBeGreaterThanOrEqual(1)
      expect(sensor.labelX + hw).toBeLessThanOrEqual(VIEW - 1)
      expect(sensor.labelY - LABEL_HALF_H).toBeGreaterThanOrEqual(1)
      expect(sensor.labelY + LABEL_HALF_H).toBeLessThanOrEqual(VIEW - 1)
      for (const cornerX of [sensor.labelX - hw, sensor.labelX + hw]) {
        for (const cornerY of [sensor.labelY - LABEL_HALF_H, sensor.labelY + LABEL_HALF_H]) {
          expect(Math.hypot(cornerX - CENTER, cornerY - CENTER)).toBeLessThanOrEqual(HEAD_R)
        }
      }
    }
  })

  it('каналы без позиции уходят в rest, негодные координаты отбрасываются', () => {
    const { sensors, rest } = layoutSensors(['Fp1', 'X9', 'Bad', 'Huge'], {
      Fp1: [0.1, 0.2],
      X9: [Number.NaN, 0],
      Bad: [0.1],
      // Нормировка сервера держит координаты в [-1, 1]: вне — негодная позиция
      Huge: [9, 9],
    })

    expect(sensors.map((s) => s.name)).toEqual(['Fp1'])
    expect(rest).toEqual(['X9', 'Bad', 'Huge'])
    expect(layoutSensors([], {}).sensors).toEqual([])
    expect(layoutSensors([], {}).rest).toEqual([])
  })
})
