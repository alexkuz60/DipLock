/**
 * Геометрия радиального графика секции «Визуализация» «Нейромузыки»
 * (спецификация владельца 07.10.2026): круг разделён на 7 одинаковых
 * сегментов, сегмент 1 начинается с π/2 + π/7 и далее — против часовой
 * стрелки шагом 2π/7; круги сетки — 25/50/75 % радиуса.
 *
 * Чистая математика без DOM (углы → точки SVG) — покрыта
 * `radialChart.test.ts`, рисует `RadialChart.tsx`.
 */

/** Число сегментов = число полос партитуры (`BAND_ORDER` из `bandLabels.ts`). */
export const RADIAL_SEGMENTS = 7

/** Доли радиуса кругов радиальной сетки: 25 %, 50 %, 75 %. */
export const GRID_FRACTIONS: readonly number[] = [0.25, 0.5, 0.75]

/** Начальный угол сегмента 1, рад: π/2 + π/7 (граница, отсчёт — против часовой). */
export const SEGMENT_START = Math.PI / 2 + Math.PI / 7

/** Ширина сегмента, рад: 2π/7. */
export const SEGMENT_STEP = (2 * Math.PI) / RADIAL_SEGMENTS

/**
 * Углы лучей-разделителей, рад: π/2 + π/7 + k·2π/7, k = 0…RADIAL_SEGMENTS−1.
 * Порядок — против часовой стрелки; длина ровно `RADIAL_SEGMENTS`,
 * соседние отличаются на `SEGMENT_STEP`.
 */
export function segmentBoundaries(): number[] {
  return Array.from({ length: RADIAL_SEGMENTS }, (_, index) => SEGMENT_START + index * SEGMENT_STEP)
}

export type RadialPoint = {
  /** x в координатах SVG (вправо) */
  x: number
  /** y в координатах SVG (вниз — потому угол «вверх» даёт отрицательный y) */
  y: number
}

/**
 * Точка на окружности: угол отсчитывается от +X против часовой, центр —
 * начало координат графика (перенос на `center` выполняется здесь).
 */
export function pointAt(angle: number, radius: number, center: RadialPoint): RadialPoint {
  return {
    x: center.x + radius * Math.cos(angle),
    y: center.y - radius * Math.sin(angle),
  }
}

/**
 * Вершины полигона по семи лучам («семилучевая звезда» — так её назвал
 * владелец 07.10.2026: **точки отрисовки полигона по 7 лучам**): длина
 * вектора i-го луча — процент (0…100) от радиуса. Порядок — `BAND_ORDER`
 * из `bandLabels.ts` (от самой низкой к γ-high); сейчас рисуется со
 * случайными долями (`randomRayPercents`), расчёт по спектральной
 * мощности — отдельная тема (07.10.2026).
 *
 * `rotationRad` (09.10.2026, «Вращение звезды») — жёсткий поворот полигона
 * вокруг центра: **+ — против часовой** (мажор), **− — по часовой**
 * (минор); сетка и границы сегментов не вращаются. Угол кадра — из
 * тональности микса (`keyRotation.ts`), доминанты считаются после поворота.
 *
 * Значения зажимаются к 0…100; нечисловое/отсутствующее = 0 (вершина в
 * центре). Точки идут в порядке лучей против часовой — ровно
 * `RADIAL_SEGMENTS` вершин.
 */
export function starPolygon(
  values: readonly number[],
  radius: number,
  center: RadialPoint,
  rotationRad = 0,
): RadialPoint[] {
  return segmentBoundaries().map((angle, index) => {
    const value = values[index]
    const pct =
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(100, Math.max(0, value))
        : 0
    return pointAt(angle + rotationRad, (radius * pct) / 100, center)
  })
}

/** Нижняя граница случайной длины луча, % радиуса (0.1 × R). */
export const RANDOM_RAY_MIN_PCT = 10

/** Верхняя граница случайной длины луча, % радиуса (1.0 × R). */
export const RANDOM_RAY_MAX_PCT = 100

