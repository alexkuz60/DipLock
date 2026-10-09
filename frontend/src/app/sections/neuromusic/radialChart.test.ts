import { describe, expect, it } from 'vitest'
import {
  GRID_FRACTIONS,
  RADIAL_SEGMENTS,
  RANDOM_RAY_MAX_PCT,
  RANDOM_RAY_MIN_PCT,
  SEGMENT_START,
  SEGMENT_STEP,
  dominantCloud,
  dominantPoint,
  pointAt,
  randomRayPercents,
  segmentBoundaries,
  starPolygon,
  tempoStarPolygon,
  totalDominant,
} from './radialChart'

describe('radialChart — геометрия радиального графика', () => {
  it('круг делится на 7 одинаковых сегментов: шаг 2π/7', () => {
    expect(RADIAL_SEGMENTS).toBe(7)
    expect(SEGMENT_STEP).toBeCloseTo((2 * Math.PI) / 7, 12)
    expect(RADIAL_SEGMENTS * SEGMENT_STEP).toBeCloseTo(2 * Math.PI, 12)
  })

  it('сегмент 1 начинается с π/2 + π/7, границы идут против часовой шагом 2π/7', () => {
    const boundaries = segmentBoundaries()
    expect(boundaries).toHaveLength(RADIAL_SEGMENTS)
    expect(SEGMENT_START).toBeCloseTo(Math.PI / 2 + Math.PI / 7, 12)
    expect(boundaries[0]).toBeCloseTo(Math.PI / 2 + Math.PI / 7, 12)
    // Против часовой = рост угла; соседние границы ровно на шаг шире.
    for (let index = 1; index < boundaries.length; index++) {
      expect(boundaries[index] - boundaries[index - 1]).toBeCloseTo(SEGMENT_STEP, 12)
    }
    // Все границы различимы (модуль 2π — седьмые доли, повторов нет).
    const normalized = boundaries.map((angle) => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))
    expect(new Set(normalized.map((angle) => angle.toFixed(9))).size).toBe(RADIAL_SEGMENTS)
  })

  it('сегмент 1 — сразу против часовой от верха: граница правее оси +Y', () => {
    // π/2 + π/7 > π/2: первый сегмент начинается выше и левее верха графика.
    expect(SEGMENT_START).toBeGreaterThan(Math.PI / 2)
    expect(SEGMENT_START - Math.PI / 2).toBeCloseTo(Math.PI / 7, 12)
    // Замыкающая граница (k = 6) уходит за 2π — круг без разрывов.
    const boundaries = segmentBoundaries()
    expect(boundaries[boundaries.length - 1]).toBeCloseTo(SEGMENT_START + 6 * SEGMENT_STEP, 12)
    expect(SEGMENT_START + 6 * SEGMENT_STEP).toBeGreaterThan(2 * Math.PI)
  })

  it('радиальная сетка — три круга: 25 %, 50 %, 75 % радиуса', () => {
    expect(GRID_FRACTIONS).toEqual([0.25, 0.5, 0.75])
  })

  it('pointAt: угол от +X против часовой, y инвертирован (SVG — вниз)', () => {
    const center = { x: 100, y: 100 }
    // 0 — вправо, π/2 — вверх, π — влево, 3π/2 — вниз.
    const right = pointAt(0, 10, center)
    expect(right.x).toBeCloseTo(110, 12)
    expect(right.y).toBeCloseTo(100, 12)
    const top = pointAt(Math.PI / 2, 10, center)
    expect(top.x).toBeCloseTo(100, 12)
    expect(top.y).toBeCloseTo(90, 12)
    const left = pointAt(Math.PI, 10, center)
    expect(left.x).toBeCloseTo(90, 12)
    expect(left.y).toBeCloseTo(100, 12)
    const bottom = pointAt((3 * Math.PI) / 2, 10, center)
    expect(bottom.x).toBeCloseTo(100, 12)
    expect(bottom.y).toBeCloseTo(110, 12)
  })

  it('starPolygon: 7 вершин по лучам, длина = процент от радиуса', () => {
    const center = { x: 100, y: 100 }
    const radius = 90
    const values = [10, 20, 30, 40, 50, 60, 70]
    const points = starPolygon(values, radius, center)
    expect(points).toHaveLength(RADIAL_SEGMENTS)
    // Вершина i лежит на своём луче на расстоянии radius × pct / 100.
    segmentBoundaries().forEach((angle, index) => {
      const expected = pointAt(angle, (radius * values[index]) / 100, center)
      expect(points[index].x).toBeCloseTo(expected.x, 10)
      expect(points[index].y).toBeCloseTo(expected.y, 10)
    })
    // 100 % — каждая вершина на самой окружности (круг-границе).
    const onCircle = starPolygon([100, 100, 100, 100, 100, 100, 100], radius, center)
    onCircle.forEach((point, index) => {
      const expected = pointAt(segmentBoundaries()[index], radius, center)
      expect(point.x).toBeCloseTo(expected.x, 10)
      expect(point.y).toBeCloseTo(expected.y, 10)
    })
  })

  it('starPolygon: зажим 0…100, нечисловые = центр, короткий массив добивается', () => {
    const center = { x: 100, y: 100 }
    const [clamped, negative, invalid] = starPolygon([150, -5, Number.NaN], 90, center)
    // 150 % → 100 % (окружность), −5 и NaN → 0 % (центр).
    const angle0 = segmentBoundaries()[0]
    expect(clamped.x).toBeCloseTo(pointAt(angle0, 90, center).x, 10)
    expect(clamped.y).toBeCloseTo(pointAt(angle0, 90, center).y, 10)
    expect(negative).toEqual(center)
    expect(invalid).toEqual(center)
    // Массив короче семи лучей — недостающие вершины в центре.
    const short = starPolygon([50], 90, center)
    expect(short).toHaveLength(RADIAL_SEGMENTS)
    expect(short[1]).toEqual(center)
  })

  it('randomRayPercents: 7 долей в диапазоне 0.1…1.0 радиуса (10…100 %)', () => {
    expect(RANDOM_RAY_MIN_PCT).toBe(10)
    expect(RANDOM_RAY_MAX_PCT).toBe(100)
    expect(randomRayPercents(() => 0)).toEqual([10, 10, 10, 10, 10, 10, 10])
    expect(randomRayPercents(() => 1)).toEqual([100, 100, 100, 100, 100, 100, 100])
    // Порядок вызовов random: одна доля на каждый луч.
    const sequence = [0, 0.5, 1, 0.25, 0.75, 1, 0]
    let call = 0
    const values = randomRayPercents(() => sequence[call++])
    expect(values).toHaveLength(RADIAL_SEGMENTS)
    expect(values[0]).toBe(10)
    expect(values[1]).toBeCloseTo(55, 10)
    expect(values[2]).toBe(100)
    expect(values[3]).toBeCloseTo(32.5, 10)
    expect(values[6]).toBe(10)
  })

  it('dominantPoint: сумма компонент вершин, зажатая к кругу-границе', () => {
    const center = { x: 100, y: 100 }
    // Равные длины: 7 равномерных направлений в сумме дают центр.
    const even = starPolygon([100, 100, 100, 100, 100, 100, 100], 90, center)
    const atCenter = dominantPoint(even, center, 90)
    expect(atCenter.x).toBeCloseTo(100, 6)
    expect(atCenter.y).toBeCloseTo(100, 6)
    // Сумма в пределах круга проходит без зажима: 7 × 5 px вправо = 35.
    const inside = dominantPoint(
      Array.from({ length: RADIAL_SEGMENTS }, () => ({ x: 105, y: 100 })),
      center,
      90,
    )
    expect(inside.x).toBeCloseTo(135, 10)
    expect(inside.y).toBeCloseTo(100, 10)
    // Сумма за кругом — вектор зажимается к радиусу (не выходит за границу).
    const outside = dominantPoint(
      Array.from({ length: RADIAL_SEGMENTS }, () => ({ x: 300, y: 100 })),
      center,
      90,
    )
    expect(outside.x).toBeCloseTo(190, 10)
    expect(outside.y).toBeCloseTo(100, 10)
    expect(Math.hypot(outside.x - 100, outside.y - 100)).toBeCloseTo(90, 10)
  })

  it('dominantCloud: одна точка на кадр = dominantPoint(starPolygon(rays))', () => {
    const center = { x: 100, y: 100 }
    const frames = [
      { rays: [100, 0, 0, 0, 0, 0, 0] },
      { rays: [10, 20, 30, 40, 50, 60, 70] },
      { rays: [0, 0, 0, 0, 0, 0, 100] },
    ]
    const cloud = dominantCloud(frames, 90, center)
    expect(cloud).toHaveLength(frames.length)
    frames.forEach((frame, index) => {
      const expected = dominantPoint(starPolygon(frame.rays, 90, center), center, 90)
      expect(cloud[index]?.x).toBeCloseTo(expected.x, 10)
      expect(cloud[index]?.y).toBeCloseTo(expected.y, 10)
      // Точка доминанты кадра всегда внутри круга-границы.
      expect(Math.hypot((cloud[index]?.x ?? 0) - 100, (cloud[index]?.y ?? 0) - 100)).toBeLessThanOrEqual(
        90 + 1e-6,
      )
    })
    // Равные лучи семи направлений → доминанта в центре.
    const [even] = dominantCloud([{ rays: [100, 100, 100, 100, 100, 100, 100] }], 90, center)
    expect(even?.x).toBeCloseTo(100, 6)
    expect(even?.y).toBeCloseTo(100, 6)
    // Нет кадров — пустое облако (ничего не рисуется).
    expect(dominantCloud([], 90, center)).toEqual([])
  })

  it('totalDominant: центроид облака — среднее компонент, не сырая сумма', () => {
    const center = { x: 100, y: 100 }
    // Контрольные точки: среднее (5 + 10)/2, (0 + 5)/2 → (107.5, 102.5).
    const total = totalDominant(
      [
        { x: 105, y: 100 },
        { x: 110, y: 105 },
      ],
      center,
      90,
    )
    expect(total.x).toBeCloseTo(107.5, 10)
    expect(total.y).toBeCloseTo(102.5, 10)
    // Регрессия (жалоба 08.10.2026): сырая сумма множества точек упиралась
    // в зажим к ободу графика. Среднее 50 одинаковых сдвигов = сам сдвиг
    // (5 px), без всякого зажима.
    const many = Array.from({ length: 50 }, () => ({ x: 105, y: 100 }))
    const mean = totalDominant(many, center, 90)
    expect(mean.x).toBeCloseTo(105, 10)
    expect(mean.y).toBeCloseTo(100, 10)
    expect(Math.hypot(mean.x - 100, mean.y - 100)).toBeCloseTo(5, 10)
    // Пустое облако — центр (круг не рисуется).
    expect(totalDominant([], center, 90)).toEqual(center)
  })

  it('totalDominant: точка всегда внутри облака (bbox точек), а не на ободе', () => {
    const center = { x: 100, y: 100 }
    const frames = [
      { rays: [100, 0, 0, 0, 0, 0, 0] },
      { rays: [0, 100, 0, 0, 0, 0, 0] },
      { rays: [0, 0, 0, 50, 0, 0, 0] },
      { rays: [10, 20, 30, 40, 50, 60, 70] },
      { rays: [90, 90, 90, 90, 90, 90, 90] },
    ]
    const cloud = dominantCloud(frames, 90, center)
    const total = totalDominant(cloud, center, 90)
    const xs = cloud.map((point) => point.x)
    const ys = cloud.map((point) => point.y)
    // Центроид по построению не выходит за границы облака…
    expect(total.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-9)
    expect(total.x).toBeLessThanOrEqual(Math.max(...xs) + 1e-9)
    expect(total.y).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-9)
    expect(total.y).toBeLessThanOrEqual(Math.max(...ys) + 1e-9)
    // …и для этого облака не лежит на ободе круга-границы.
    expect(Math.hypot(total.x - 100, total.y - 100)).toBeLessThan(90)
  })
})

