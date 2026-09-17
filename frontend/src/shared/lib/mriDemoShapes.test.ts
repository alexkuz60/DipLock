/**
 * Тесты демо-фигур проекций (срез 3.1): силуэт головы, схема среза, поля Бродмана.
 *
 * Это фикстуры, а не геометрия, поэтому и проверки у них свои: детерминированность
 * (одни и те же входы — одни и те же точки), поведение по глубине среза (фигуры
 * сужаются/уходят), согласованность рисуемых эллипсов с попаданием клика. Второй и
 * третий пункты — то, ради чего фикстуры вообще существуют: по ним проверяются
 * наведение срезов, линейка и подсветка поля без реальной томографии.
 */
import { describe, expect, it } from 'vitest'
import {
  CONTOUR_SAMPLES,
  brodmannAreaAt,
  demoBrodmannAreas,
  demoHeadContours,
  demoSliceStructures,
} from './mriDemoShapes'
import {
  PROJECTION_PLANES,
  ellipsePx,
  planeSliceRange,
  projectionBox,
  pxToNormalized,
} from './mriProjections'

describe('демо-фигуры проекций мозга', () => {
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

  /**
   * Геометрия полей Бродмана (срез 3.5): эллипс считается **одной** функцией —
   * компонент берёт её для отрисовки, а попадание проверяется по тем же
   * нормализованным полуосям. Если формулы разъедутся, подсветка поля будет
   * ложной: клик рядом с полем подсветит его, а клик по нему — нет.
   */
  it('держит эллипсы полей Бродмана ровно там, где их ловит хит-тест', () => {
    for (const plane of PROJECTION_PLANES) {
      const areas = demoBrodmannAreas(plane, 0)
      expect(areas.length).toBeGreaterThan(0)
      // Последнее поле в списке рисуется поверх остальных, поэтому в его центре
      // хит-тест обязан вернуть именно его — проверка однозначная
      const area = areas[areas.length - 1]
      const ellipse = ellipsePx(plane, area.center, area.radius)
      const box = projectionBox(plane)

      // Полуоси в пикселях — это радиус в долях полуразмаха × половина стороны
      expect(ellipse.rx).toBeCloseTo(area.radius.u * (box.innerWidth / 2), 9)
      expect(ellipse.ry).toBeCloseTo(area.radius.v * (box.innerHeight / 2), 9)
      // Центр совпадает с переводом точки проекции (обратный перевод не «уезжает»)
      expect(
        ellipsePx(plane, pxToNormalized({ x: ellipse.cx, y: ellipse.cy }, plane), area.radius).cx,
      ).toBeCloseTo(ellipse.cx, 9)

      const hit = (px: { x: number; y: number }) =>
        brodmannAreaAt(plane, 0, pxToNormalized(px, plane))
      expect(hit({ x: ellipse.cx, y: ellipse.cy })).toBe(area.name)
      // Границы по обеим полуосям внутри поля (чуть внутрь — попадание)
      expect(hit({ x: ellipse.cx + ellipse.rx * 0.98, y: ellipse.cy })).toBe(area.name)
      expect(hit({ x: ellipse.cx - ellipse.rx * 0.98, y: ellipse.cy })).toBe(area.name)
      expect(hit({ x: ellipse.cx, y: ellipse.cy + ellipse.ry * 0.98 })).toBe(area.name)
      expect(hit({ x: ellipse.cx, y: ellipse.cy - ellipse.ry * 0.98 })).toBe(area.name)
      // А сразу за границей — уже нет: эллипс, а не «прямоугольник на все поле»
      expect(hit({ x: ellipse.cx + ellipse.rx * 1.05, y: ellipse.cy })).not.toBe(area.name)
      expect(hit({ x: ellipse.cx, y: ellipse.cy + ellipse.ry * 1.05 })).not.toBe(area.name)
      // Угол описанного прямоугольника лежит вне эллипса (проверка кривизны)
      expect(
        hit({ x: ellipse.cx + ellipse.rx * 0.75, y: ellipse.cy + ellipse.ry * 0.75 }),
      ).not.toBe(area.name)
    }
  })
})
