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
import type { AudioKeySegment, AudioTempoSegment } from '@/shared/api/types'


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
  /** Глобальный максимум вверх по файлу (справочно: на ×1 он же опорный) */
  maxUp: number
  /** Глобальный максимум вниз по файлу (справочно: на ×1 он же опорный) */
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
 * отсчётов. Глобальные `maxUp`/`maxDown` — максимумы всего файла (справочные:
 * масштаб рисунка берёт максимум видимого окна — авто-вертикальный зум, см.
 * `drawButterfly`; на зуме ×1 окно = файлу и результат совпадает).
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
  /** Вертикальные линии смены аккордов (аннотации Соник Аннотатора) */
  chordLine: string
  /** Ступенчатая линия темпа (аннотации Соник Аннотатора) */
  tempoLine: string
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
    chordLine: color('--color-nm-chord', '#7ee0ff'),
    tempoLine: color('--color-nm-tempo', '#ffb454'),
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
 *
 * **Авто-вертикальный зум** (приёмка 07.10.2026): масштаб амплитуды считается
 * по максимуму полуволн **видимого окна** — тихий участок при горизонтальном
 * зуме растягивается на всю высоту вьюера. На ×1 окно = файлу, так что берётся
 * тот же глобальный максимум, что и раньше; линия нуля всегда в центре высоты.
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
    // Авто-вертикальный зум: опорная амплитуда — максимум видимого окна
    // (полуволны обоих каналов), а не глобальный max файла.
    let amplitude = 1e-9
    for (let i = from; i < to; i++) {
      if (peaks.up[i] > amplitude) amplitude = peaks.up[i]
      if (peaks.down[i] > amplitude) amplitude = peaks.down[i]
    }
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

/**
 * Аннотации Соник Аннотатора поверх волны (docs/rules/neuromusic.md,
 * §«Плеер-трекер», «Аннотации»): вертикальные линии смены аккордов
 * (`key_track`) и ступенчатый график темпа (`tempo_track`). Вызываются после
 * `drawButterfly` на том же холсте — это статика видимого окна (перерисовка —
 * вместе с волной).
 */

/**
 * Вертикальные линии-аннотации смены аккордов: одна линия на начало каждого
 * сегмента тональности (`t_sec`), на всю высоту волны. Сегмент в 0.0 — это
 * левый край файла, а не смена, поэтому не рисуется; линии вне видимого окна
 * пропускаются. `key_track` пуст/`null` — ничего не рисуется.
 */
export function drawKeyLines(
  ctx: CanvasRenderingContext2D,
  keyTrack: readonly AudioKeySegment[] | null | undefined,
  view: ViewState,
  width: number,
  height: number,
  theme: TrackerTheme,
): void {
  if (!keyTrack || keyTrack.length === 0 || view.end <= view.start || !(width > 0)) return
  ctx.lineWidth = 1
  ctx.strokeStyle = theme.chordLine
  ctx.beginPath()
  for (const segment of keyTrack) {
    if (!(segment.t_sec > 0)) continue
    const x = Math.round(timeToX(segment.t_sec, view, width)) + 0.5
    if (x < 0 || x > width) continue
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
  }
  ctx.stroke()
}

/**
 * Диапазон bpm трека темпа (min…max по всем оценкам) — авто-шкала ступеней.
 * Нет валидных оценок — `null`.
 */
export function tempoBpmRange(
  tempoTrack: readonly AudioTempoSegment[] | null | undefined,
): { min: number; max: number } | null {
  if (!tempoTrack || tempoTrack.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const estimate of tempoTrack) {
    if (!Number.isFinite(estimate.bpm) || estimate.bpm <= 0) continue
    if (estimate.bpm < min) min = estimate.bpm
    if (estimate.bpm > max) max = estimate.bpm
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null
}

/**
 * Y ступени темпа, px: авто-шкала `range` → полоса **15…85 %** высоты волны
 * (min — нижняя граница полосы, max — верхняя: больший темп — выше линия).
 * Все оценки равны (`max <= min`) — середина высоты.
 */
export function tempoStepY(
  bpm: number,
  range: { min: number; max: number },
  height: number,
): number {
  const top = height * 0.15
  const bottom = height * 0.85
  if (!(range.max > range.min)) return height / 2
  const frac = (bpm - range.min) / (range.max - range.min)
  return bottom - Math.min(1, Math.max(0, frac)) * (bottom - top)
}

/**
 * Ступенчатый график изменения темпа: горизонтальные ступени на высоте
 * `tempoStepY(bpm)` от оценки до следующей (hold-семантика сырых данных
 * Соник Аннотатора; после последней оценки — до конца окна), вертикальные
 * фронты смены темпа между ступенями. До первой оценки линии нет; `tempo_track`
 * пуст/`null` — ничего не рисуется. Шкала — авто min…max по всему треку
 * (решение владельца 09.10.2026: мелкие девиации темпа видны).
 */
export function drawTempoSteps(
  ctx: CanvasRenderingContext2D,
  tempoTrack: readonly AudioTempoSegment[] | null | undefined,
  view: ViewState,
  width: number,
  height: number,
  theme: TrackerTheme,
): void {
  const range = tempoBpmRange(tempoTrack)
  if (!tempoTrack || !range || view.end <= view.start || !(width > 0)) return
  const sorted = [...tempoTrack].sort((a, b) => a.t_sec - b.t_sec)
  ctx.lineWidth = 2
  ctx.strokeStyle = theme.tempoLine
  ctx.beginPath()
  let lastY: number | null = null
  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index]
    if (!current || !Number.isFinite(current.bpm) || current.bpm <= 0) continue
    // Ступень [t_i, t_{i+1}) пересекается с окном; последняя держится до конца.
    const start = Math.max(current.t_sec, view.start)
    const end =
      index + 1 < sorted.length ? Math.min(sorted[index + 1]?.t_sec ?? view.end, view.end) : view.end
    const x1 = timeToX(start, view, width)
    const x2 = timeToX(end, view, width)
    if (x2 <= x1) continue
    const y = tempoStepY(current.bpm, range, height)
    // Фронт смены темпа: вертикаль от прошлой ступени к текущей (не у края).
    if (lastY !== null && x1 > 0 && lastY !== y) {
      ctx.moveTo(x1, lastY)
      ctx.lineTo(x1, y)
    }
    ctx.moveTo(x1, y)
    ctx.lineTo(x2, y)
    lastY = y
  }
  ctx.stroke()
}

