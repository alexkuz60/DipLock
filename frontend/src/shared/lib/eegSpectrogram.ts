/**
 * Спектрограмма канала: разбор сетки с сервера и её подготовка к отрисовке.
 *
 * Сервер отдаёт **числа**, а не картинку (`services/spectrogram.py`, контейнер
 * ``DPS2`` = magic + uint32 LE длина заголовка + JSON-заголовок + float32 LE,
 * частото-мажорно). Так сделано осознанно: палитра, окно дБ и сглаживание —
 * параметры **просмотра**, их правят без пересчёта. Если бы сервер отдавал PNG,
 * каждая правка окна дБ запускала бы задачу — ровно то, что правилами проекта
 * запрещено.
 *
 * Здесь живёт вся арифметика картинки: перевод дБ в 0..1 по окну отображения,
 * палитры (без внешних зависимостей), сглаживание скользящим средним
 * (параметр просмотра, не расчёта) и выбор колонок под ширину области.
 * Модуль чистый: canvas читает готовые числа, а не считает их сам.
 */

export const SPECTROGRAM_MAGIC = 'DPS2'

/** Заголовок контейнера сетки (совпадает со схемой бэкенда). */
export type SpectrogramGridHeader = {
  recording_id: string
  channel: string
  window_ms: number
  overlap_pct: number
  fmax_hz: number
  sfreq: number
  n_fft: number
  n_freqs: number
  n_times: number
  db_min: number
  db_max: number
  dtype: string
  byte_order: string
  layout: string
}

/**
 * Разобранная сетка спектрограммы.
 *
 * ``values`` лежат частото-мажорно (строка = частота), как их пишет сервер:
 * при отрисовке строка картинки берётся одним срезом, без перестановок.
 */
export type SpectrogramGrid = {
  channel: string
  windowMs: number
  overlapPct: number
  fmaxHz: number
  sfreq: number
  freqs: Float32Array
  times: Float32Array
  values: Float32Array
  nFreqs: number
  nTimes: number
  /** Потолок и пол шкалы расчёта, дБ: окно отображения отсчитывается от потолка */
  dbMin: number
  dbMax: number
}

export class SpectrogramDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpectrogramDecodeError'
  }
}

/** Разбирает контейнер ``DPS2`` в сетку (частоты × времена). */
export function decodeSpectrogramGrid(buffer: ArrayBuffer): SpectrogramGrid {
  if (buffer.byteLength < 8) {
    throw new SpectrogramDecodeError('Ответ спектрограммы пуст или обрезан')
  }
  const bytes = new Uint8Array(buffer)
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  if (magic !== SPECTROGRAM_MAGIC) {
    throw new SpectrogramDecodeError(`Неожиданный формат спектрограммы (${magic})`)
  }
  const headerLength = new DataView(buffer).getUint32(4, true)
  const headerEnd = 8 + headerLength
  if (headerEnd > buffer.byteLength) {
    throw new SpectrogramDecodeError('Заголовок спектрограммы выходит за границы ответа')
  }
  let header: SpectrogramGridHeader
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, headerEnd)))
  } catch {
    throw new SpectrogramDecodeError('Заголовок спектрограммы не разобран как JSON')
  }

  const expected = header.n_freqs * header.n_times * 4
  if (buffer.byteLength - headerEnd !== expected) {
    throw new SpectrogramDecodeError(
      `Размер сетки не совпал: ${buffer.byteLength - headerEnd} байт вместо ${expected}`,
    )
  }

  // Копия payload: JSON-заголовок не выровнен по 4 байта, а Float32Array
  // требует выровненного смещения (slice даёт буфер с нулевым offset).
  const values = new Float32Array(buffer.slice(headerEnd))
  const freqs = new Float32Array(header.n_freqs)
  const times = new Float32Array(header.n_times)
  // Частотная ось равномерна (df = sfreq / n_fft), времена сервер отдаёт отдельно:
  // в результате они есть, а в контейнере — нет (экономия и меньше поводов разойтись).
  const df = header.n_fft > 0 ? header.sfreq / header.n_fft : 0
  for (let i = 0; i < header.n_freqs; i++) freqs[i] = i * df
  const dt = header.n_times > 0 ? (header.window_ms * (1 - header.overlap_pct / 100)) / 1000 : 0
  for (let i = 0; i < header.n_times; i++) {
    times[i] = header.window_ms / 2000 + i * dt
  }

  return {
    channel: header.channel,
    windowMs: header.window_ms,
    overlapPct: header.overlap_pct,
    fmaxHz: header.fmax_hz,
    sfreq: header.sfreq,
    freqs,
    times,
    values,
    nFreqs: header.n_freqs,
    nTimes: header.n_times,
    dbMin: header.db_min,
    dbMax: header.db_max,
  }
}

