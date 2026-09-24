/**
 * Чистая геометрия и шкалы раздела «ЭЭГ»: два окна (трек и спектрограмма),
 * вертикальные линейки значений справа, таймлайн под каждой половиной.
 *
 * Раздел намеренно повторяет логику единой системы координат вьюера треков
 * (`viewerMath.ts`): окно по времени — те же `zoomWindow`/`clampCenter`, шкала
 * амплитуды — мкВ на деление, а не «высота в пикселях». Здесь живёт только то,
 * чего во вьюере нет: разделение области по вертикали (перетаскиваемый
 * разделитель), деления линеек значений и арифметика перетаскивания линеек.
 *
 * Почему линейки значений — **справа**, а не слева: слева стоит подпись канала
 * и шкалы («Fp1», «дБ»), и общая левая граница графиков у двух половин должна
 * совпадать пиксель в пиксель — иначе курсор, общий для трека и спектрограммы,
 * не совпал бы по вертикали. Ширина правого столбца одна на обе половины
 * (`EEG_VALUE_W`), поэтому столбцы значений тоже выстраиваются.
 *
 * Всё в модуле — чистые функции без DOM: canvas в jsdom не рисуется, поэтому
 * шкалы и разделение проверяются тестами как арифметика.
 */
import type { TimeWindow } from './viewerMath'
import { clampCenter, timeToX, xToTime, zoomWindow } from './viewerMath'

/** Левый столбец: подпись канала (трек) или подпись шкалы (спектрограмма), px */
export const EEG_LABEL_W = 76
/** Правый столбец значений (мкВ у трека, Гц у спектрограммы), px — общий для половин */
export const EEG_VALUE_W = 56
/** Полоса таймлайна под каждой половиной, px */
export const EEG_TIMELINE_H = 20
/** Минимальная высота половины: ниже не читается ни трек, ни спектрограмма */
export const EEG_MIN_HALF_H = 120
/** Высота разделителя между половинами, px */
export const EEG_SPLITTER_H = 8

/** Деления в половине по высоте: 2 вверх и 2 вниз от нуля трека */
export const AMPLITUDE_DIVISIONS = 4

/** Ряд шкал амплитуды (мкВ на деление) — шаг перетаскивания линейки и списка панели */
export const AMPLITUDE_UV_PER_DIV = [2, 5, 10, 20, 50, 100, 200, 500] as const

/** Границы окна дБ для палитры: от −60 до 0 дБ относительно потолка шкалы */
export const DB_RANGE_LIMITS: [number, number] = [-60, 0]

/** Деление линейки значений: значение, пиксель по вертикали и подпись */
export type ValueTick = {
  value: number
  y: number
  label: string
}

/** Деление таймлайна: время, пиксель по горизонтали и подпись */
export type TimeTick = {
  timeSec: number
  x: number
  label: string
}

/** Ширина области графика: контейнер минус столбцы подписи и значений. */
export function plotWidthPx(containerWidth: number): number {
  return Math.max(0, Math.floor(containerWidth) - EEG_LABEL_W - EEG_VALUE_W)
}

/** Левый край области графика — одна и та же точка у трека и спектрограммы. */
export function plotLeftPx(): number {
  return EEG_LABEL_W
}

/** Правый край области графика (начало столбца значений). */
export function plotRightPx(containerWidth: number): number {
  return plotLeftPx() + plotWidthPx(containerWidth)
}

/**
 * Пиксель времени **в области графика**: одна формула на холсты половин и на
 * полосу времени.
 *
 * Полоса времени раньше считала шкалу по всей ширине контейнера — вместе со
 * столбцом подписи слева и столбцом значений справа. Её деления и курсор уезжали
 * относительно сетки графика (у края окна — на ширину столбца), и по одной и той
 * же метке получались две разные секунды. Считайте время только этой функцией.
 */
export function plotTimeX(timeSec: number, window: TimeWindow, containerWidth: number): number {
  return plotLeftPx() + timeToX(timeSec, window, plotWidthPx(containerWidth))
}

/** Обратная к `plotTimeX`: время по пикселю интерфейса (клик по графику или полосе). */
export function plotTimeAtX(xPx: number, window: TimeWindow, containerWidth: number): number {
  return xToTime(xPx - plotLeftPx(), window, plotWidthPx(containerWidth))
}

/** Лежит ли момент внутри окна — условие показа курсора и маркеров. */
export function timeInWindow(timeSec: number, window: TimeWindow): boolean {
  return timeSec >= window.t0 && timeSec <= window.t1
}

/** Рамка окна на половине: края в пикселях области графика (ср. `plotTimeX`). */
export type WindowFrame = {
  x0: number
  x1: number
}

