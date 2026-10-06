/**
 * Трекер-плеер «Нейромузыки»: математика и отрисовка волны-бабочки,
 * окна горизонтального зума, линейки времени и позиционера
 * (docs/rules/neuromusic.md, §«Плеер-трекер»).
 *
 * Стиль «бабочка»: положительная полуволна ЛЕВОГО канала вверх от линии нуля,
 * отрицательная полуволна ПРАВОГО — вниз (как на энцефалограмме). Math-часть
 * чистая (без Tone и Web Audio) — юнит-тестируется отдельно; отрисовка терпит
 * `getContext` без 2D (jsdom) — просто ничего не рисует.
 */

/** Варианты горизонтального зума: во сколько раз окно уже всего файла. */
export const TIME_ZOOMS = [1, 10, 100] as const
export type TimeZoom = (typeof TIME_ZOOMS)[number]

/**
 * Скорости проигрывания: только замедление. ×0.5 — слуховой контроль быстрых
 * перемещений по записи, в итоговый файл не попадает; понижение высоты тона
 * и искажения при замедлении допустимы (уточнение владельца 06.10.2026),
 * поэтому PitchShift-компенсации нет — только `playbackRate`.
 */
export const PLAYBACK_RATES = [0.5, 1] as const
export type PlaybackRate = (typeof PLAYBACK_RATES)[number]

/** Пики «бабочки» по колонкам (1 колонка ≈ 1 пиксель ширины × зум). */
export type ButterflyPeaks = {
  /** Максимум положительной полуволны левого канала (≥ 0) */
  up: Float32Array
  /** Модуль минимума отрицательной полуволны правого канала (≥ 0, рисуется вниз) */
  down: Float32Array
  maxUp: number
  maxDown: number
}

/**
 * Число колонок пиков: ширина в пикселях × зум, но не больше числа отсчётов
 * (иначе часть колонок была бы пустой — волна «рванула» бы пробелами).
 */
export function peakColumns(widthPx: number, zoom: number, samples: number): number {
  const width = Math.max(1, Math.round(widthPx))
  const total = Math.max(1, Math.floor(samples))
  return Math.max(1, Math.min(width * Math.max(1, zoom), total))
}

/**
 * Пики по всему файлу: один проход по каждому каналу, колонка = диапазон
 * отсчётов. Глобальные `maxUp`/`maxDown` нормируют амплитуду, чтобы при
 * прокрутке окна волна не «дышала».
 */
export function filePeaks(
  left: Float32Array,
  right: Float32Array,
  columns: number,
): ButterflyPeaks {
  const count = Math.max(1, Math.floor(columns))
  const up = new Float32Array(count)
  const down = new Float32Array(count)
  const samples = Math.max(left.length, right.length, 1)
  let maxUp = 0
  let maxDown = 0
  for (let column = 0; column < count; column++) {
    const from = Math.floor((column * samples) / count)
    const to = Math.min(samples, Math.max(from + 1, Math.floor(((column + 1) * samples) / count)))
    let peakUp = 0
    let peakDown = 0
    for (let i = from; i < to; i++) {
      const l = i < left.length ? left[i] : 0
      if (l > peakUp) peakUp = l
      const r = i < right.length ? right[i] : 0
      if (r < -peakDown) peakDown = -r
    }
    up[column] = peakUp
    down[column] = peakDown
    if (peakUp > maxUp) maxUp = peakUp
    if (peakDown > maxDown) maxDown = peakDown
  }
  return { up, down, maxUp, maxDown }
}

/** Видимое окно времени, сек. */
export type ViewState = { start: number; end: number }

/**
 * Окно зума: `duration / zoom` секунд с якорем на позиции позиционера.
 *
 * Окно не двигается, пока якорь внутри внутренней зоны (15…85 % окна) —
 * позиционер «гуляет» по волне и перескакивает только у края, иначе при ×100
 * волна ползла бы под зафиксированным центром сплошняком. `prevStart` —
 * старт текущего окна (`null` — посчитать заново).
 */
