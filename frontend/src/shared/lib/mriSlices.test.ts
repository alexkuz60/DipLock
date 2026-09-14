/**
 * Тесты ссылок на картинки срезов МРТ (срез 3.2).
 *
 * Модуль чистый: проверяется квантование среза к сетке тома (картинка существует
 * только на узлах 1 мм), сборка URL с версией ассета и то, что прямоугольник
 * картинки совпадает с прямоугольником плоскости проекции.
 */
import { describe, expect, it } from 'vitest'
import { PROJECTION_PADDING, PROJECTION_PLANES, normalizedToPx, projectionBox } from './mriProjections'
import {
  MRI_SLICE_UNAVAILABLE,
  mriSliceRect,
  mriSliceUrl,
  sliceImageMm,
  snapSliceToGrid,
} from './mriSlices'

/** Ссылка на срезы как её отдаёт `/meta`. */
const REF = {
  version: 'abc123',
  slice_url: '/api/v1/surface/mri/slice',
  spacing_mm: 1,
}

describe('ссылки на срезы МРТ', () => {
  it('квантует срез к сетке тома: половина вверх, как в бэкенде', () => {
    expect(snapSliceToGrid(12.4, 1)).toBe(12)
    expect(snapSliceToGrid(-3.5, 1)).toBe(-3)
    expect(snapSliceToGrid(-3.6, 1)).toBe(-4)
    expect(snapSliceToGrid(12.5, 2)).toBe(12)
    // Нулевой шаг не должен приводить к делению на ноль
    expect(snapSliceToGrid(5, 0)).toBe(5)
  })

  it('зажимает срез в границы плоскости', () => {
    expect(sliceImageMm('axial', 10_000, 1)).toBe(90)
    expect(sliceImageMm('axial', -10_000, 1)).toBe(-82)
    expect(sliceImageMm('sagittal', 79.4, 1)).toBe(79)
    expect(sliceImageMm('coronal', -115.4, 1)).toBe(-115)
  })

  it('собирает URL среза с версией ассета', () => {
    expect(mriSliceUrl(REF, 'axial', 0)).toBe('/api/v1/surface/mri/slice/axial/0.png?v=abc123')
    expect(mriSliceUrl(REF, 'coronal', -40.4)).toBe(
      '/api/v1/surface/mri/slice/coronal/-40.png?v=abc123',
    )
    // Дробный срез UI и целый срез тома дают одну картинку — один ключ кэша
    expect(mriSliceUrl(REF, 'sagittal', 12.4)).toBe(mriSliceUrl(REF, 'sagittal', 12))
  })

  it('прямоугольник картинки совпадает с плоскостью фигуры', () => {
    for (const plane of PROJECTION_PLANES) {
      const rect = mriSliceRect(plane)
      // Углы плоскости в пикселях: картинка обязана накрыть их без зазора
      const topLeft = normalizedToPx({ u: -1, v: 1 }, plane)
      const bottomRight = normalizedToPx({ u: 1, v: -1 }, plane)

      expect(rect.x).toBeCloseTo(topLeft.x, 6)
      expect(rect.y).toBeCloseTo(topLeft.y, 6)
      expect(rect.x + rect.width).toBeCloseTo(bottomRight.x, 6)
      expect(rect.y + rect.height).toBeCloseTo(bottomRight.y, 6)

      const box = projectionBox(plane)
      expect(rect).toEqual({
        x: PROJECTION_PADDING,
        y: PROJECTION_PADDING,
        // Прямоугольник не квадратный: масштаб осей общий (срез 3.3)
        width: box.innerWidth,
        height: box.innerHeight,
      })
    }
  })

  it('поясняет недоступный срез словами, а не пустой фигурой', () => {
    expect(MRI_SLICE_UNAVAILABLE).toMatch(/срез МРТ недоступен/)
  })
})