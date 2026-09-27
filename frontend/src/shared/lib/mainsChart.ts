import type { MainsResponse } from '@/shared/api/types'
import type { ChartTick } from './filterResponseChart'

/**
 * Геометрия SVG трассы сетевого фона (Части 1 §7): чистая функция без DOM.
 *
 * Трасса — до 30 000 точек (60 с × 500 Гц): SVG-`polyline` такого не тянет,
 * поэтому сначала **min/max-декадимация** по бакетам (внутри бакета min и max
 * в хронологическом порядке — форма волны не «схлопывается», тот же приём,
 * что в пирамиде сигналов DPS1), и только потом проекция в viewBox. Ось Y
 * всегда симметрична вокруг нуля (переменная составляющая — колебание),
 * минимум ±1 мкВ, чтобы пустая линия не раздувалась до масштаба шума.
 */
export type MainsChartGeometry = {
  width: number
  height: number
  /** Точки `<polyline>` в координатах viewBox: «x,y x,y …» */
  points: string
  /** Диапазон времени, с (фактическое окно) */
  xDomain: [number, number]
  /** Диапазон амплитуды, мкВ */
  yDomain: [number, number]
  xTicks: ChartTick[]
  yTicks: ChartTick[]
}

/** Сколько бакетов min/max на график: ≤ 960 точек polyline */
const DEFAULT_BUCKETS = 480

/** Индексы min и max бакета в хронологическом порядке */
function bucketExtremes(
  values: readonly number[],
  from: number,
  to: number,
): [number, number] {
  let minIndex = from
  let maxIndex = from
  for (let i = from + 1; i < to; i++) {
    if (values[i] < values[minIndex]) minIndex = i
    if (values[i] > values[maxIndex]) maxIndex = i
  }
  return minIndex <= maxIndex ? [minIndex, maxIndex] : [maxIndex, minIndex]
}

export function mainsChart(
  mains: Pick<
    MainsResponse,
    'trace_times_sec' | 'trace_uv' | 'start_sec' | 'duration_sec'
  >,
  width = 320,
  height = 110,
  buckets = DEFAULT_BUCKETS,
): MainsChartGeometry {
  const times = mains.trace_times_sec
  const values = mains.trace_uv
  const count = Math.min(times.length, values.length)
  const xDomain: [number, number] = [
    mains.start_sec,
    mains.start_sec + Math.max(mains.duration_sec, 1e-9),
  ]
  const peak = count ? Math.max(...Array.from(values.slice(0, count), Math.abs)) : 0
  const limit = Math.max(peak * 1.1, 1)
  const yDomain: [number, number] = [-limit, limit]

  if (count === 0) {
    return { width, height, points: '', xDomain, yDomain, xTicks: [], yTicks: [] }
  }

  // min/max-декадимация: по бакету на ~1 с окна, но не больше исходных точек
  const size = Math.min(buckets, Math.ceil(count / 2))
  const step = count / size
  const kept: number[] = []
  for (let bucket = 0; bucket < size; bucket++) {
    const from = Math.floor(bucket * step)
    const to = Math.min(count, Math.max(from + 1, Math.floor((bucket + 1) * step)))
    kept.push(...bucketExtremes(values, from, to))
  }

  const xOf = (t: number) =>
    ((t - xDomain[0]) / (xDomain[1] - xDomain[0])) * width
  const yOf = (v: number) =>
    height - ((Math.max(-limit, Math.min(limit, v)) + limit) / (2 * limit)) * height
  const points = kept
    .map((index) => `${xOf(times[index]).toFixed(1)},${yOf(values[index]).toFixed(1)}`)
    .join(' ')

  const xTicks: ChartTick[] = Array.from({ length: 4 }, (_, i) => {
    const pos = (i / 3) * width
    const value = xDomain[0] + (i / 3) * (xDomain[1] - xDomain[0])
    return { pos, label: value.toFixed(1) }
  })
  const yTicks: ChartTick[] = [
    { pos: yOf(limit), label: `+${limit.toFixed(1)}` },
    { pos: yOf(0), label: '0' },
    { pos: yOf(-limit), label: `−${limit.toFixed(1)}` },
  ]
  return { width, height, points, xDomain, yDomain, xTicks, yTicks }
}

/** Подпись уровней L1: «50 Гц +18.4 дБ · 100 Гц +7.2 дБ» (0 — не измерено) */
export function mainsLevelsText(mains: Pick<MainsResponse, 'freqs_hz' | 'level_db'>): string {
  return mains.freqs_hz
    .map((freq, index) => {
      const level = mains.level_db[index] ?? 0
      return `${freq} Гц ${level > 0 ? `+${level}` : level} дБ`
    })
    .join(' · ')
}