describe('radialChart — вращение звезды (09.10.2026)', () => {
  it('starPolygon: rotationRad поворачивает вершины против часовой (+)', () => {
    const center = { x: 100, y: 100 }
    const values = [100, 0, 0, 0, 0, 0, 0]
    const rot = 0.3
    const rotated = starPolygon(values, 90, center, rot)
    const plain = starPolygon(values, 90, center)
    // Вершина 0 — на своём луче + угол поворота (жёсткий поворот вокруг центра).
    expect(rotated[0]?.x).toBeCloseTo(100 + 90 * Math.cos(SEGMENT_START + rot), 6)
    expect(rotated[0]?.y).toBeCloseTo(100 - 90 * Math.sin(SEGMENT_START + rot), 6)
    // Длины не меняются: расстояние до центра то же.
    const plainLen = Math.hypot((plain[0]?.x ?? 0) - 100, (plain[0]?.y ?? 0) - 100)
    const rotLen = Math.hypot((rotated[0]?.x ?? 0) - 100, (rotated[0]?.y ?? 0) - 100)
    expect(rotLen).toBeCloseTo(plainLen, 9)
  })

  it('dominantCloud: доминанта кадра считается после его вращения', () => {
    const center = { x: 100, y: 100 }
    const rays = [100, 0, 0, 0, 0, 0, 0]
    const rot = Math.PI / 7
    const [point] = dominantCloud([{ rays, rotation: rot }], 90, center)
    const expected = dominantPoint(starPolygon(rays, 90, center, rot), center, 90)
    expect(point?.x).toBeCloseTo(expected.x, 10)
    expect(point?.y).toBeCloseTo(expected.y, 10)
    // Без rotation — прежняя формула (аддитивность параметра).
    const [plain] = dominantCloud([{ rays }], 90, center)
    const plainExpected = dominantPoint(starPolygon(rays, 90, center), center, 90)
    expect(plain?.x).toBeCloseTo(plainExpected.x, 10)
    // Равные лучи → центр при любом повороте (семь равномерных направлений).
    const [even] = dominantCloud(
      [{ rays: [50, 50, 50, 50, 50, 50, 50], rotation: 1.2 }],
      90,
      center,
    )
    expect(even?.x).toBeCloseTo(100, 6)
    expect(even?.y).toBeCloseTo(100, 6)
  })
})