/**
 * Случайные доли лучей — **временный рандомизатор** до обсуждения расчёта
 * длины лучей (тема отдельная, 07.10.2026): 10…100 % радиуса = 0.1 × R …
 * 1.0 × R. `random` внедряется для детерминированных тестов (дефолт —
 * `Math.random`).
 */
export function randomRayPercents(random: () => number = Math.random): number[] {
  return Array.from({ length: RADIAL_SEGMENTS }, () =>
    RANDOM_RAY_MIN_PCT + (RANDOM_RAY_MAX_PCT - RANDOM_RAY_MIN_PCT) * random(),
  )
}

/**
 * **Доминанта**: точка на конце белой линии из центра — сумма компонент
 * («суммарные синусы и косинусы») семи вершин полигона: X = Σ (x_i − центр),
 * Y = Σ (y_i − центр), без деления на число вершин.
 *
 * При равных длинах лучей сумма = 0 (семь равномерных направлений), при
 * разных — указывает на «тяжёлую» сторону полигона. Длина суммы формально
 * достигает ~1.6 R (две смежные длинные вершины), поэтому вектор зажимается
 * к радиусу — доминанта не выходит за круг-границу. Точный масштаб/формула —
 * при подключении данных (отдельная тема, 07.10.2026).
 */
export function dominantPoint(
  vertices: readonly RadialPoint[],
  center: RadialPoint,
  radius: number,
): RadialPoint {
  let sumX = 0
  let sumY = 0
  for (const vertex of vertices) {
    sumX += vertex.x - center.x
    sumY += vertex.y - center.y
  }
  const length = Math.hypot(sumX, sumY)
  if (length > radius && length > 0) {
    sumX *= radius / length
    sumY *= radius / length
  }
  return { x: center.x + sumX, y: center.y + sumY }
}

/**
 * **Облако доминант** (08.10.2026): точка доминанты каждого кадра анимации
 * «Эмо» — для кадра его лучи собираются в вершины (`starPolygon`) и сводятся
 * к точке суммы компонент (`dominantPoint`). Порядок — порядок кадров;
 * пустой список кадров → пустое облако. Рисует `RadialChart.tsx` мелкими
 * кругами; **суммарная доминанта** облака — см. :func:`totalDominant`.
 *
 * `rotation` кадра (09.10.2026, «Вращение звезды») — угол поворота полигона
 * из тональности микса: доминанта кадра считается **после вращения**
 * (спецификация владельца), отсутствие угла = без поворота.
 */
export function dominantCloud(
  frames: readonly { readonly rays: readonly number[]; readonly rotation?: number }[],
  radius: number,
  center: RadialPoint,
): RadialPoint[] {
  return frames.map((frame) =>
    dominantPoint(
      starPolygon(frame.rays, radius, center, frame.rotation ?? 0),
      center,
      radius,
    ),
  )
}

/**
 * **Суммарная доминанта облака** (правка 08.10.2026): сумма компонент всех
 * точек доминант, **нормированная на число точек** (центроид/среднее) —
 * направление совпадает с суммой, но длина не растёт с числом кадров.
 *
 * Жалоба владельца 08.10.2026: «сырая» сумма на любом реальном миксе
 * (десятки и тысячи кадров) всегда упиралась в зажим к кругу-границе —
 * вектор лежал на ободе почти в одном месте для разных записей. Центроид
 * по построению лежит **внутри выпуклой оболочки облака** (зажим к
 * `radius` остаётся лишь страховкой). Пустое облако → точка центра.
 */
export function totalDominant(
  points: readonly RadialPoint[],
  center: RadialPoint,
  radius: number,
): RadialPoint {
  if (points.length === 0) return { x: center.x, y: center.y }
  let sumX = 0
  let sumY = 0
  for (const point of points) {
    sumX += point.x - center.x
    sumY += point.y - center.y
  }
  let x = sumX / points.length
  let y = sumY / points.length
  const length = Math.hypot(x, y)
  if (length > radius && length > 0) {
    x *= radius / length
    y *= radius / length
  }
  return { x: center.x + x, y: center.y + y }
}