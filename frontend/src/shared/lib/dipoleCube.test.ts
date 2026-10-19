/**
 * Тесты геометрии 3D-вида «Куб» (`shared/lib/dipoleCube.ts`): базис камеры,
 * ортографическая проекция, стенки с картинками срезов, линии проекции
 * выделенного диполя и авто-правило «срезы / силуэт».
 */
import { describe, expect, it } from 'vitest'
import {
  CUBE_CROSS_HALF_MM,
  CUBE_DEFAULT_VIEW,
  cssTokenOf,
  cubeBasis,
  cubeCorners,
  cubeProjector,
  cubeWall,
  cubeWallNormal,
  cubeWalls,
  cubeWallsMode,
  projectionCross,
  projectionLinesToWalls,
  resolveWallsMode,
  wallImageTransform,
  wallOutline,
} from './dipoleCube'
import { MNI_BRAIN_BOUNDS } from './mriProjections'

const SIZE = { width: 600, height: 500 }

describe('куб диполей: базис камеры', () => {
  it('даёт ортонормированный базис с осью z «вверх» на экране', () => {
    for (const view of [
      CUBE_DEFAULT_VIEW,
      { azimuthDeg: -120, elevationDeg: 60 },
      { azimuthDeg: 0, elevationDeg: -45 },
    ]) {
      const basis = cubeBasis(view)
      for (const vector of [basis.right, basis.up, basis.toward]) {
        expect(Math.hypot(vector.x, vector.y, vector.z)).toBeCloseTo(1, 10)
      }
      expect(
        basis.right.x * basis.up.x + basis.right.y * basis.up.y + basis.right.z * basis.up.z,
      ).toBeCloseTo(0, 10)
      expect(basis.up.z).toBeGreaterThan(0)
    }
  })
})

describe('куб диполей: проектор', () => {
  it('кладёт центр куба в центр канваса и вписывает углы в поле', () => {
    const projector = cubeProjector(CUBE_DEFAULT_VIEW, SIZE)
    // Центр MNI-границ не в начале координат — центр куба это CUBE_CENTER
    const projected = projector.project({ x: 0, y: -18, z: 4 })
    expect(projected.x).toBeCloseTo(SIZE.width / 2, 6)
    expect(projected.y).toBeCloseTo(SIZE.height / 2, 6)
    for (const corner of cubeCorners()) {
      const point = projector.project(corner)
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(SIZE.width)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(SIZE.height)
    }
  })

  it('глубина растёт к зрителю: +x ближе −x при стартовом ракурсе', () => {
    const projector = cubeProjector(CUBE_DEFAULT_VIEW, SIZE)
    const near = projector.project({ x: 80, y: 0, z: 0 })
    const far = projector.project({ x: -80, y: 0, z: 0 })
    expect(near.depth).toBeGreaterThan(far.depth)
  })
})

describe('куб диполей: стенки', () => {
  it('стоят на дальней границе головы: минимум своей оси', () => {
    expect(cubeWallNormal('axial')).toBe(MNI_BRAIN_BOUNDS.z[0])
    expect(cubeWallNormal('sagittal')).toBe(MNI_BRAIN_BOUNDS.x[0])
    expect(cubeWallNormal('coronal')).toBe(MNI_BRAIN_BOUNDS.y[0])
    expect(cubeWalls().map((wall) => wall.normalMm)).toEqual([-82, -80, -116])
  })

  it('углы стенки идут в порядке пикселей картинки (tl, tr, bl, br)', () => {
    // Аксиальная стенка: горизонталь — x со знаком −1 (радиологическая
    // ориентация: левый край картинки — x = max), вертикаль — y со знаком +1
    const wall = cubeWall('axial')
    expect(wall.corners[0]).toEqual({ x: 80, y: 80, z: -82 })
    expect(wall.corners[1]).toEqual({ x: -80, y: 80, z: -82 })
    expect(wall.corners[2]).toEqual({ x: 80, y: -116, z: -82 })
    expect(wall.corners[3]).toEqual({ x: -80, y: -116, z: -82 })
    for (const corner of wall.corners) {
      expect(corner.z).toBe(cubeWallNormal('axial'))
    }
  })

  it('аффинное отображение картинки кладёт её в углы стенки', () => {
    const projector = cubeProjector(CUBE_DEFAULT_VIEW, SIZE)
    const wall = cubeWall('coronal')
    const [a, b, c, d, e, f] = wallImageTransform(wall, projector)
    const apply = (u: number, v: number) => ({
      x: a * u + c * v + e,
      y: b * u + d * v + f,
    })
    const corners = wallOutline(wall, projector)
    expect(apply(0, 0)).toEqual({ x: corners[0].x, y: corners[0].y })
    expect(apply(1, 0)).toEqual({ x: corners[1].x, y: corners[1].y })
    expect(apply(0, 1)).toEqual({ x: corners[2].x, y: corners[2].y })
    // Контрольный четвёртый угол: параллелограмм замыкается
    expect(apply(1, 1)).toEqual({ x: corners[3].x, y: corners[3].y })
  })
})

