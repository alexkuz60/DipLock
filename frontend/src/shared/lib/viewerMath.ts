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

/**
 * Min/max-огибающая окна: корзины по ``maxPoints`` штук на канал.
 *
 * Не «пропуск точек», а агрегация: пики артефактов не исчезают при зуме
 * (это принципиальное требование docs/ui.md — артефакт должен быть виден
 * на любом уровне). Если окно влезает в бюджет — возвращаются исходные
 * отсчёты (min == max).
 */
export function envelopeOf(
  data: ArrayLike<number>,
  sfreq: number,
  window: TimeWindow,
  maxPoints: number,
): Envelope {
  const from = Math.max(0, Math.floor(window.t0 * sfreq))
  const to = Math.min(data.length, Math.ceil(window.t1 * sfreq))
  const n = Math.max(to - from, 0)
  const budget = Math.max(1, Math.floor(maxPoints))

  if (n <= budget) {
    const times = new Float32Array(n)
    const min = new Float32Array(n)
    const max = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      times[i] = (from + i) / sfreq
      min[i] = data[from + i] as number
      max[i] = data[from + i] as number
    }
    return { times, min, max, decimated: false }
  }

  const times = new Float32Array(budget)
  const min = new Float32Array(budget)
  const max = new Float32Array(budget)
  const perBucket = n / budget
  for (let b = 0; b < budget; b++) {
    const start = from + Math.floor(b * perBucket)
    const end = Math.min(to, from + Math.floor((b + 1) * perBucket))
    let lo = Infinity
    let hi = -Infinity
    for (let i = start; i < end; i++) {
      const value = data[i] as number
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
    times[b] = (start + end - 1) / (2 * sfreq)
    min[b] = lo
    max[b] = hi
  }
  return { times, min, max, decimated: true }
}

/** Число точек на канал при заданной ширине области: бюджет 2× ширины. */
export function pointsBudget(widthPx: number): number {
  return Math.max(64, Math.floor(widthPx) * 2)
}