/** Значение сетки по индексам строки (частота) и столбца (время). */
export function gridValueAt(grid: SpectrogramGrid, freqIndex: number, timeIndex: number): number {
  const row = Math.min(grid.nFreqs - 1, Math.max(0, freqIndex))
  const column = Math.min(grid.nTimes - 1, Math.max(0, timeIndex))
  return grid.values[row * grid.nTimes + column] ?? grid.dbMin
}

/** Индекс первого значения массива, которое не меньше ``value`` (массивы возрастают). */
export function lowerBound(values: Float32Array, value: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((values[mid] as number) < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Столбцы сетки, попавшие в окно времени. Окно `null` — вся запись
 * (режим «обзор»: спектрограмма не следует за зумом трека).
 */
export function timeIndexRange(
  times: Float32Array,
  window: { t0: number; t1: number } | null,
): { from: number; to: number } {
  if (times.length === 0) return { from: 0, to: 0 }
  if (!window) return { from: 0, to: times.length - 1 }
  const from = lowerBound(times, window.t0)
  let to = lowerBound(times, window.t1)
  if (to <= from) to = Math.min(times.length - 1, from)
  return { from: Math.min(from, times.length - 1), to: Math.max(to, from) }
}

/** Строки сетки, попавшие в окно частот (`null` — вся сетка). */
export function freqIndexRange(
  grid: SpectrogramGrid,
  window: [number, number] | null,
): { from: number; to: number } {
  if (!window) return { from: 0, to: grid.nFreqs - 1 }
  const from = lowerBound(grid.freqs, window[0])
  let to = lowerBound(grid.freqs, window[1])
  if (to <= from) to = Math.min(grid.nFreqs - 1, from)
  return { from: Math.min(from, grid.nFreqs - 1), to: Math.max(to, from) }
}

/** Шаг сетки по времени, мс: из него считается сглаживание в корзинах. */
export function hopMs(grid: SpectrogramGrid): number {
  return Math.max(1, grid.windowMs * (1 - grid.overlapPct / 100))
}

/**
 * Скользящее среднее по одной оси сетки (границы — «edge»: значения не уезжают).
 * Ширина окна нечётная и не меньше 1: сглаживание не сдвигает картинку.
 */
export function boxSmooth(
  values: Float32Array,
  rows: number,
  columns: number,
  bins: number,
  axis: 'time' | 'freq',
): Float32Array {
  const width = Math.max(1, Math.trunc(bins) | 1)
  const out = new Float32Array(values.length)
  if (width === 1) {
    out.set(values)
    return out
  }
  const half = (width - 1) / 2
  const length = axis === 'time' ? columns : rows
  const other = axis === 'time' ? rows : columns
  for (let otherIndex = 0; otherIndex < other; otherIndex++) {
    for (let index = 0; index < length; index++) {
      let sum = 0
      let count = 0
      for (let offset = -half; offset <= half; offset++) {
        const shifted = index + offset
        if (shifted < 0 || shifted >= length) continue
        const source =
          axis === 'time' ? otherIndex * columns + shifted : shifted * columns + otherIndex
        sum += values[source] as number
        count += 1
      }
      const target =
        axis === 'time' ? otherIndex * columns + index : index * columns + otherIndex
      out[target] = count > 0 ? sum / count : (values[target] as number)
    }
  }
  return out
}

/**
 * Сглаживание спектрограммы — **параметр просмотра** (в задачу не уходит):
 * по времени в миллисекундах (переводится в корзины через шаг сетки) и по
 * частоте в корзинах. Считается по уже полученным числам: ни одного запроса.
 */
export function smoothSpectrogram(
  grid: SpectrogramGrid,
  smoothMs: number,
  smoothBins: number,
): SpectrogramGrid {
  const timeBins = smoothMs > 0 ? Math.round(smoothMs / hopMs(grid)) : 1
  const freqBins = Math.max(0, Math.trunc(smoothBins))
  if (timeBins <= 1 && freqBins < 2) return grid

  let values = grid.values
  if (freqBins >= 2) values = boxSmooth(values, grid.nFreqs, grid.nTimes, freqBins, 'freq')
  if (timeBins >= 2) values = boxSmooth(values, grid.nFreqs, grid.nTimes, timeBins, 'time')
  return { ...grid, values }
}

/**
 * Перевод дБ в 0..1 по окну отображения: 0 — пол, 1 — потолок.
 *
 * Окно задаётся **относительно потолка расчёта** (`range` = [низ, верх] в дБ),
 * поэтому правка окна не требует пересчёта и не «плывёт» при смене канала.
 */
export function dbToUnit(db: number, range: [number, number], dbMax: number): number {
  const low = dbMax + Math.min(range[0], range[1])
  const high = dbMax + Math.max(range[0], range[1])
  if (!(high > low)) return db >= high ? 1 : 0
  return Math.min(1, Math.max(0, (db - low) / (high - low)))
}

/** Палитры спектрограммы: имя → подпись в панели. */
export type EegPaletteId = 'gray' | 'viridis' | 'magma'

export const EEG_PALETTES: { id: EegPaletteId; label: string }[] = [
  { id: 'gray', label: 'Серая' },
  { id: 'viridis', label: 'Viridis' },
  { id: 'magma', label: 'Magma' },
]

/** Подпись палитры по идентификатору (значение из localStorage бывает из будущего). */
export function paletteLabel(id: string): string {
  return EEG_PALETTES.find((item) => item.id === id)?.label ?? String(id)
}

/**
 * Цвет палитры: значение 0..1 → RGB. Палитры заданы таблицей опорных точек и
 * линейно интерполируются — внешние зависимости ради картинки не тянем (то же
 * правило, что у топокарт: цвет не должен приезжать из библиотеки графиков).
 */
export function paletteRgb(palette: EegPaletteId, unit: number): [number, number, number] {
  const stops = PALETTE_STOPS[palette] ?? PALETTE_STOPS.gray
  const value = Math.min(1, Math.max(0, Number.isFinite(unit) ? unit : 0))
  const position = value * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(position))
  const t = position - index
  const from = stops[index] as [number, number, number]
  const to = stops[index + 1] as [number, number, number]
  return [
    Math.round(from[0] + (to[0] - from[0]) * t),
    Math.round(from[1] + (to[1] - from[1]) * t),
    Math.round(from[2] + (to[2] - from[2]) * t),
  ]
}

/**
 * Таблица цветов на 256 шагов: canvas красит пиксели через `ImageData`, и
 * строить строку `rgb(...)` на каждый пиксель дорого. Таблица считается один раз
 * на палитру (`useMemo` в компоненте).
 */
export function paletteLut(palette: EegPaletteId): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = paletteRgb(palette, i / 255)
    lut[i * 3] = r
    lut[i * 3 + 1] = g
    lut[i * 3 + 2] = b
  }
  return lut
}