export function viewWindow(
  duration: number,
  zoom: number,
  anchor: number,
  prevStart: number | null = null,
): ViewState {
  if (!(duration > 0)) return { start: 0, end: 0 }
  const span = duration / Math.max(1, zoom)
  const maxStart = duration - span
  if (prevStart !== null && prevStart >= 0 && prevStart <= maxStart) {
    const innerStart = prevStart + span * 0.15
    const innerEnd = prevStart + span * 0.85
    if (anchor >= innerStart && anchor <= innerEnd) {
      return { start: prevStart, end: prevStart + span }
    }
  }
  const start = Math.min(Math.max(0, anchor - span / 2), maxStart)
  return { start, end: start + span }
}

/** Время → пиксель внутри окна (0…width). */
export function timeToX(time: number, view: ViewState, width: number): number {
  const span = view.end - view.start
  if (!(span > 0) || !(width > 0)) return 0
  return ((time - view.start) / span) * width
}

/** Пиксель внутри окна → время, сек (без обрезки — обрезает вызывающий seek). */
export function xToTime(x: number, view: ViewState, width: number): number {
  const span = view.end - view.start
  if (!(span > 0) || !(width > 0)) return 0
  return view.start + (x / width) * span
}

/** «Красивые» шаги линейки времени: 1/2/5×10ⁿ (для малых окон — доли секунды). */
const RULER_STEPS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
]

/** Деления линейки: время + подпись; шаг подбирается ≈ span/targetCount. */
export function rulerTicks(
  view: ViewState,
  targetCount = 8,
): { time: number; label: string }[] {
  const span = view.end - view.start
  if (!(span > 0)) return []
  const ideal = span / Math.max(2, targetCount)
  const step = RULER_STEPS.find((value) => value >= ideal) ?? RULER_STEPS[RULER_STEPS.length - 1]
  const ticks: { time: number; label: string }[] = []
  const first = Math.ceil(view.start / step - 1e-9)
  const last = Math.floor(view.end / step + 1e-9)
  for (let index = first; index <= last && ticks.length <= 64; index++) {
    const time = index * step
    ticks.push({ time, label: formatTime(time, step < 1) })
  }
  return ticks
}

/**
 * М:СС для таймкода и линейки; `tenths` — с десятыми (узкие окна зума ×100,
 * где шаг линейки меньше секунды).
 */
export function formatTime(seconds: number, tenths = false): string {
  const rounded = Math.round((Number.isFinite(seconds) ? Math.max(0, seconds) : 0) * 10) / 10
  const minutes = Math.floor(rounded / 60)
  const rest = rounded - minutes * 60
  const secs = Math.floor(rest + 1e-9)
  const base = `${minutes}:${String(secs).padStart(2, '0')}`
  if (!tenths) return base
  const tenth = Math.round((rest - secs) * 10)
  return `${base}.${Math.min(9, tenth)}`
}

/** Цвета трекера: токены темы Tailwind с детерминированными фоллбэками. */
export type TrackerTheme = {
  /** Положительная полуволна левого канала (вверх от нуля) */
  waveUp: string
  /** Отрицательная полуволна правого канала (вниз от нуля) — другой цвет */
  waveDown: string
  zero: string
  grid: string
  text: string
  playhead: string
}

export function trackerTheme(): TrackerTheme {
  const color = (token: string, fallback: string): string => {
    if (typeof window === 'undefined') return fallback
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback
    } catch {
      return fallback
    }
  }
  return {
    waveUp: color('--color-nm-wave-up', '#4da3ff'),
    waveDown: color('--color-nm-wave-down', '#b98cff'),
    zero: color('--color-fg-1', '#c3ceda'),
    grid: color('--color-border', '#2c3a4d'),
    text: color('--color-fg-2', '#8695a8'),
    playhead: color('--color-fg-0', '#e8eef6'),
  }
}

/**
 * Готовит холст к рисованию: bitmap-размер = CSS-размер × devicePixelRatio
 * (иначе при dpr ≠ 1 картинка занимала бы долю области). Повторный вызов с
 * теми же размерами битмап не пересоздывает — `canvas.width = …` его чистит,
 * а на каждый кадр это недопустимо.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  widthPx: number,
  heightPx: number,
): CanvasRenderingContext2D | null {
  const scale = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const width = Math.max(1, Math.round(widthPx) * scale)
  const height = Math.max(1, Math.round(heightPx) * scale)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  return ctx
}

/**
 * Волна-бабочка в окне: вверх — левый канал (`waveUp`), вниз — правый
 * (`waveDown`, другой цвет); линия нуля — **последним штрихом поверх волны**
 * (уточнение владельца 06.10.2026). `peaks === null` (буфер ещё не загружен) —
 * рисуется только линия нуля.
 */
