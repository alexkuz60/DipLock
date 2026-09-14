/**
 * Тесты геометрии проекций мозга (срез 3.1).
 *
 * Модуль чистый, поэтому проверяется математика без DOM: обратимость перевода
 * MNI ↔ фигура, зависимость точки клика от среза, прилипание срезов к именованным
 * ориентациям, следы соседних срезов, детерминированность фикстур слоёв.
 */
import { describe, expect, it } from 'vitest'
import {
  CONTOUR_SAMPLES,
  PROJECTION_PADDING,
  PROJECTION_PLANES,
  PLANE_AXIS,
  SLICE_ORIENTATION_PRESETS,
  applyPointToSlices,
  axisTicks,
  brodmannAreaAt,
  clampSlice,
  defaultSlices,
  demoBrodmannAreas,
  demoHeadContours,
  demoSliceStructures,
  mniToNormalized,
  normalizedToMni,
  normalizedToPx,
  planeGridLines,
  planeSliceRange,
  pointFromProjectionClick,
  projectPoint,
  pxToNormalized,
  sliceGuides,
  sliceLabel,
  slicesSummary,
  snapSlice,
  type MniVector,
} from './mriProjections'

const POINT: MniVector = { x: 12.4, y: -30.6, z: 21.2 }

describe('геометрия проекций мозга', () => {
  it('переводит MNI в фигуру и обратно без потерь', () => {
    for (const plane of PROJECTION_PLANES) {
      const sliceMm = 7
      const point: MniVector = { ...POINT, [PLANE_AXIS[plane]]: sliceMm }
      const back = normalizedToMni(plane, sliceMm, mniToNormalized(plane, point))

      expect(back.x).toBeCloseTo(point.x, 6)
      expect(back.y).toBeCloseTo(point.y, 6)
      expect(back.z).toBeCloseTo(point.z, 6)
    }
  })

  it('отражает раскладку осей: x > 0 уходит влево, z > 0 — вверх', () => {
    const left = mniToNormalized('axial', { ...POINT, z: 0 })
    expect(left.u).toBeLessThan(0)

    const right = mniToNormalized('coronal', { x: -40, y: 0, z: 0 })
    expect(right.u).toBeGreaterThan(0)

    const up = mniToNormalized('sagittal', { x: 0, y: 0, z: 50 })
    expect(up.v).toBeGreaterThan(0)
  })

  it('центр фигуры — начало координат плоскости, pxToNormalized обратна normalizedToPx', () => {
    const center = normalizedToPx({ u: 0, v: 0 })
    expect(pxToNormalized(center)).toEqual({ u: 0, v: 0 })

    const corner = normalizedToPx({ u: -1, v: 1 })
    expect(corner.x).toBeCloseTo(PROJECTION_PADDING, 6)
    expect(pxToNormalized(corner).v).toBeCloseTo(1, 6)
  })

  it('клик даёт точку в плоскости своего среза: нормаль берётся из среза', () => {
    const center = pointFromProjectionClick('sagittal', 24, normalizedToPx({ u: 0, v: 0 }))
    const click = pointFromProjectionClick('sagittal', 24, normalizedToPx({ u: 0.5, v: -0.25 }))

    // Нормаль сагиттального среза — ось x: её значение берётся из среза, не из клика
    expect(click.x).toBe(24)
    // Горизонталь фигуры — ось y (вперёд +), вертикаль — z (вверх +)
    expect(click.y).toBeGreaterThan(center.y)
    expect(click.z).toBeLessThan(center.z)
  })

  it('прилипает срез к именованному, но не «притягивает» далёкие значения', () => {
    const near = snapSlice('sagittal', 2)
    expect(near.value).toBe(SLICE_ORIENTATION_PRESETS.midline.value)
    expect(near.orientation).toBe('midline')

    const far = snapSlice('sagittal', 40)
    expect(far.orientation).toBeNull()
    expect(far.value).toBe(40)
  })

  it('наводит все три среза точкой и запоминает «прилипшие» ориентации', () => {
    const navigation = applyPointToSlices({ x: 0, y: 30, z: 0 })

    expect(navigation.slices).toEqual({ axial: 0, sagittal: 0, coronal: 30 })
    expect(navigation.orientations.sagittal).toBe('midline')
    expect(navigation.orientations.axial).toBe('axial_zero')
    expect(navigation.orientations.coronal).toBeUndefined()
  })

  it('зажимает срез в границы плоскости', () => {
    const [min, max] = planeSliceRange('axial')
    expect(clampSlice('axial', max + 100)).toBe(max)
    expect(clampSlice('axial', min - 100)).toBe(min)
    expect(clampSlice('axial', Number.NaN)).toBe(0)
  })

  it('рисует следы соседних срезов только на их именованных ориентациях', () => {
    const slices = defaultSlices()
    const guides = sliceGuides('coronal', slices)

    expect(guides.map((guide) => guide.label).sort()).toEqual(['x = 0', 'z = 0'])

    // Сагитталь уехала с x = 0 — её след на коронарной больше не рисуется
    const moved = sliceGuides('coronal', { ...slices, sagittal: 30 })
    expect(moved.map((guide) => guide.label)).toEqual(['z = 0'])
  })

  it('строит сетку по каждой оси и отдельно отмечает нулевые линии', () => {
    const lines = planeGridLines('coronal')
    const zeros = lines.filter((line) => line.valueMm === 0)

    expect(zeros).toHaveLength(2)
    expect(zeros.map((line) => line.orientation).sort()).toEqual(['horizontal', 'vertical'])
    expect(lines.every((line) => Math.abs(line.at) <= 1)).toBe(true)
    expect(axisTicks('z', 20).every((tick) => tick.valueMm % 20 === 0)).toBe(true)
  })

  it('держит контур головы детерминированным и сужающимся к краям диапазона', () => {
    const first = demoHeadContours('axial', 0)
    expect(first).toHaveLength(CONTOUR_SAMPLES)
    expect(first).toEqual(demoHeadContours('axial', 0))

    const width = (sliceMm: number) =>
      Math.max(...demoHeadContours('axial', sliceMm).map((point) => Math.abs(point.u)))
    const [min, max] = planeSliceRange('axial')
    expect(width(0)).toBeGreaterThan(width(max))
    // У полюсов диапазона контур сжимается симметрично, но не в точку
    expect(width(max)).toBeCloseTo(width(min), 6)
    expect(width(max)).toBeGreaterThan(0.3)
  })

  it('проявляет структуры и поля Бродмана по глубине среза', () => {
    const structures = demoSliceStructures('sagittal', 0)
    expect(structures.length).toBeGreaterThan(0)
    expect(structures.every((structure) => structure.alpha > 0)).toBe(true)

    const areas = demoBrodmannAreas('coronal', 0)
    // Хит-тест идёт сверху вниз по порядку отрисовки: у центра верхнего поля
    // выигрывает именно оно, а не перекрытое поле под ним
    const top = areas[areas.length - 1]
    expect(brodmannAreaAt('coronal', 0, top.center)).toBe(top.name)
    expect(brodmannAreaAt('coronal', 0, { u: 5, v: 5 })).toBeNull()
  })

  it('подписывает срезы и точку для панели', () => {
    expect(sliceLabel('axial', 12)).toBe('z = 12.0 мм')
    expect(slicesSummary(defaultSlices())).toBe('z = 0.0 мм · x = 0.0 мм · y = 0.0 мм')

    const figureCenter = normalizedToPx({ u: 0, v: 0 })
    // Аксиальная фигура — плоскость x/y: x = 0 даёт середину по горизонтали,
    // а y = 0 лежит выше середины (диапазон y смещён назад)
    const axialOrigin = projectPoint('axial', { x: 0, y: 0, z: 0 })
    expect(axialOrigin.x).toBe(figureCenter.x)
    expect(axialOrigin.y).toBeLessThan(figureCenter.y)

    // Коронарная фигура — плоскость x/z: z = 0 лежит ниже середины (диапазон z смещён вверх)
    const coronalOrigin = projectPoint('coronal', { x: 0, y: 0, z: 0 })
    expect(coronalOrigin.x).toBe(figureCenter.x)
    expect(coronalOrigin.y).toBeGreaterThan(figureCenter.y)
  })
})