describe('куб диполей: проекции выделенного диполя', () => {
  const point = { x: -57, y: -20, z: 26 }

  it('линии идут ортогонально к трём стенкам', () => {
    const lines = projectionLinesToWalls(point)
    expect(lines.map((line) => [line.plane, line.end])).toEqual([
      ['axial', { x: -57, y: -20, z: -82 }],
      ['sagittal', { x: -80, y: -20, z: 26 }],
      ['coronal', { x: -57, y: -116, z: 26 }],
    ])
  })

  it('крест центрирован на конце линии, штрихи идут вдоль осей плоскости', () => {
    const projector = cubeProjector(CUBE_DEFAULT_VIEW, SIZE)
    const wall = cubeWall('axial')
    const end = projectionLinesToWalls(point)[0].end
    const segments = projectionCross(wall, end, projector)
    expect(segments).toHaveLength(2)
    const projected = projector.project(end)
    for (const segment of segments) {
      const middle = {
        x: (segment.from.x + segment.to.x) / 2,
        y: (segment.from.y + segment.to.y) / 2,
      }
      expect(middle.x).toBeCloseTo(projected.x, 6)
      expect(middle.y).toBeCloseTo(projected.y, 6)
    }
    // Горизонтальный штрих (ось x плоскости) коллинеарен проекции мировой оси x
    const basis = cubeBasis(CUBE_DEFAULT_VIEW)
    const horizontal = segments[0]
    const dx = horizontal.to.x - horizontal.from.x
    const dy = horizontal.to.y - horizontal.from.y
    const expected = { x: basis.right.x, y: -basis.up.x }
    expect(dx * expected.y - dy * expected.x).toBeCloseTo(0, 6)
    expect(dx * expected.x + dy * expected.y).toBeGreaterThan(0)
    // Шаг креста — полусегмент в обе стороны: длина штриха сверяется через
    // проектор той же точки сдвинутой (пиксель = мм × масштаб × проекция оси)
    const shifted = projector.project({ ...end, x: end.x + CUBE_CROSS_HALF_MM })
    const full = 2 * Math.hypot(shifted.x - projected.x, shifted.y - projected.y)
    expect(Math.hypot(dx, dy)).toBeCloseTo(full, 6)
  })
})

describe('куб диполей: режим стенок', () => {
  const input = (over: Partial<Parameters<typeof cubeWallsMode>[0]>) => ({
    focusCount: 0,
    frameBandCount: 0,
    frameActive: false,
    ...over,
  })

  it('один диполь в фокусе — срезы; несколько — силуэт', () => {
    expect(cubeWallsMode(input({ focusCount: 1 }))).toBe('slices')
    expect(cubeWallsMode(input({ focusCount: 2 }))).toBe('silhouette')
  })

  it('анимация нескольких полос — силуэт, одной — срезы', () => {
    expect(cubeWallsMode(input({ frameActive: true, frameBandCount: 3 }))).toBe('silhouette')
    expect(cubeWallsMode(input({ frameActive: true, frameBandCount: 1 }))).toBe('slices')
    // Кадр не показан — анимации нет, правило не срабатывает
    expect(cubeWallsMode(input({ frameActive: false, frameBandCount: 3 }))).toBe('slices')
  })

  it('ручная настройка переопределяет авто-правило', () => {
    expect(resolveWallsMode('silhouette', input({ focusCount: 0 }))).toBe('silhouette')
    expect(resolveWallsMode('slices', input({ focusCount: 5 }))).toBe('slices')
    expect(resolveWallsMode('auto', input({ focusCount: 5 }))).toBe('silhouette')
  })
})

describe('куб диполей: токены цвета', () => {
  it('вынимает имя токена из var(...), готовый цвет не трогает', () => {
    expect(cssTokenOf('var(--color-mri-dipole)')).toBe('--color-mri-dipole')
    expect(cssTokenOf('hsl(210, 85%, 60%)')).toBe('')
    expect(cssTokenOf('')).toBe('')
  })
})

