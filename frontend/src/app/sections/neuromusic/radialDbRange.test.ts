/**
 * Тесты конечной оптимизации радиальных значений (`radialDbRange.ts`):
 * дБ-окно −40/−60 и сохранение направления вектора
 * (инвариант: углы доминант и ступени «Эмограммы» не меняются).
 */
import { describe, expect, it } from 'vitest'
import {
  radialScaleFrac,
  radialScalePoint,
  radialScalePoints,
  radialScalePct,
} from './radialDbRange'

describe('radialScaleFrac — лог-шкала радиуса в дБ-окне', () => {
  it('db-60: 1 → 1, 0.001 → 0, середины по 20·log10', () => {
    expect(radialScaleFrac(1, 'db-60')).toBeCloseTo(1, 12)
    expect(radialScaleFrac(0.001, 'db-60')).toBeCloseTo(0, 12) // −60 дБ = пол окна
    expect(radialScaleFrac(0, 'db-60')).toBe(0)
    expect(radialScaleFrac(-0.5, 'db-60')).toBe(0)
    // 0.1 → −20 дБ → (−20 + 60)/60 = 2/3.
    expect(radialScaleFrac(0.1, 'db-60')).toBeCloseTo(2 / 3, 12)
    // 0.01 → −40 дБ → (−40 + 60)/60 = 1/3.
    expect(radialScaleFrac(0.01, 'db-60')).toBeCloseTo(1 / 3, 12)
  })

  it('db-40: тише пола — 0, выше — растяжение сильнее', () => {
    expect(radialScaleFrac(0.01, 'db-40')).toBeCloseTo(0, 12) // −40 дБ = пол окна
    expect(radialScaleFrac(0.001, 'db-40')).toBe(0) // ниже пола
    expect(radialScaleFrac(0.1, 'db-40')).toBeCloseTo(0.5, 12) // −20 дБ → 20/40
    expect(radialScaleFrac(1, 'db-40')).toBeCloseTo(1, 12)
  })

  it('перенос выключен (null/неизвестная шкала) — значение без изменений', () => {
    expect(radialScaleFrac(0.35, null)).toBe(0.35)
    expect(radialScaleFrac(0.35, undefined)).toBe(0.35)
    expect(radialScaleFrac(0.35, 'unknown' as never)).toBe(0.35)
    expect(radialScaleFrac(Number.NaN, 'db-60')).toBe(0)
  })

  it('radialScalePct — тот же перенос в процентах радиуса', () => {
    expect(radialScalePct(100, 'db-60')).toBeCloseTo(100, 12)
    expect(radialScalePct(10, 'db-60')).toBeCloseTo(100 * (2 / 3), 12)
    expect(radialScalePct(50, null)).toBe(50)
  })
})

describe('radialScalePoint — перенос длины радиус-вектора, направление цело', () => {
  const center = { x: 100, y: 100 }

  it('длина переносится в шкалу, угол исходной точки сохраняется', () => {
    // Точка на востоке (угол 0), длина 50 = половина радиуса 100 → −6 дБ.
    const point = radialScalePoint({ x: 150, y: 100 }, center, 100, 'db-60')
    expect(point.y).toBeCloseTo(100, 12) // направление не тронуто
    const expected = radialScaleFrac(0.5, 'db-60') * 100
    expect(point.x - center.x).toBeCloseTo(expected, 10)
  })

  it('диагональ: угол atan2 сохраняется точно', () => {
    const raw = { x: 130, y: 70 } // вверх-вправо от центра
    const point = radialScalePoint(raw, center, 100, 'db-40')
    const angleRaw = Math.atan2(raw.y - center.y, raw.x - center.x)
    const angle = Math.atan2(point.y - center.y, point.x - center.x)
    expect(angle).toBeCloseTo(angleRaw, 12)
    expect(Math.hypot(point.x - center.x, point.y - center.y)).toBeCloseTo(
      radialScaleFrac(Math.hypot(30, 30) / 100, 'db-40') * 100,
      10,
    )
  })

  it('центр и выключенный перенос — точка без изменений', () => {
    expect(radialScalePoint({ x: 100, y: 100 }, center, 100, 'db-60')).toEqual({
      x: 100,
      y: 100,
    })
    const raw = { x: 150, y: 100 }
    expect(radialScalePoint(raw, center, 100, null)).toEqual(raw)
  })

  it('radialScalePoints — массив точек переносится согласованно', () => {
    const points = radialScalePoints(
      [
        { x: 150, y: 100 },
        { x: 100, y: 100 },
      ],
      center,
      100,
      'db-60',
    )
    expect(points).toHaveLength(2)
    expect(points[0]?.x).toBeCloseTo(100 + radialScaleFrac(0.5, 'db-60') * 100, 10)
    expect(points[1]).toEqual({ x: 100, y: 100 })
  })
})