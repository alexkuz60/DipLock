/**
 * Тесты геометрии контуров атласа (срез 3.9).
 *
 * Модуль чистый: миллиметры MNI → фигура, попадание клика → метка. Проверяется
 * то, что ломается незаметно: квантование среза к сетке атласа, версия в URL,
 * знаки осей (радиологическая раскладка), вычитание дырок по правилу even-odd и
 * приоритет мелкой метки над крупной (клик по таламусу не должен называть белое
 * вещество).
 */
import { describe, expect, it } from 'vitest'
import {
  CONTOURS_METHOD_HINT,
  contourPathPx,
  contourPointToNormalized,
  contourSliceMm,
  contourSliceUrl,
  contourSummary,
  shapeAtPoint,
  shapeContainsPoint,
} from './atlasContours'
import type { ContourShape, ContoursRef } from '@/shared/api/types'

const REF: ContoursRef = {
  version: 'v42',
  url: '/api/v1/surface/contours',
  spacing_mm: 1,
  method: 'nearest_cortex_vertex',
}

/** Прямоугольник в мм по осям плоскости (для аксиальной плоскости — x, y). */
function rect(
  id: string,
  [u0, v0]: [number, number],
  [u1, v1]: [number, number],
): ContourShape {
  return {
    id,
    name: id,
    label: `${id} (подпись)`,
    hulls: [
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
    ],
    area_mm2: Math.abs((u1 - u0) * (v1 - v0)),
  }
}

describe('ссылка на контуры среза', () => {
  it('квантует срез к сетке атласа («половина вверх») и несёт версию', () => {
    expect(contourSliceMm('axial', 0.4, 1)).toBe(0)
    expect(contourSliceMm('axial', 0.6, 1)).toBe(1)
    expect(contourSliceMm('axial', -0.6, 1)).toBe(-1)
    expect(contourSliceUrl(REF, 'sagittal', 12.4)).toBe(
      '/api/v1/surface/contours/sagittal/12?v=v42',
    )
  })

  it('объясняет производность BA-разметки (честность картинки)', () => {
    expect(CONTOURS_METHOD_HINT).toContain('nearest_cortex_vertex')
    expect(CONTOURS_METHOD_HINT).toContain('производно')
  })
})

describe('геометрия контура', () => {
  it('применяет знаки осей: горизонталь аксиальной развёрнута (x > 0 — слева)', () => {
    // Аксиальная: горизонталь — x со знаком −1, вертикаль — y со знаком +1
    const center = contourPointToNormalized('axial', [0, -18])
    expect(center.u).toBeCloseTo(0, 6)
    expect(center.v).toBeCloseTo(0, 6)
    expect(contourPointToNormalized('axial', [80, -18]).u).toBeCloseTo(-1, 6)
    expect(contourPointToNormalized('axial', [-80, -18]).u).toBeCloseTo(1, 6)
    // Сагиттальная: горизонталь — y (вперёд вправо), вертикаль — z (вверх)
    expect(contourPointToNormalized('sagittal', [80, 90]).u).toBeCloseTo(1, 6)
    expect(contourPointToNormalized('sagittal', [80, 90]).v).toBeCloseTo(1, 6)
  })

  it('собирает путь из полигонов и попадает в свой контур', () => {
    const shape = rect('A', [-10, -10], [10, 10])
    const path = contourPathPx('axial', shape)

    expect(path.startsWith('M ')).toBe(true)
    expect(path.endsWith(' Z')).toBe(true)
    expect(path.match(/M /g)).toHaveLength(1)
    // Точка даётся в нормализованных координатах фигуры — как приходит из клика
    expect(
      shapeContainsPoint('axial', shape, contourPointToNormalized('axial', [0, 0])),
    ).toBe(true)
    expect(
      shapeContainsPoint('axial', shape, contourPointToNormalized('axial', [70, 60])),
    ).toBe(false)
  })

  it('вычитает дырки по правилу even-odd', () => {
    const withHole: ContourShape = {
      ...rect('ring', [-30, -30], [30, 30]),
      hulls: [
        [
          [-30, -30],
          [30, -30],
          [30, 30],
          [-30, 30],
        ],
        [
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
        ],
      ],
    }

    // Внутри внешнего полигона — да, внутри дырки — нет
    expect(shapeContainsPoint('axial', withHole, contourPointToNormalized('axial', [20, 0]))).toBe(
      true,
    )
    expect(shapeContainsPoint('axial', withHole, contourPointToNormalized('axial', [0, 0]))).toBe(
      false,
    )
  })

  it('отдаёт мелкую метку, а не накрывающую её крупную', () => {
    const big = rect('white-matter', [-60, -60], [10, 10])
    const small = rect('thalamus', [-20, -20], [-10, -10])
    // Сервер отдаёт метки по убыванию площади — порядок важен для хит-теста
    const shapes = [big, small]

    const inside = contourPointToNormalized('axial', [-15, -15])
    expect(shapeAtPoint(shapes, 'axial', inside)?.id).toBe('thalamus')
    expect(shapeAtPoint(shapes, 'axial', contourPointToNormalized('axial', [0, 0]))?.id).toBe(
      'white-matter',
    )
    expect(shapeAtPoint(shapes, 'axial', contourPointToNormalized('axial', [70, 70]))).toBeNull()
    expect(shapeAtPoint([], 'axial', inside)).toBeNull()
  })

  it('считает метки среза и терпит отсутствие данных', () => {
    expect(contourSummary(null)).toEqual({ structures: 0, areas: 0 })
    expect(
      contourSummary({
        version: 'v42',
        plane: 'axial',
        axis: 'z',
        mm: 0,
        spacing_mm: 1,
        method: 'nearest_cortex_vertex',
        structures: [rect('A', [-10, -10], [10, 10])],
        areas: [rect('BA17-lh', [10, 10], [20, 20]), rect('BA4-lh', [0, 0], [5, 5])],
      }),
    ).toEqual({ structures: 1, areas: 2 })
  })
})