/**
 * Рамка видимой части записи (окно трека) внутри показанного окна половины.
 *
 * Нужна там, где половина показывает **не** то же окно, что трек: спектрограмма в
 * «обзоре» тянется на всю запись, и без рамки не видно, какой именно отрезок открыт
 * вверху (и куда попадёт следующий клик по «обзору»). Курсор при этом рисуется
 * внутри рамки — это и есть выбранная на ЭЭГ позиция.
 *
 * Когда окна совпадают, рамки нет: её место занимает весь график, а рамка «во весь
 * график» читалась бы как лишняя линия. Края зажимаются областью графика — окно
 * может выйти за показанный отрезок, если запись короче сетки расчёта.
 */
export function windowFrame(
  window: TimeWindow,
  shown: TimeWindow,
  containerWidth: number,
): WindowFrame | null {
  const left = plotLeftPx()
  const right = plotRightPx(containerWidth)
  if (!(shown.t1 > shown.t0) || right - left <= 0) return null
  const eps = (shown.t1 - shown.t0) * 1e-6
  if (window.t0 <= shown.t0 + eps && window.t1 >= shown.t1 - eps) return null
  const x0 = Math.max(left, plotTimeX(window.t0, shown, containerWidth))
  const x1 = Math.min(right, plotTimeX(window.t1, shown, containerWidth))
  if (x1 - x0 <= 1) return null
  return { x0, x1 }
}


/**
 * Зажимает долю верхней половины: обе половины не короче `EEG_MIN_HALF_H`.
 *
 * Если места не хватает даже на две минимальные половины (низкое окно),
 * отношение всё равно возвращается осмысленным — раскладка не «дёргается».
 */
export function clampSplitRatio(ratio: number, containerHeight: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  const available = Math.max(0, containerHeight - EEG_SPLITTER_H)
  if (available < 2 * EEG_MIN_HALF_H) return Math.min(1, Math.max(0, ratio))
  const minRatio = EEG_MIN_HALF_H / available
  return Math.min(1 - minRatio, Math.max(minRatio, ratio))
}

/** Высоты половин (вместе с их таймлайнами) при заданном отношении. */
export function splitHeights(
  containerHeight: number,
  ratio: number,
): { top: number; bottom: number } {
  const available = Math.max(0, containerHeight - EEG_SPLITTER_H)
  const clamped = clampSplitRatio(ratio, containerHeight)
  const top = Math.round(available * clamped)
  return { top, bottom: available - top }
}

/**
 * Высота холста половины, у которой есть полоса таймлайна: полоса живёт **внутри**
 * половины, а не рядом — иначе разделитель двигал бы таймлайн вместе с графиком.
 * Так устроена верхняя половина раздела «ЭЭГ» (полоса времени одна, под треком).
 */
export function halfCanvasHeight(halfHeight: number): number {
  return Math.max(0, Math.round(halfHeight) - EEG_TIMELINE_H)
}

/** Полуразмах шкалы трека, мкВ: два деления вверх и два вниз от нуля. */
export function amplitudeRangeUv(uvPerDiv: number): number {
  return (uvPerDiv * AMPLITUDE_DIVISIONS) / 2
}

/** Ближайшая шкала амплитуды из ряда: чужие значения из localStorage не «висят». */
export function normalizeAmplitudeUv(value: number): number {
  if (!Number.isFinite(value)) return AMPLITUDE_UV_PER_DIV[2]
  let best: number = AMPLITUDE_UV_PER_DIV[0]
  for (const candidate of AMPLITUDE_UV_PER_DIV) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate
  }
  return best
}

/** Следующая шкала амплитуды в ряду: `steps` > 0 — крупнее деление. */
export function stepAmplitudeUv(value: number, steps: number): number {
  const current = AMPLITUDE_UV_PER_DIV.indexOf(
    normalizeAmplitudeUv(value) as (typeof AMPLITUDE_UV_PER_DIV)[number],
  )
  const index = Math.min(
    AMPLITUDE_UV_PER_DIV.length - 1,
    Math.max(0, current + Math.trunc(steps)),
  )
  return AMPLITUDE_UV_PER_DIV[index] as number
}

/**
 * Перетаскивание линейки амплитуды: вниз — крупнее деление (шкала «растягивается»).
 * Шаг — одна позиция ряда на каждые 24 px, чтобы мелкое движение не «перескакивало».
 */
export function dragAmplitudeUv(startUv: number, dyPx: number): number {
  return stepAmplitudeUv(startUv, Math.trunc(dyPx / 24))
}