describe('radialChart — темп-коррекция (09.10.2026)', () => {
  it('tempoStarPolygon: вершины нижних квадрантов удлиняются при темпе < 120', () => {
    const center = { x: 100, y: 100 }
    const values = [40, 40, 40, 40, 40, 40, 40]
    const slow = tempoStarPolygon(values, 90, center, 0, 60) // Kr = 1
    const plain = tempoStarPolygon(values, 90, center)
    slow.forEach((point, index) => {
      const angle = ((SEGMENT_START + index * SEGMENT_STEP) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
      const isLower = angle >= Math.PI
      const expected = 90 * (isLower ? 0.8 : 0.4) // 40·(1+1) = 80 либо 40
      expect(Math.hypot(point.x - 100, point.y - 100)).toBeCloseTo(expected, 6)
      if (!isLower) {
        expect(point.x).toBeCloseTo(plain[index]?.x ?? 0, 9)
      }
    })
  })

  it('dominantCloud: доминанта кадра считается после темп-коррекции', () => {
    const center = { x: 100, y: 100 }
    const rays = [100, 0, 0, 0, 0, 0, 0]
    const [point] = dominantCloud([{ rays, tempo: 240 }], 90, center)
    // Вершина 0 (SEGMENT_START < π → верх) удваивается при темпе 240, но
    // 200 % → нормализация к max = 100 %: одна вершина = 90 px, как без
    // коррекции; доминанта совпадает с некорректированной.
    const expected = dominantPoint(starPolygon(rays, 90, center), center, 90)
    expect(point?.x).toBeCloseTo(expected.x, 9)
    expect(point?.y).toBeCloseTo(expected.y, 9)
    // Без tempo — прежняя формула (аддитивность параметра).
    const [plain] = dominantCloud([{ rays }], 90, center)
    expect(plain?.x).toBeCloseTo(expected.x, 9)
  })
})