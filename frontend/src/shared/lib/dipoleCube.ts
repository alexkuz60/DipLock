/**
 * Геометрия 3D-вида «Куб» раздела «Диполи» (срез 3.13): срезы МРТ на стенках
 * куба, облако диполей внутри — как фигура MNE из туториала `20_dipole_fit.html`.
 *
 * Модуль чистый (без DOM и Niivue — вся арифметика проверяется Vitest без
 * WebGL), отрисовка — `sections/dipoles/DipoleCube.tsx`. Системы координат:
 *
 * * **MNI (мм)** — пространство точек диполей, срезов и границ головы
 *   (`MNI_BRAIN_BOUNDS`); мир тома fsaverage с ним совпадает
 *   (`brain3d.ts::worldEqualsMni`), поэтому перевод не нужен;
 * * **экран (px)** — ортографическая проекция: поворот камеры задаёт
 *   `CubeView` (азимут/тангаж), масштаб вписывает куб в канвас
 *   (`cubeProjector`). Ортографика, а не перспектива: прямоугольник среза
 *   проецируется аффинно и ложится в `ctx.setTransform` одним `drawImage`.
 *
 * Стенки куба (раскладка фигуры MNE): аксиальный срез — на полу (z = zmin),
 * сагиттальный — на левой дальней стенке (x = xmin), коронарный — на правой
 * дальней (y = ymin). Картинка на стенке — срез по общему состоянию «Срезы MNI»
 * (`SliceTriplet`, те же значения, что в 2D-проекциях и панели «Опции»), а
 * кресты отмечают **проекции** выделенного диполя: линии идут от точки
 * ортогонально к трём стенкам (`projectionLinesToWalls`).
 *
 * Правило честности срезов (`cubeWallsMode`): срез на стенке показывается,
 * только когда в фокусе **одна** точка (один диполь — одни срезы MNI). Когда
 * диполей в фокусе несколько (пакет эпохи из нескольких полос, анимация
 * нескольких полос) — каждый диполь «живёт» в своих срезах, и стенки
 * переключаются на проекции силуэта мозга (MIP `mip_url`, координата по нормали
 * им не нужна — они истинны при любом числе диполей).
 */
import {
  MNI_BRAIN_BOUNDS,
  PLANE_AXES,
  PLANE_AXIS,
  normalizedToMni,
  type MniAxis,
  type MniVector,
  type ProjectionPlane,
} from './mriProjections'

/** Ракурс камеры: азимут (° вокруг оси z, от +x к +y) и тангаж (° над горизонтом). */
export type CubeView = {
  azimuthDeg: number
  elevationDeg: number
}

/**
 * Стартовый ракурс: вид спереди-сверху-справа (камера в октанте +x +y +z),
 * поэтому все три дальней стенки (zmin / xmin / ymin) видны сразу — раскладка
 * как на фигуре MNE. «Сбросить ракурс» возвращает ровно его.
 */
export const CUBE_DEFAULT_VIEW: CubeView = { azimuthDeg: 45, elevationDeg: 25 }

/** Размер канваса куба, px. */
export type CubeSize = { width: number; height: number }

/** Поле вокруг куба, px: подписи осей и рамка не должны касаться края канваса. */
export const CUBE_PADDING_PX = 24

/** Точка экрана куба: пиксели плюс глубина (мм, больше — ближе к зрителю). */
export type CubeProjected = {
  x: number
  y: number
  depth: number
}

/** Базис камеры: единичные векторы «вправо», «вверх» и «к зрителю» (в MNI). */
export type CubeBasis = {
  right: MniVector
  up: MniVector
  toward: MniVector
}