export function drawButterfly(
  ctx: CanvasRenderingContext2D,
  peaks: ButterflyPeaks | null,
  view: ViewState,
  duration: number,
  width: number,
  height: number,
  theme: TrackerTheme,
): void {
  ctx.clearRect(0, 0, width, height)
  const mid = Math.round(height / 2) + 0.5
  ctx.lineWidth = 1
  if (peaks && view.end > view.start) {
    const columns = peaks.up.length
    const from = Math.max(0, Math.floor((view.start / duration) * columns) - 1)
    const to = Math.min(columns, Math.ceil((view.end / duration) * columns) + 1)
    const amplitude = Math.max(peaks.maxUp, peaks.maxDown, 1e-9)
    const scale = (height / 2 - 1) / amplitude
    // Вверх — положительная полуволна левого канала.
    ctx.strokeStyle = theme.waveUp
    ctx.beginPath()
    for (let i = from; i < to; i++) {
      if (peaks.up[i] <= 0) continue
      const x = timeToX(((i + 0.5) / columns) * duration, view, width)
      ctx.moveTo(x, mid)
      ctx.lineTo(x, mid - peaks.up[i] * scale)
    }
    ctx.stroke()
    // Вниз — отрицательная полуволна правого канала (другой цвет).
    ctx.strokeStyle = theme.waveDown
    ctx.beginPath()
    for (let i = from; i < to; i++) {
      if (peaks.down[i] <= 0) continue
      const x = timeToX(((i + 0.5) / columns) * duration, view, width)
      ctx.moveTo(x, mid)
      ctx.lineTo(x, mid + peaks.down[i] * scale)
    }
    ctx.stroke()
  }
  // Линия нуля поверх волны — читается на любом цвете полуволн.
  ctx.strokeStyle = theme.zero
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(width, mid)
  ctx.stroke()
}

/** Линейка времени над волной: базовая линия, риски вниз и подписи над ними. */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  ticks: { time: number; label: string }[],
  view: ViewState,
  width: number,
  height: number,
  theme: TrackerTheme,
): void {
  ctx.clearRect(0, 0, width, height)
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.lineWidth = 1
  const baseY = Math.round(height) - 0.5
  ctx.strokeStyle = theme.grid
  ctx.fillStyle = theme.text
  ctx.beginPath()
  ctx.moveTo(0, baseY)
  ctx.lineTo(width, baseY)
  ctx.stroke()
  for (const tick of ticks) {
    const x = timeToX(tick.time, view, width)
    if (x < -20 || x > width + 20) continue
    const tickX = Math.round(x) + 0.5
    ctx.beginPath()
    ctx.moveTo(tickX, baseY)
    ctx.lineTo(tickX, baseY - 5)
    ctx.stroke()
    const labelWidth = ctx.measureText(tick.label).width
    const labelX = Math.min(x + 3, Math.max(0, width - labelWidth - 1))
    ctx.fillText(tick.label, labelX, 3)
  }
}

/**
 * Позиционер поверх сигнала: линия через линейку и волну + ручка сверху —
 * на отдельном холсте-оверлее, чтобы не перерисовывать волны на каждый кадр.
 */
export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  time: number,
  view: ViewState,
  width: number,
  height: number,
  theme: TrackerTheme,
): void {
  ctx.clearRect(0, 0, width, height)
  const x = timeToX(time, view, width)
  if (x < -2 || x > width + 2) return
  const playX = Math.round(x) + 0.5
  ctx.lineWidth = 1
  ctx.strokeStyle = theme.playhead
  ctx.beginPath()
  ctx.moveTo(playX, 0)
  ctx.lineTo(playX, height)
  ctx.stroke()
  ctx.fillStyle = theme.playhead
  ctx.beginPath()
  ctx.moveTo(playX - 5, 0)
  ctx.lineTo(playX + 5, 0)
  ctx.lineTo(playX, 7)
  ctx.closePath()
  ctx.fill()
}