/** Опорные точки палитр (0 — пол шкалы, 1 — потолок) */
const PALETTE_STOPS: Record<EegPaletteId, [number, number, number][]> = {
  gray: [
    [8, 12, 18],
    [90, 110, 130],
    [200, 215, 230],
    [255, 255, 255],
  ],
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [81, 18, 124],
    [183, 55, 121],
    [252, 137, 97],
    [252, 253, 191],
  ],
}

/**
 * URL сетки с версией расчёта: браузер кэширует по URL, и после пересчёта
 * (другое окно, канал или фильтр) старая сетка не должна «залипнуть».
 */
export function gridUrlOf(result: { grid_url: string; grid_version: string; channel: string }): string {
  const separator = result.grid_url.includes('?') ? '&' : '?'
  return `${result.grid_url}${separator}v=${encodeURIComponent(result.grid_version)}`
}

/** Подпись сетки словами: что именно посчитано (без «примерно такое»). */
export function spectrogramSummary(grid: SpectrogramGrid): string {
  return (
    `${grid.channel}: окно ${Math.round(grid.windowMs)} мс · перекрытие ` +
    `${Math.round(grid.overlapPct)} % · ${grid.nFreqs} частот × ${grid.nTimes} окон · ` +
    `шкала ${grid.dbMin.toFixed(1)}…${grid.dbMax.toFixed(1)} дБ`
  )
}

/**
 * Детерминированная сетка для тестов и отладки отрисовки.
 *
 * Это **фикстура, а не имитация расчёта**: раздел не показывает её как результат
 * (правило «UI не имитирует обработку»), она нужна тестам canvas-слоя и ручной
 * проверке палитры. Рисунок — «дыхание» α-ритма 10 Гц по времени.
 */
export function demoSpectrogramGrid(channel = 'Fp1'): SpectrogramGrid {
  const nFreqs = 41
  const nTimes = 240
  const windowMs = 500
  const overlapPct = 75
  const freqs = new Float32Array(nFreqs)
  const times = new Float32Array(nTimes)
  const values = new Float32Array(nFreqs * nTimes)
  const hop = (windowMs * (1 - overlapPct / 100)) / 1000
  for (let f = 0; f < nFreqs; f++) freqs[f] = f
  for (let t = 0; t < nTimes; t++) times[t] = windowMs / 2000 + t * hop
  for (let t = 0; t < nTimes; t++) {
    const envelope = 0.5 + 0.45 * Math.sin((2 * Math.PI * t) / 90)
    for (let f = 0; f < nFreqs; f++) {
      const peak = Math.exp(-((f - 10) ** 2) / 6) * 40 * envelope
      const noise = Math.exp(-((f - 20) ** 2) / 200) * 8
      values[f * nTimes + t] = -60 + peak + noise
    }
  }
  return {
    channel,
    windowMs,
    overlapPct,
    fmaxHz: 40,
    sfreq: 250,
    freqs,
    times,
    values,
    nFreqs,
    nTimes,
    dbMin: -60,
    dbMax: 0,
  }
}




