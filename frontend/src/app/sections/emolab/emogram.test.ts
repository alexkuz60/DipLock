/**
 * Тесты математики «Эмограммы» (постановка владельца 21.10.2026): шкала Y
 * «Эмо» (14 линий с шагом π/7, «страх» — внизу = начало 1 сектора звезды),
 * доминанты кадров = облако звезды, столбики «Экспрессии Эмо» и ступени
 * «Динамики Эмо» (цвет — сектор радара угла).
 */
import { describe, expect, it } from 'vitest'
import { SEGMENT_START, dominantCloud } from '../neuromusic/radialChart'
import {
  EMO_LABELS,
  dominantSeries,
  emoAngleFraction,
  emoBars,
  emoCategoryIndex,
  emoHistogram,
  emoSteps,
  emoTimeX,
} from './emogram'

describe('Эмограмма: шкала «Эмо» и время', () => {
  it('EMO_LABELS: 14 эмоций снизу вверх, страх → агрессия', () => {
    expect(EMO_LABELS).toHaveLength(14)
    expect(EMO_LABELS).toEqual([
      'страх',
      'трагедия',
      'скорбь',
      'отвращение',
      'депрессия',
      'смирение',
      'безразличие',
      'интерес',
      'уверенность',
      'радость',
      'энтузиазм',
      'вдохновение',
      'эйфория',
      'агрессия',
    ])
  })

  it('emoAngleFraction: низ = SEGMENT_START, шаг π/7 = 1/14, полкруга = 0.5', () => {
    expect(emoAngleFraction(SEGMENT_START)).toBeCloseTo(0, 10)
    expect(emoAngleFraction(SEGMENT_START + Math.PI / 7)).toBeCloseTo(1 / 14, 10)
    expect(emoAngleFraction(SEGMENT_START + Math.PI)).toBeCloseTo(0.5, 10)
    expect(emoAngleFraction(SEGMENT_START + 6 * (Math.PI / 7))).toBeCloseTo(6 / 14, 10)
  })

  it('emoAngleFraction: шов круга сверху — за кругом и отрицательные углы', () => {
    expect(emoAngleFraction(SEGMENT_START + 2 * Math.PI)).toBeCloseTo(0, 10)
    expect(emoAngleFraction(SEGMENT_START - Math.PI / 7)).toBeCloseTo(13 / 14, 10)
    expect(emoAngleFraction(Number.NaN)).toBe(0)
  })

  it('emoTimeX: линейная шкала [0…duration] → [0…width] с зажимом', () => {
    expect(emoTimeX(0, 6, 300)).toBe(0)
    expect(emoTimeX(3, 6, 300)).toBe(150)
    expect(emoTimeX(10, 6, 300)).toBe(300)
    expect(emoTimeX(-1, 6, 300)).toBe(0)
    expect(emoTimeX(3, 0, 300)).toBe(0)
    expect(emoTimeX(3, 6, 0)).toBe(0)
  })
})