/** Деления линейки амплитуды: от −2 делений до +2, подпись — значение в мкВ. */
export function ampTicks(uvPerDiv: number, heightPx: number): ValueTick[] {
  const scale = normalizeAmplitudeUv(uvPerDiv)
  const half = amplitudeRangeUv(scale)
  const ticks: ValueTick[] = []
  for (let step = 0; step <= AMPLITUDE_DIVISIONS; step++) {
    const value = -half + (step * (2 * half)) / AMPLITUDE_DIVISIONS
    ticks.push({ value, y: valueToY(value, half, heightPx), label: formatUvTick(value) })
  }
  // Снизу вверх: рисуем в порядке возрастания y
  return ticks.sort((a, b) => a.y - b.y)
}

/** Пиксель по вертикали для значения шкалы: 0 — середина половины. */
export function valueToY(value: number, halfRange: number, heightPx: number): number {
  if (halfRange <= 0) return heightPx / 2
  return heightPx / 2 - (value / halfRange) * (heightPx / 2)
}

/** Позиция по вертикали → значение шкалы (обратная к `valueToY`). */
export function yToValue(yPx: number, halfRange: number, heightPx: number): number {
  if (heightPx <= 0) return 0
  return ((heightPx / 2 - yPx) / (heightPx / 2)) * halfRange
}

/**
 * Уровень сигнала под пикселем — обратная к `valueToY` по текущей шкале трека.
 *
 * Клик по треку отвечает на два вопроса сразу: «когда» (общий курсор) и «какой
 * уровень» (линия уровня) — так же, как клик по спектрограмме даёт время и частоту.
 * Обратная функция живёт рядом с прямой: разъехавшиеся формулы поставили бы линию
 * уровня не на ту подпись у линейки.
 */
export function yToAmplitudeUv(yPx: number, uvPerDiv: number, heightPx: number): number {
  return yToValue(yPx, amplitudeRangeUv(uvPerDiv), heightPx)
}

/** Подпись уровня сигнала (линия уровня на треке): целые мкВ, единица — в подписи. */
export function formatUvLevel(value: number): string {
  return `${Math.round(value)} мкВ`
}

/** Подпись деления амплитуды: без «+» у нуля, единица — в подписи оси. */
export function formatUvTick(value: number): string {
  if (Math.abs(value) < 1e-9) return '0'
  const rounded = Math.abs(value) < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return String(rounded)
}

/**
 * «Круглый» шаг шкалы: 1, 2, 5 × 10^k. Нужен и частотам, и времени — больших
 * делений на узком диапазоне не бывает.
 */
export function niceStep(span: number, targetCount: number): number {
  if (!(span > 0) || targetCount <= 0) return 1
  const raw = span / targetCount
  const power = Math.floor(Math.log10(raw))
  const base = 10 ** power
  const normalized = raw / base
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return factor * base
}

/** Деления линейки частот: снизу значение 0 Гц, сверху — верхняя частота сетки. */
export function freqTicks(
  fmin: number,
  fmax: number,
  heightPx: number,
  targetCount = 5,
  scale: FreqScale = 'lin',
): ValueTick[] {
  if (!(fmax > fmin)) return []
  if (scale === 'log') {
    const ticks: ValueTick[] = []
    for (const value of logFreqTicks(fmin, fmax)) {
      ticks.push({
        value,
        y: fmaxToY(value, fmin, fmax, heightPx, 'log'),
        label: formatHzTick(value),
      })
    }
    return ticks
  }
  const step = niceStep(fmax - fmin, targetCount)
  const ticks: ValueTick[] = []
  // Первое деление — кратно шагу от 0 Гц: линейка читается как шкала, а не набор чисел
  for (let value = Math.ceil(fmin / step) * step; value <= fmax + 1e-9; value += step) {
    ticks.push({
      value,
      y: fmaxToY(value, fmin, fmax, heightPx),
      label: formatHzTick(value),
    })
  }
  return ticks
}

/**
 * Шкала частот спектрограммы (N18): `lin` — как раньше, `log` — логарифмическая.
 *
 * Лог-ось определена от 1 Гц: 0 Гц в логарифм не входит, а весь измеримый ЭЭГ-ритм
 * лежит выше. Ось — **параметр просмотра**: он меняет картинку, а не числа задачи.
 */
export type FreqScale = 'lin' | 'log'

/** Нижняя граница лог-оси, Гц: ниже — не логарифмируется. */
export const LOG_FMIN_HZ = 1.0

/**
 * Деления лог-шкалы: «круглые» частоты 1, 2, 5 × 10^k внутри окна. Логарифмическая
 * линейка не берёт равный шаг чисел — на ней равные расстояния дают десятичные
 * ряды, иначе деления «съезжают» к верху.
 */
