/**
 * Тесты чистой пространственной раскладки (spatial-audio, п.1):
 * геометрия дуги, зажатия диапазонов, преобразование процентов UI.
 */
import { describe, expect, it } from 'vitest'
import {
  ARC_DEG,
  SOURCE_DISTANCE_M,
  sourceAzimuthDeg,
  sourcePosition,
  sourcePositions,
  spreadParam,
  wetParam,
  widthParam,
} from './spatialLayout'

describe('spatialLayout — дуга источников', () => {
  it('полный разброс: 7 источников от −60° до +60°, крайние — слева/справа', () => {
    expect(sourceAzimuthDeg(0, 7, 1)).toBe(-ARC_DEG)
    expect(sourceAzimuthDeg(6, 7, 1)).toBe(ARC_DEG)
    // Средний (4-й из 7) — фронт слушателя.
    expect(sourceAzimuthDeg(3, 7, 1)).toBe(0)
  })

  it('spread=0 схлопывает дугу в точку перед слушателем', () => {
    const positions = sourcePositions(7, 0)
    for (const position of positions) {
      expect(position.x).toBeCloseTo(0, 10)
      expect(position.z).toBeCloseTo(-SOURCE_DISTANCE_M, 10)
    }
  })

  it('позиции лежат на окружности радиуса distance (равномерная громкость)', () => {
    const distance = 2
    for (const position of sourcePositions(7, 1, distance)) {
      const radius = Math.hypot(position.x, position.z)
      expect(radius).toBeCloseTo(distance, 10)
      expect(position.y).toBe(0)
    }
  })

  it('перед слушателем — отрицательный Z (конвенция Web Audio)', () => {
    const front = sourcePosition(3, 7, 1)
    expect(front.z).toBeLessThan(0)
    expect(front.x).toBeCloseTo(0, 10)
  })

  it('крайние позиции симметричны относительно центра', () => {
    const left = sourcePosition(0, 7, 1)
    const right = sourcePosition(6, 7, 1)
    expect(left.x).toBeCloseTo(-right.x, 10)
    expect(left.z).toBeCloseTo(right.z, 10)
  })

  it('одиночный источник — всегда в центре (count<=1 без деления на 0)', () => {
    expect(sourceAzimuthDeg(0, 1, 1)).toBe(0)
    expect(sourcePositions(0, 1)).toEqual([])
  })

  it('NaN в spread не роняет раскладку (зажатие к 0)', () => {
    // clamp01(NaN) → 0: нечисловой разброс схлопывает дугу к центру.
    expect(sourceAzimuthDeg(0, 7, Number.NaN)).toBe(-0)
    const position = sourcePosition(0, 7, Number.NaN)
    expect(Number.isFinite(position.x)).toBe(true)
    expect(position.x).toBeCloseTo(0, 10)
  })
})

describe('spatialLayout — проценты UI → параметры узлов', () => {
  it('width: 100 % — без изменения (0,5), 0 % — моно, 150 % — 0,75', () => {
    expect(widthParam(100)).toBeCloseTo(0.5, 10)
    expect(widthParam(0)).toBe(0)
    expect(widthParam(150)).toBeCloseTo(0.75, 10)
  })

  it('width зажимается в 0…1 (защита Tone-сигнала normalRange)', () => {
    expect(widthParam(1000)).toBe(1)
    expect(widthParam(-10)).toBe(0)
  })

  it('spread/wet — линейные проценты 0…100 → 0…1 с зажатием', () => {
    expect(spreadParam(100)).toBe(1)
    expect(spreadParam(50)).toBe(0.5)
    expect(wetParam(25)).toBe(0.25)
    expect(wetParam(150)).toBe(1)
    expect(wetParam(Number.NaN)).toBe(0)
  })
})
