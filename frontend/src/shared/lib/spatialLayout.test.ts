/**
 * Тесты чистой пространственной раскладки (spatial-audio, п.1):
 * геометрия дуги, зажатия диапазонов, преобразование процентов UI.
 */
import { describe, expect, it } from 'vitest'
import {
  ARC_DEG,
  SOURCE_DISTANCE_M,
  brainroomProject,
  moduleSourcePosition,
  scenePoints,
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

describe('spatialLayout — модули «Монтажа» (спецификация 07.10.2026)', () => {
  const count = 7

  it('frontal — узкая дуга к лбу; occipital — зеркало (поворот на 180°)', () => {
    const frontal = Array.from({ length: count }, (_, i) =>
      moduleSourcePosition('frontal', i, count, 1),
    )
    const occipital = Array.from({ length: count }, (_, i) =>
      moduleSourcePosition('occipital', i, count, 1),
    )
    for (const point of frontal) {
      expect(point.z).toBeLessThan(0) // перед слушателем
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(SOURCE_DISTANCE_M, 10)
      const azimuth = (Math.atan2(point.x, -point.z) * 180) / Math.PI
      expect(Math.abs(azimuth)).toBeLessThanOrEqual(30 + 1e-9)
    }
    // Зеркало: (x, z) → (−x, −z), то есть затылочный лобной «поворотом» сцены.
    frontal.forEach((point, i) => {
      expect(occipital[i].x).toBeCloseTo(-point.x, 10)
      expect(occipital[i].z).toBeCloseTo(-point.z, 10)
    })
  })

  it('temporal — прямая линия на уровне ушей: Z=0, X от −1.5 до 1.5', () => {
    const xs: number[] = []
    for (let i = 0; i < count; i++) {
      const point = moduleSourcePosition('temporal', i, count, 1)
      expect(point.z).toBe(0)
      expect(point.y).toBe(0)
      xs.push(point.x)
    }
    const expected = [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]
    xs.forEach((x, i) => expect(x).toBeCloseTo(expected[i], 10))
  })

  it('parietal — смещён в тыл (Z > 0), широкая дуга', () => {
    for (let i = 0; i < count; i++) {
      const point = moduleSourcePosition('parietal', i, count, 1)
      expect(point.z).toBeGreaterThan(0)
      const azimuth = Math.abs((Math.atan2(point.x, -point.z) * 180) / Math.PI)
      expect(azimuth).toBeGreaterThanOrEqual(120 - 1e-9)
    }
  })

  it('spread 0 схлопывает модуль к центру, NaN трактуется как 0', () => {
    expect(moduleSourcePosition('frontal', 3, count, 0)).toEqual({
      x: expect.closeTo(0, 10),
      y: 0,
      z: expect.closeTo(-SOURCE_DISTANCE_M, 10),
    })
    expect(moduleSourcePosition('temporal', 0, count, 0).x).toBeCloseTo(0, 10)
    expect(moduleSourcePosition('parietal', 3, count, Number.NaN).z).toBeCloseTo(
      SOURCE_DISTANCE_M,
      10,
    )
  })

  it('неизвестный ряд — ошибка (в UI приходят только id из статуса)', () => {
    expect(() => moduleSourcePosition('nope', 0, count, 1)).toThrow(/Неизвестный ряд/)
  })
})

describe('spatialLayout — силуэт BrainRoom (пропорции 1.0 : 1.3)', () => {
  it('нормировка на комнату: симметрия и пропорция длины', () => {
    // Точка на боковой стене → u = ±1, v = 0.
    expect(brainroomProject(SOURCE_DISTANCE_M, 0).u).toBeCloseTo(1, 10)
    expect(brainroomProject(SOURCE_DISTANCE_M, 0).v).toBeCloseTo(0, 10)
    expect(brainroomProject(-SOURCE_DISTANCE_M, 0).u).toBeCloseTo(-1, 10)
    // Фронт (z < 0) проецируется вверх по схеме (v > 0), тыл — вниз.
    expect(brainroomProject(0, -SOURCE_DISTANCE_M).v).toBeCloseTo(1 / 1.3, 10)
    expect(brainroomProject(0, SOURCE_DISTANCE_M).v).toBeCloseTo(-1 / 1.3, 10)
    // Симметрия: разворот (x, z) → (−x, −z) разворачивает и проекцию.
    const a = brainroomProject(0.6, -0.9)
    const b = brainroomProject(-0.6, 0.9)
    expect(b.u).toBeCloseTo(-a.u, 10)
    expect(b.v).toBeCloseTo(-a.v, 10)
  })

  it('scenePoints: «Экспресс» — дуга без рядов, «Монтаж» — кросс-продукт', () => {
    const express = scenePoints({ variant: 'express', rows: [], bands: 7, spread: 1 })
    expect(express).toHaveLength(7)
    expect(express[0].row).toBeUndefined()
    expect(express[0].z).toBeLessThan(0)

    const montage = scenePoints({
      variant: 'montage',
      rows: ['frontal', 'temporal'],
      bands: 7,
      spread: 1,
    })
    expect(montage).toHaveLength(14) // 2 ряда × 7 полос (неполный EDF)
    expect(montage.map((point) => point.row)).toEqual([
      ...Array(7).fill('frontal'),
      ...Array(7).fill('temporal'),
    ])
    expect(montage[0].z).toBeLessThan(0) // лобной — впереди
    expect(montage[7].z).toBe(0) // височный — линия ушей
  })
})
