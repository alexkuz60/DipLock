/**
 * Контуры атласа на срезах (срез 3.9): ссылка, геометрия и хит-тест.
 *
 * Сервер отдаёт контуры **вектором** (`GET /surface/contours/{plane}/{mm}`):
 * замкнутые полигоны в миллиметрах MNI по осям плоскости, одним ассетом для
 * анатомических структур (`aparc+aseg`) и полей Бродмана. Модуль занимается тем,
 * что превращает эти миллиметры в фигуру и в ответ на клик:
 *
 * * срез квантуется к сетке атласа (`sliceImageMm` — та же функция, что у
 *   картинок МРТ): контур существует только на узлах 1 мм, и URL обязан быть
 *   целым узлом, иначе браузер закэширует десять копий одного среза;
 * * в URL идёт версия ассета (`?v=`) — после пересборки атласа старые контуры не
 *   должны «залипнуть» в кэше браузера;
 * * мм → нормализованные координаты фигуры идут через **знаки осей**
 *   (`PLANE_HORIZONTAL_SIGN`/`mniToNormalized`): раскладка контура и картинки
 *   среза считается одним кодом, иначе контур «уехал» бы относительно среза;
 * * попадание клика считается по **тем же** полигонам, что нарисованы
 *   (`shapeAtPoint`), — «второго, невидимого» слоя для мыши в разделе нет.
 *
 * Модуль чистый (без DOM и zustand): арифметика покрыта `atlasContours.test.ts`,
 * отрисовка — `sections/dipoles/MriProjection.tsx`.
 */
import type { ContourShape, ContourSlice, ContoursRef } from '@/shared/api/types'
import {
  PLANE_HORIZONTAL_SIGN,
  PLANE_VERTICAL_SIGN,
  PROJECTION_PADDING,
  axisExtent,
  normalizedToPx,
  planeAxisLabels,
  type MniPoint2,
  type ProjectionPlane,
} from './mriProjections'
import { sliceImageMm } from './mriSlices'

/** Срез, на котором существует контур: сетка атласа (1 мм). */
export function contourSliceMm(
  plane: ProjectionPlane,
  valueMm: number,
  spacingMm: number,
): number {
  return sliceImageMm(plane, valueMm, spacingMm)
}

/**
 * URL контуров среза. Версия ассета — в строке запроса: без неё браузер отдавал бы
 * старые контуры после пересборки атласа.
 */
export function contourSliceUrl(
  ref: ContoursRef,
  plane: ProjectionPlane,
  valueMm: number,
): string {
  const mm = contourSliceMm(plane, valueMm, ref.spacing_mm)
  return `${ref.url}/${plane}/${mm}?v=${ref.version}`
}

/**
 * Точка контура (мм по осям плоскости) → нормализованные координаты фигуры.
 *
 * Знаки осей применяются здесь, а не на сервере: сервер отдаёт «сырые» мм MNI
 * (горизонталь, вертикаль), а радиологическая раскладка — свойство экрана.
 */
export function contourPointToNormalized(
  plane: ProjectionPlane,
  point: [number, number],
): MniPoint2 {
  const { horizontal, vertical } = planeAxisLabels(plane)
  const h = axisExtent(horizontal)
  const v = axisExtent(vertical)
  return {
    u: PLANE_HORIZONTAL_SIGN[plane] * ((point[0] - h.center) / h.half),
    v: PLANE_VERTICAL_SIGN[plane] * ((point[1] - v.center) / v.half),
  }
}

/** Контур метки как атрибут `d` для `<path>` (заливка по правилу even-odd). */
export function contourPathPx(
  plane: ProjectionPlane,
  shape: ContourShape,
  padding = PROJECTION_PADDING,
): string {
  return shape.hulls
    .map((hull) => {
      const points = hull
        .map((point) => normalizedToPx(contourPointToNormalized(plane, point), plane, padding))
        .map((pixel) => `${pixel.x.toFixed(2)} ${pixel.y.toFixed(2)}`)
        .join(' L ')
      return `M ${points} Z`
    })
    .join(' ')
}

/** Попадание точки фигуры в **один** полигон (алгоритм трассировки луча). */
function pointInPolygon(ring: MniPoint2[], point: MniPoint2): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]
    const b = ring[j]
    const crosses = a.v > point.v !== b.v > point.v
    if (crosses && point.u < ((b.u - a.u) * (point.v - a.v)) / (b.v - a.v) + a.u) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Попадание точки фигуры в метку: полигоны пересчитываются в нормализованные
 * координаты и складываются по правилу even-odd (дырки вычитаются).
 */
export function shapeContainsPoint(
  plane: ProjectionPlane,
  shape: ContourShape,
  point: MniPoint2,
): boolean {
  let inside = false
  for (const hull of shape.hulls) {
    if (hull.length < 3) continue
    if (pointInPolygon(hull.map((vertex) => contourPointToNormalized(plane, vertex)), point)) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Метка под точкой фигуры (`null` — попадание вне контуров).
 *
 * Перебор идёт **от мелких к крупным**: сервер отдаёт метки по убыванию площади,
 * а белое вещество накрывает подкорковые структуры — клик по таламусу должен
 * называть таламус, а не «белое вещество».
 */
export function shapeAtPoint(
  shapes: ContourShape[],
  plane: ProjectionPlane,
  point: MniPoint2,
): ContourShape | null {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    if (shapeContainsPoint(plane, shapes[index], point)) return shapes[index]
  }
  return null
}

/** Подписи меток, которые встречаются на срезе (для строки состояния раздела). */
export function contourSummary(slice: ContourSlice | null): {
  structures: number
  areas: number
} {
  return {
    structures: slice?.structures.length ?? 0,
    areas: slice?.areas.length ?? 0,
  }
}

/** Пояснение к подписи для недоступного ассета контуров. */
export const CONTOURS_UNAVAILABLE =
  'контуры атласа недоступны: проверьте aparc+aseg.mgz и PALS_B12_Brodmann на сервере'

/**
 * Пометка о производности BA-разметки: метки PALS живут на поверхности коры, в
 * объём они переносятся по ближайшей вершине — это не измеренный атлас среза,
 * и UI обязан это говорить (как «Быстрый режим» у расчёта диполей).
 */
export const CONTOURS_METHOD_HINT =
  'Поля Бродмана размечены производно: метка ближайшей вершины коры PALS_B12_Brodmann (nearest_cortex_vertex)'