describe('Эмограмма: доминанты, столбики и ступени', () => {
  it('dominantSeries: одиночный луч = доминанта на своём луче звезды', () => {
    // Луч 0 (100 %) — доминанта в точке вершины 0 (угол SEGMENT_START);
    // луч 6 (100 %) — вершина 6 (угол SEGMENT_START + 6·2π/7 → доля 6/7).
    const series = dominantSeries([
      { tSec: 0, rays: [100, 0, 0, 0, 0, 0, 0] },
      { tSec: 1, rays: [0, 0, 0, 0, 0, 0, 100] },
    ])
    expect(series).toHaveLength(2)
    expect(series[0]?.radiusFrac).toBeCloseTo(1, 10)
    expect(series[0]?.angleRad).toBeCloseTo(SEGMENT_START, 10)
    expect(emoAngleFraction(series[0]?.angleRad ?? 0)).toBeCloseTo(0, 10)
    expect(series[1]?.radiusFrac).toBeCloseTo(1, 10)
    expect(emoAngleFraction(series[1]?.angleRad ?? 0)).toBeCloseTo(6 / 7, 10)
  })

  it('dominantSeries: те же точки, что облако доминант звезды (вращение + темп)', () => {
    const frames = [
      { tSec: 0, rays: [10, 20, 30, 40, 50, 60, 70], rotation: Math.PI / 42, tempo: 240 },
      { tSec: 1, rays: [70, 0, 35, 20, 0, 55, 10], rotation: -Math.PI / 21, tempo: null },
    ]
    const series = dominantSeries(frames)
    const cloud = dominantCloud(frames, 1, { x: 0, y: 0 })
    cloud.forEach((point, index) => {
      const expectedRadius = Math.hypot(point.x, point.y)
      const expectedAngle = ((Math.atan2(-point.y, point.x) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      expect(series[index]?.radiusFrac).toBeCloseTo(expectedRadius, 10)
      expect(series[index]?.angleRad).toBeCloseTo(expectedAngle, 10)
    })
  })

  it('dominantSeries: равные лучи и тишина — доминанта в центре (radiusFrac 0)', () => {
    const series = dominantSeries([
      { tSec: 0, rays: [50, 50, 50, 50, 50, 50, 50] },
      { tSec: 1, rays: [0, 0, 0, 0, 0, 0, 0] },
    ])
    expect(series[0]?.radiusFrac).toBeCloseTo(0, 10)
    expect(series[1]?.radiusFrac).toBe(0)
  })

  it('emoBars: высота = радиус-вектор (0…1), длина = кадр, цвет сектора Эмо', () => {
    const bars = emoBars(
      [
        { tSec: 0, radiusFrac: 0.5, angleRad: SEGMENT_START },
        { tSec: 1, radiusFrac: 0, angleRad: 0 },
        // Сектор 1 (δ/θ): угол на середине между границами 2π/7 и 4π/7.
        { tSec: 2, radiusFrac: 1, angleRad: SEGMENT_START + 3 * (Math.PI / 7) },
      ],
      1,
    )
    expect(bars).toEqual([
      { tSec: 0, lenSec: 1, height: 0.5, sector: 0 },
      { tSec: 2, lenSec: 1, height: 1, sector: 1 },
    ])
  })

  it('emoSteps: высота из угла доминанты, цвет — сектор радара угла', () => {
    const steps = emoSteps(
      [
        // Угол на начале 1 сектора → низ («страх»), сектор 0 (δ).
        { tSec: 0, radiusFrac: 1, angleRad: SEGMENT_START },
        // Сектор 1 (δ/θ): середина между границами 2π/7 и 4π/7.
        { tSec: 1, radiusFrac: 1, angleRad: SEGMENT_START + 3 * (Math.PI / 7) },
        // Сектор 6 (γ-high): середина между границами 12π/7 и 14π/7 (шов круга).
        { tSec: 2, radiusFrac: 1, angleRad: SEGMENT_START + 13 * (Math.PI / 7) },
        // Тишина: угол не определён — ступени нет.
        { tSec: 3, radiusFrac: 0, angleRad: 0 },
      ],
      1,
    )
    expect(steps).toHaveLength(3)
    expect(steps[0]).toEqual({ tSec: 0, lenSec: 1, yFrac: expect.closeTo(0, 10), sector: 0 })
    expect(steps[1]?.yFrac).toBeCloseTo(3 / 14, 10)
    expect(steps[1]?.sector).toBe(1)
    expect(steps[2]?.yFrac).toBeCloseTo(13 / 14, 10)
    expect(steps[2]?.sector).toBe(6)
    // Шаг ступени по времени — ровно 1 с (кадр анимации звезды).
    expect(steps.every((step) => step.lenSec === 1)).toBe(true)
  })
})

describe('Эмограмма: дБ-оптимизация столбиков экспрессии (23.10.2026)', () => {
  it('emoBars с полом −60 дБ: высота = лог-шкала радиус-вектора, набор тот же', () => {
    const series = [
      { tSec: 0, radiusFrac: 1, angleRad: SEGMENT_START },
      { tSec: 1, radiusFrac: 0.1, angleRad: SEGMENT_START },
      { tSec: 2, radiusFrac: 0.01, angleRad: SEGMENT_START },
    ]
    const bars = emoBars(series, 1, 'db-60')
    expect(bars).toHaveLength(3)
    expect(bars[0]?.height).toBeCloseTo(1, 12) // 0 дБ → 1
    expect(bars[1]?.height).toBeCloseTo(2 / 3, 12) // −20 дБ → 2/3
    expect(bars[2]?.height).toBeCloseTo(1 / 3, 12) // −40 дБ → 1/3
    // Набор столбиков фильтруется по исходному радиус-вектору (как ступени).
    expect(emoBars(series, 1, 'db-60').map((bar) => bar.tSec)).toEqual([0, 1, 2])
  })

  it('ступени «Динамики» не зависят от дБ-оптимизации (углы — инвариант)', () => {
    const series = [
      { tSec: 0, radiusFrac: 0.1, angleRad: SEGMENT_START + Math.PI },
      { tSec: 1, radiusFrac: 0.001, angleRad: SEGMENT_START + 3 * (Math.PI / 7) },
    ]
    const stepsRaw = emoSteps(series, 1)
    // Высота столбика переносится — ступени строятся из тех же углов.
    expect(emoBars(series, 1, 'db-40')[0]?.height).not.toBeCloseTo(0.1, 6)
    expect(stepsRaw[0]?.yFrac).toBeCloseTo(0.5, 10)
    expect(stepsRaw[1]?.yFrac).toBeCloseTo(3 / 14, 10)
    expect(stepsRaw).toHaveLength(2) // тихий кадр (0.001) не выпадает
  })

  it('пол −40 дБ: ниже пола — 0, без переноса — исходная высота', () => {
    const series = [{ tSec: 0, radiusFrac: 0.01, angleRad: SEGMENT_START }]
    expect(emoBars(series, 1, 'db-40')[0]?.height).toBe(0) // −40 дБ = пол окна
    expect(emoBars(series, 1)[0]?.height).toBeCloseTo(0.01, 12) // без переноса
    expect(emoBars(series, 1, null)[0]?.height).toBeCloseTo(0.01, 12)
  })
})

describe('Общая эмо-характеристика: категории и накопленные суммы (24.10.2026)', () => {
  it('emoCategoryIndex: категория i = сектор [SEGMENT_START + i·π/7, +π/7), шов круга', () => {
    expect(emoCategoryIndex(SEGMENT_START)).toBe(0) // «страх»
    expect(emoCategoryIndex(SEGMENT_START + Math.PI / 7 - 1e-9)).toBe(0)
    expect(emoCategoryIndex(SEGMENT_START + Math.PI / 7)).toBe(1) // «трагедия»
    expect(emoCategoryIndex(SEGMENT_START + 13 * (Math.PI / 7))).toBe(13) // «агрессия»
    // Шов круга: угол через 2π и отрицательный нормализуются в категорию 13/0.
    expect(emoCategoryIndex(SEGMENT_START + 2 * Math.PI - 1e-9)).toBe(13)
    expect(emoCategoryIndex(SEGMENT_START - 1e-9)).toBe(13)
    expect(emoCategoryIndex(Number.NaN)).toBe(0)
  })

  it('emoHistogram: накопленные суммы |D| по категориям, порядок страх → агрессия', () => {
    const rows = emoHistogram([
      { tSec: 0, radiusFrac: 0.5, angleRad: SEGMENT_START }, // «страх»
      { tSec: 1, radiusFrac: 0.25, angleRad: SEGMENT_START + 1e-9 }, // тоже «страх»
      { tSec: 2, radiusFrac: 0.75, angleRad: SEGMENT_START + Math.PI / 7 }, // «трагедия»
      { tSec: 3, radiusFrac: 0, angleRad: SEGMENT_START }, // тишина — мимо
    ])
    expect(rows).toHaveLength(14)
    expect(rows.map((row) => row.label)).toEqual([...EMO_LABELS])
    expect(rows[0]?.value).toBeCloseTo(0.75, 12) // 0.5 + 0.25
    expect(rows[1]?.value).toBeCloseTo(0.75, 12)
    expect(rows.slice(2).every((row) => row.value === 0)).toBe(true)
    // Сектор категории = floor(index/2): 2 эмоции на сектор радара.
    expect(rows[0]?.sector).toBe(0)
    expect(rows[1]?.sector).toBe(0)
    expect(rows[13]?.sector).toBe(6)
  })

  it('пустой ряд — 14 нулевых строк; суммы сырые (складываются |D| кадров)', () => {
    const empty = emoHistogram([])
    expect(empty).toHaveLength(14)
    expect(empty.every((row) => row.value === 0)).toBe(true)
    const sums = emoHistogram([
      { tSec: 0, radiusFrac: 0.3, angleRad: SEGMENT_START + 4 * (Math.PI / 7) },
      { tSec: 1, radiusFrac: 0.4, angleRad: SEGMENT_START + 4.5 * (Math.PI / 7) },
    ])
    expect(sums[4]?.value).toBeCloseTo(0.7, 12)
    expect(sums[4]?.label).toBe(EMO_LABELS[4])
  })
})