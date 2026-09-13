/**
 * Чистая математика вьюера треков ЭЭГ: временные окна, дискретный зум,
 * панорамирование и min/max-огибающая.
 *
 * Всё здесь — чистые функции без DOM и uPlot: они же покрыты тестами
 * (canvas и uPlot в jsdom не рендерятся, поэтому логика отделена от отрисовки).
 */

export type TimeWindow = { t0: number; t1: number }

/** Окно всей записи (уровень ×1). */
export function fullWindow(durationSec: number): TimeWindow {
  return { t0: 0, t1: durationSec }
}

/** Зажимает центр окна так, чтобы окно не вылезало за границы записи. */
export function clampCenter(centerSec: number, widthSec: number, totalSec: number): number {
  if (widthSec >= totalSec) return totalSec / 2
  return Math.min(Math.max(centerSec, widthSec / 2), totalSec - widthSec / 2)
}

/** Окно ширины ``totalSec / factor`` вокруг центра (с зажимом в границы). */
export function zoomWindow(totalSec: number, factor: number, centerSec: number): TimeWindow {
  const width = totalSec / factor
  const center = clampCenter(centerSec, width, totalSec)
  return { t0: center - width / 2, t1: center + width / 2 }
}

/** Центр окна. */
export function windowCenter(window: TimeWindow): number {
  return (window.t0 + window.t1) / 2
}

/**
 * Сдвиг окна при панорамировании на ``dxPx`` пикселей.
 * Положительный dx (тянем вправо) двигает окно в прошлое.
 */
export function panByPixels(
  centerSec: number,
  dxPx: number,
  window: TimeWindow,
  widthPx: number,
  totalSec: number,
): number {
  const secPerPx = widthPx > 0 ? (window.t1 - window.t0) / widthPx : 0
  return clampCenter(centerSec - dxPx * secPerPx, window.t1 - window.t0, totalSec)
}

/**
 * Новый центр окна при зуме с якорем в точке курсора: точка под курсором
 * остаётся на той же относительной позиции в окне.
 */
export function anchoredCenter(
  cursorSec: number,
  fraction: number,
  newWidthSec: number,
  totalSec: number,
): number {
  const center = cursorSec + (0.5 - fraction) * newWidthSec
  return clampCenter(center, newWidthSec, totalSec)
}

export type Envelope = {
  /** Времена центров корзин (секунды) */
  times: Float32Array
  /** Минимум в корзине (мкВ) */
  min: Float32Array
  /** Максимум в корзине (мкВ) */
  max: Float32Array
  /** true — корзинное прореживание; false — исходные отсчёты без агрегации */
  decimated: boolean
}

/** Индекс первого элемента, который не меньше ``value`` (времена возрастают). */
function lowerBound(times: Float32Array, value: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] as number) < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Индекс первого элемента, который больше ``value``. */
function upperBound(times: Float32Array, value: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((times[mid] as number) <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Min/max-огибающая окна для кадра сигнала: корзины по ``maxPoints`` штук.
 *
 * Кадр приходит по уровням зума (docs/ui.md §8): ``times`` — времена центров
 * корзин, ``min``/``max`` — границы огибающей по каналу. Функция отбирает
 * корзины, попавшие в окно, и, если их больше бюджета области, агрегирует
 * **min по min и max по max** — пики артефактов не исчезают ни на каком зуме.
 *
 * ``sourceDecimated`` отмечает, был ли кадр уже прорежен сервером: это нужно
 * только для подписи «огибающая» в UI, на данные не влияет.
 */
export function frameEnvelope(
  times: Float32Array,
  min: ArrayLike<number>,
  max: ArrayLike<number>,
  window: TimeWindow,
  maxPoints: number,
  sourceDecimated = false,
): Envelope {
  const budget = Math.max(1, Math.floor(maxPoints))
  const from = lowerBound(times, window.t0)
  const to = Math.max(from, upperBound(times, window.t1))
  const count = to - from

  if (count <= budget) {
    const outTimes = times.slice(from, to)
    return {
      times: outTimes,
      min: Float32Array.from({ length: count }, (_, i) => min[from + i] as number),
      max: Float32Array.from({ length: count }, (_, i) => max[from + i] as number),
      decimated: sourceDecimated,
    }
  }

  const outTimes = new Float32Array(budget)
  const outMin = new Float32Array(budget)
  const outMax = new Float32Array(budget)
  const perBucket = count / budget
  for (let b = 0; b < budget; b++) {
    const start = from + Math.floor(b * perBucket)
    const end = Math.min(to, from + Math.floor((b + 1) * perBucket))
    let lo = Infinity
    let hi = -Infinity
    for (let i = start; i < end; i++) {
      const valueMin = min[i] as number
      const valueMax = max[i] as number
      if (valueMin < lo) lo = valueMin
      if (valueMax > hi) hi = valueMax
    }
    outTimes[b] = times[Math.min(end - 1, start)] as number
    outMin[b] = lo
    outMax[b] = hi
  }
  return { times: outTimes, min: outMin, max: outMax, decimated: true }
}

/** Число точек на канал при заданной ширине области: бюджет 2× ширины. */
export function pointsBudget(widthPx: number): number {
  return Math.max(64, Math.floor(widthPx) * 2)
}

/**
 * Пиксель окна для момента времени: ширина области — `trackWidth` (без колонки
 * подписей каналов). Обратная функция к `xToTime`; вместе они держат курсор,
 * зоны артефактов и границы эпох в одной системе координат.
 */
export function timeToX(timeSec: number, window: TimeWindow, trackWidth: number): number {
  const span = window.t1 - window.t0
  if (span <= 0) return 0
  return ((timeSec - window.t0) / span) * trackWidth
}

/** Момент времени под пикселем окна (обратная к `timeToX`). */
export function xToTime(xPx: number, window: TimeWindow, trackWidth: number): number {
  const span = window.t1 - window.t0
  if (trackWidth <= 0) return window.t0
  return window.t0 + (xPx / trackWidth) * span
}