function logFreqTicks(fmin: number, fmax: number): number[] {
  const low = Math.max(fmin, LOG_FMIN_HZ)
  if (!(fmax > low)) return []
  const ticks: number[] = []
  for (let decade = LOG_FMIN_HZ; decade <= fmax * 1.001; decade *= 10) {
    for (const factor of [1, 2, 5]) {
      const value = decade * factor
      if (value >= low - 1e-9 && value <= fmax + 1e-9) ticks.push(value)
    }
  }
  return ticks
}

/** Пиксель по вертикали для частоты: 0 Гц — внизу, `fmax` — наверху. */
export function fmaxToY(
  value: number,
  fmin: number,
  fmax: number,
  heightPx: number,
  scale: FreqScale = 'lin',
): number {
  if (!(fmax > fmin)) return heightPx
  if (scale === 'log') {
    const low = Math.max(fmin, LOG_FMIN_HZ)
    if (value <= low) return heightPx
    const span = Math.log(fmax) - Math.log(low) || 1
    return heightPx * (1 - (Math.log(value) - Math.log(low)) / span)
  }
  return heightPx - ((value - fmin) / (fmax - fmin)) * heightPx
}

/**
 * Частота под пикселем по вертикали (обратная к `fmaxToY`): клик по
 * спектрограмме. Обратная функция обязана жить рядом с прямой — иначе маркер
 * частоты рисовался бы по одной шкале, а считался по другой.
 */
export function yToFreq(
  yPx: number,
  fmin: number,
  fmax: number,
  heightPx: number,
  scale: FreqScale = 'lin',
): number {
  if (!(fmax > fmin) || heightPx <= 0) return fmin
  if (scale === 'log') {
    const low = Math.max(fmin, LOG_FMIN_HZ)
    const span = Math.log(fmax) - Math.log(low) || 1
    return Math.exp(Math.log(low) + ((heightPx - yPx) / heightPx) * span)
  }
  return fmin + ((heightPx - yPx) / heightPx) * (fmax - fmin)
}

/** Подпись деления частоты, Гц: целые — без дробной части. */
export function formatHzTick(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

/** Деления таймлайна: круглые секунды внутри окна. */
export function timeTicks(t0: number, t1: number, widthPx: number, targetCount = 6): TimeTick[] {
  if (!(t1 > t0) || widthPx <= 0) return []
  const span = t1 - t0
  const step = niceStep(span, targetCount)
  const ticks: TimeTick[] = []
  for (let time = Math.ceil(t0 / step) * step; time <= t1 + 1e-9; time += step) {
    ticks.push({
      timeSec: time,
      x: ((time - t0) / span) * widthPx,
      label: formatAxisTime(time, span),
    })
  }
  return ticks
}

/** Подпись времени на таймлайне: точность зависит от ширины окна. */
export function formatAxisTime(sec: number, span: number): string {
  const digits = span >= 60 ? 0 : span >= 5 ? 1 : 2
  return `${sec.toFixed(digits)} с`
}

/**
 * Окно времени раздела: то же, что у вьюера EDF (`zoomWindow` + `clampCenter`),
 * поэтому зум ×1…×16 и листание окна `<<`/`<`/`>`/`>>` работают одинаково.
 */
export function eegWindow(durationSec: number, factor: number, centerSec: number): TimeWindow {
  return zoomWindow(durationSec, factor, centerSec)
}

/** Зажимает центр окна: используется командой листания из тулс-хедера. */
export function clampEegCenter(centerSec: number, widthSec: number, totalSec: number): number {
  return clampCenter(centerSec, widthSec, totalSec)
}

/**
 * Перетаскивание линейки частот: вниз — окно шире (масштаб мельче), вверх — уже.
 * Зажим идёт в [0, fmax] и в минимальную ширину 2 Гц: линейка не «выворачивается».
 */
export function dragFreqWindow(
  start: [number, number],
  dyPx: number,
  fmax: number,
): [number, number] {
  const [low, high] = start
  const center = (low + high) / 2
  const half = Math.max(1, (high - low) / 2)
  const factor = 2 ** (dyPx / 120)
  const nextHalf = Math.min(Math.max(half * factor, 1), Math.max(1, fmax / 2))
  const nextLow = Math.max(0, center - nextHalf)
  const nextHigh = Math.min(fmax, center + nextHalf)
  return [Math.round(nextLow * 10) / 10, Math.round(nextHigh * 10) / 10]
}

/** Центр окна частот — для подписи линейки. */
export function freqWindowCenter(window: [number, number]): number {
  return (window[0] + window[1]) / 2
}