/** Центр куба (центр границ головы), MNI. */
export const CUBE_CENTER: MniVector = {
  x: (MNI_BRAIN_BOUNDS.x[0] + MNI_BRAIN_BOUNDS.x[1]) / 2,
  y: (MNI_BRAIN_BOUNDS.y[0] + MNI_BRAIN_BOUNDS.y[1]) / 2,
  z: (MNI_BRAIN_BOUNDS.z[0] + MNI_BRAIN_BOUNDS.z[1]) / 2,
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function dot(a: MniVector, b: MniVector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function minus(a: MniVector, b: MniVector): MniVector {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function fromMni(point: MniVector): MniVector {
  return { x: point.x, y: point.y, z: point.z }
}

/**
 * Базис камеры от ракурса. Ось z остаётся «вверх» на экране при любом тангаже:
 * вектор вверх — ортогональная проекция мирового z на экран (при тангаже ±90°
 * базис вырождается — тангаж зажимается до ±89° при перетаскивании).
 */
export function cubeBasis(view: CubeView): CubeBasis {
  const azimuth = toRad(view.azimuthDeg)
  const elevation = toRad(view.elevationDeg)
  const cosAz = Math.cos(azimuth)
  const sinAz = Math.sin(azimuth)
  const cosEl = Math.cos(elevation)
  const sinEl = Math.sin(elevation)
  return {
    right: { x: -sinAz, y: cosAz, z: 0 },
    up: { x: -sinEl * cosAz, y: -sinEl * sinAz, z: cosEl },
    toward: { x: cosEl * cosAz, y: cosEl * sinAz, z: sinEl },
  }
}

/** Восемь углов куба головы (границы `MNI_BRAIN_BOUNDS`), MNI. */
export function cubeCorners(): MniVector[] {
  const corners: MniVector[] = []
  for (const x of MNI_BRAIN_BOUNDS.x) {
    for (const y of MNI_BRAIN_BOUNDS.y) {
      for (const z of MNI_BRAIN_BOUNDS.z) {
        corners.push({ x, y, z })
      }
    }
  }
  return corners
}

/**
 * Проектор куба: масштаб px/мм (куб вписан в канвас по спроецированным углам,
 * поэтому при повороте поле «дышит» — картинка всегда заполняет канвас, как
 * фигура MNE) и перевод MNI → пиксели + глубина.
 */
export type CubeProjector = {
  scale: number
  project: (point: MniVector) => CubeProjected
}

export function cubeProjector(
  view: CubeView,
  size: CubeSize,
  paddingPx: number = CUBE_PADDING_PX,
): CubeProjector {
  const basis = cubeBasis(view)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const corner of cubeCorners()) {
    const relative = minus(corner, CUBE_CENTER)
    const px = dot(relative, basis.right)
    const py = dot(relative, basis.up)
    minX = Math.min(minX, px)
    maxX = Math.max(maxX, px)
    minY = Math.min(minY, py)
    maxY = Math.max(maxY, py)
  }
  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)
  const width = Math.max(size.width - paddingPx * 2, 1)
  const height = Math.max(size.height - paddingPx * 2, 1)
  const scale = Math.min(width / spanX, height / spanY)
  return {
    scale,
    project: (point: MniVector): CubeProjected => {
      const relative = minus(point, CUBE_CENTER)
      return {
        x: size.width / 2 + dot(relative, basis.right) * scale,
        y: size.height / 2 - dot(relative, basis.up) * scale,
        depth: dot(relative, basis.toward),
      }
    },
  }
}

/**
 * Стенка куба: прямоугольник плоскости на границе головы, на котором лежит
 * картинка среза. Углы — в порядке пикселей картинки: [верх-лево, верх-право,
 * низ-лево, низ-право] (ориентация та же, что у `<image>` 2D-проекций).
 */
export type CubeWall = {
  plane: ProjectionPlane
  /** Координата нормали стенки, мм MNI (граница головы) */
  normalMm: number
  /** Углы прямоугольника, MNI: [tl, tr, bl, br] */
  corners: [MniVector, MniVector, MniVector, MniVector]
}

/**
 * Нормаль дальней стенки каждой плоскости: минимум своей оси (камера стартового
 * ракурса — в октанте +x +y +z, значит все три стенки у дальнего угла).
 */
export function cubeWallNormal(plane: ProjectionPlane): number {
  return MNI_BRAIN_BOUNDS[PLANE_AXIS[plane]][0]
}

/** Стенка куба: прямоугольник плоскости на дальней границе головы. */
export function cubeWall(
  plane: ProjectionPlane,
  normalMm: number = cubeWallNormal(plane),
): CubeWall {
  return {
    plane,
    normalMm,
    corners: [
      normalizedToMni(plane, normalMm, { u: -1, v: 1 }),
      normalizedToMni(plane, normalMm, { u: 1, v: 1 }),
      normalizedToMni(plane, normalMm, { u: -1, v: -1 }),
      normalizedToMni(plane, normalMm, { u: 1, v: -1 }),
    ],
  }
}

/** Все три стенки куба (аксиальная — пол, сагиттальная и коронарная — стены). */
export function cubeWalls(): CubeWall[] {
  return (['axial', 'sagittal', 'coronal'] as ProjectionPlane[]).map((plane) => cubeWall(plane))
}

/**
 * Аффинное отображение картинки стенки в пиксели канваса — аргументы
 * `ctx.setTransform(a, b, c, d, e, f)`. Ортография даёт аффинность: единичный
 * квадрат `drawImage(img, 0, 0, 1, 1)` ложится в спроецированный
 * параллелограмм по трём углам (4-й контрольный — проверка геометрии).
 */
export function wallImageTransform(
  wall: CubeWall,
  projector: CubeProjector,
): [number, number, number, number, number, number] {
  const [tl, tr, bl] = wall.corners
  const p0 = projector.project(tl)
  const p1 = projector.project(tr)
  const p2 = projector.project(bl)
  return [p1.x - p0.x, p1.y - p0.y, p2.x - p0.x, p2.y - p0.y, p0.x, p0.y]
}

/** Углы стенки в пикселях канваса (рамка стенки и порядок глубины). */
export function wallOutline(wall: CubeWall, projector: CubeProjector): CubeProjected[] {
  return wall.corners.map((corner) => projector.project(corner))
}



/** Полусегмент креста на стенке, мм: длина штриха проекции на стенке. */
export const CUBE_CROSS_HALF_MM = 6

/**
 * Линии проекции точки на три стенки: ортогонально к каждой (как красные
 * стрелки фигуры MNE). Конец линии — точка на плоскости стенки.
 */
export type CubeProjectionLine = {
  plane: ProjectionPlane
  /** Конец линии на стенке, MNI */
  end: MniVector
}

export function projectionLinesToWalls(point: MniVector): CubeProjectionLine[] {
  return [
    { plane: 'axial', end: { x: point.x, y: point.y, z: cubeWallNormal('axial') } },
    { plane: 'sagittal', end: { x: cubeWallNormal('sagittal'), y: point.y, z: point.z } },
    { plane: 'coronal', end: { x: point.x, y: cubeWallNormal('coronal'), z: point.z } },
  ]
}

/** Отрезок на экране (штрих креста проекции). */
export type CubeSegment = {
  from: CubeProjected
  to: CubeProjected
}

/**
 * Крест проекции на стенке: два отрезка вдоль осей своей плоскости (то же
 * направление, что у осей 2D-проекции), центр — конец линии проекции.
 */
export function projectionCross(
  wall: CubeWall,
  at: MniVector,
  projector: CubeProjector,
  halfMm: number = CUBE_CROSS_HALF_MM,
): CubeSegment[] {
  const [horizontal, vertical] = PLANE_AXES[wall.plane]
  const shift = (axis: MniAxis, delta: number): MniVector => {
    const moved = fromMni(at)
    moved[axis] += delta
    return moved
  }
  return [
    {
      from: projector.project(shift(horizontal, -halfMm)),
      to: projector.project(shift(horizontal, halfMm)),
    },
    {
      from: projector.project(shift(vertical, -halfMm)),
      to: projector.project(shift(vertical, halfMm)),
    },
  ]
}

/**
 * Режим стенок: `slices` — срезы МРТ по «Срезам MNI», `silhouette` — проекции
 * силуэта мозга (MIP). Срез честен только для одного диполя в фокусе; несколько
 * диполей (пакет/анимация полос) живут в разных срезах MNI — стенки показывают
 * силуэт, которому координата среза не нужна.
 */
export type CubeWallsMode = 'slices' | 'silhouette'

/** Настройка стенок вида: `auto` — по правилу ниже, иначе принудительно. */
export type CubeWallsSetting = 'auto' | CubeWallsMode

export function cubeWallsMode(input: {
  /** Точек в фокусе: пакет выбранной эпохи или [выделенная точка] */
  focusCount: number
  /** Кадров анимации с точкой (полосы «Полосы в анимации и облаке») */
  frameBandCount: number
  /** Кадр анимации показан (Плей или пауза со снятым кадром) */
  frameActive: boolean
}): CubeWallsMode {
  if (input.frameActive && input.frameBandCount > 1) return 'silhouette'
  if (input.focusCount > 1) return 'silhouette'
  return 'slices'
}

/** Итоговый режим стенок: ручная настройка переопределяет авто-правило. */
export function resolveWallsMode(
  setting: CubeWallsSetting,
  input: Parameters<typeof cubeWallsMode>[0],
): CubeWallsMode {
  return setting === 'auto' ? cubeWallsMode(input) : setting
}

/**
 * Имя токена из строки `var(--color-…)`: canvas не понимает `var(...)`, а
 * `themeColor` (`shared/lib/theme.ts`) ждёт имя токена. Пустая строка —
 * «не токен» (готовый цвет: `hsl(...)` полосы пакета).
 */
export function cssTokenOf(color: string): string {
  const match = /var\((--[a-z0-9-]+)\)/i.exec(color.trim())
  return match ? match[1] : ''
}
