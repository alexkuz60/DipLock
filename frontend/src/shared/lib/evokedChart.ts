/** Геометрия графика ERP-волны (шаг 2.7): чистая математика для статичного SVG. */

export type EvokedChartTick = { pos: number; label: string }

export type EvokedChartGeometry = {
  width: number
  height: number
  /** Точки полилинии кривой, «x,y» через пробел (viewBox-пиксели) */
  polyline: string
  /** X момента события (t=0) — вертикальная линия стимула */
  zeroX: number
  xTicks: EvokedChartTick[]
  yTicks: EvokedChartTick[]
}

const WIDTH = 480
const HEIGHT = 160
const PAD_LEFT = 36
const PAD_RIGHT = 8
const PAD_TOP = 8
const PAD_BOTTOM = 20

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Собирает SVG-геометрию усреднённой волны: X — мс от события, Y — µV.
 * Шкала Y симметрична вокруг нуля (волна ERP читается от базовой линии),
 * крайние подписи — min/max сигнала.
 */
export function evokedChart(
  times: readonly number[],
  dataUv: readonly number[],
): EvokedChartGeometry {
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM
  const tMin = times.length ? (times[0] as number) : 0
  const tMax = times.length ? (times[times.length - 1] as number) : 1
  const span = tMax - tMin || 1

  const absMax = Math.max(1e-3, ...dataUv.map((value) => Math.abs(value)))
  const toX = (timeSec: number) => PAD_LEFT + ((timeSec - tMin) / span) * plotWidth
  const toY = (uv: number) => PAD_TOP + plotHeight / 2 - (uv / absMax) * (plotHeight / 2)

  const polyline = times
    .map((timeSec, index) => `${round1(toX(timeSec))},${round1(toY(dataUv[index] ?? 0))}`)
    .join(' ')

  return {
    width: WIDTH,
    height: HEIGHT,
    polyline,
    zeroX: round1(toX(Math.min(Math.max(0, tMin), tMax))),
    xTicks: [
      { pos: round1(toX(tMin)), label: `${round1(tMin * 1000)}` },
      { pos: round1(toX(0)), label: '0' },
      { pos: round1(toX(tMax)), label: `${round1(tMax * 1000)}` },
    ],
    yTicks: [
      { pos: round1(toY(absMax)), label: `+${round1(absMax)}` },
      { pos: round1(toY(0)), label: '0' },
      { pos: round1(toY(-absMax)), label: `${round1(-absMax)}` },
    ],
  }
}
