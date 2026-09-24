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
 * (параметр просмотра, не расчёта), выбор колонок под ширину области, шкала
 * частот (линейная/логарифмическая, N18) и режим ERD/ERS (нормировка по
 * baseline-интервалу, параметр просмотра).
 * Модуль чистый: canvas читает готовые числа, а не считает их сам. Импорт здесь
 * только типов и константы чистого соседа (`eegView`) — ни DOM, ни вычислений.
 */

import { LOG_FMIN_HZ, type FreqScale } from './eegView'

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
 *
 * Считается **бегущей суммой**: окно скользит на один отсчёт, поэтому из суммы
 * уходит только крайний отсчёт, а приходит один новый — O(length) на строку
 * вместо O(length · width). На сетке «часовой» записи (2000 × 28 800 при окне
 * сглаживания 25 корзин) это разница между миллионами операций на каждую правку
 * контрола и сотнями тысяч.
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
  const stride = axis === 'time' ? 1 : columns
  for (let otherIndex = 0; otherIndex < other; otherIndex++) {
    // Начало строки (ось времени) или столбца (ось частот) — общая для обеих осей формула
    const base = axis === 'time' ? otherIndex * columns : otherIndex
    // Сумма первого окна [0, half] — дальше она только сдвигается
    let sum = 0
    const edge = Math.min(length - 1, half)
    for (let index = 0; index <= edge; index++) sum += values[base + index * stride] as number
    for (let index = 0; index < length; index++) {
      const last = Math.min(length - 1, index + half)
      const first = Math.max(0, index - half)
      out[base + index * stride] = sum / (last - first + 1)
      const add = index + half + 1
      if (add < length) sum += values[base + add * stride] as number
      const remove = index - half
      if (remove >= 0) sum -= values[base + remove * stride] as number
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

/** Перевод значения ERD/ERS, % в 0..1 по окну отображения: 0 — низ, 1 — верх. */
export function erdToUnit(percent: number, range: [number, number]): number {
  const low = Math.min(range[0], range[1])
  const high = Math.max(range[0], range[1])
  if (!(high > low)) return percent >= high ? 1 : 0
  return Math.min(1, Math.max(0, (percent - low) / (high - low)))
}

/** Опции режима ERD/ERS растра (параметры **просмотра**, в задачу не уходят). */
export type RasterErdOptions = {
  /** Baseline-интервал, с: отсчёт «100 % мощности» для каждой частоты */
  baselineSec: [number, number]
  /** Окно палитры в %, например [-100, 100] */
  rangePct: [number, number]
}

/**
 * ERD/ERS поверх сетки дБ (N18): `(P − P_ref)/P_ref × 100 %` для каждой ячейки.
 *
 * Мощность восстанавливается точно: сетка несёт уровень амплитуды в дБ, а
 * мощность пропорциональна `10^(дБ/10)`. `P_ref(f)` — средняя мощность частоты
 * по baseline-столбцам. Возврат `null` — интервал baseline не попал в сетку:
 * показывать «нормированные» числа по пустому отсчёту нельзя, UI честно это
 * пишет. Чистая функция — математика проверяется без canvas.
 */
export function erdErsPercent(
  values: Float32Array,
  nFreqs: number,
  nTimes: number,
  times: Float32Array,
  baselineSec: [number, number],
): Float32Array | null {
  // Столбцы baseline — строго те, чьи центры попали в интервал: «зажим» к
  // ближайшему столбцу (как у окна показа) здесь недопустим — отсчёт по
  // столбцу вне интервала исказил бы все проценты.
  const t0 = Math.min(baselineSec[0], baselineSec[1])
  const t1 = Math.max(baselineSec[0], baselineSec[1])
  let from = -1
  let to = -1
  for (let index = 0; index < nTimes; index++) {
    const time = times[index] ?? 0
    if (time < t0 - 1e-9 || time > t1 + 1e-9) continue
    if (from < 0) from = index
    to = index
  }
  const baselineColumns = from < 0 ? 0 : to - from + 1
  if (nFreqs === 0 || nTimes === 0 || baselineColumns <= 0) return null

  const out = new Float32Array(values.length)
  for (let row = 0; row < nFreqs; row++) {
    // P_ref: средняя мощность строки по baseline (дБ → мощность точно)
    let reference = 0
    for (let column = from; column <= to; column++) {
      reference += 10 ** ((values[row * nTimes + column] as number) / 10)
    }
    reference /= baselineColumns
    if (!(reference > 0)) {
      out.fill(0, row * nTimes, (row + 1) * nTimes)
      continue
    }
    for (let column = 0; column < nTimes; column++) {
      const power = 10 ** ((values[row * nTimes + column] as number) / 10)
      out[row * nTimes + column] = (power / reference - 1) * 100
    }
  }
  return out
}

/**
 * Конкретный baseline-интервал по умолчанию: `[0, 0]` в параметрах просмотра
 * значит «первые 10 % записи». Длительность известна только по сетке задачи,
 * поэтому дефолт решается здесь, а не в сторе.
 */
export function resolveBaselineSec(
  baselineSec: [number, number],
  times: Float32Array,
): [number, number] {
  const low = Math.min(baselineSec[0], baselineSec[1])
  const high = Math.max(baselineSec[0], baselineSec[1])
  if (low > 0 || high > 0) return [low, high]
  if (times.length === 0) return [0, 0]
  const start = times[0] as number
  const end = times[times.length - 1] as number
  return [start, start + (end - start) * 0.1]
}

/**
 * Готовый растр спектрограммы: RGBA-буфер **в разрешении данных**.
 *
 * Строка растра — частота (сверху потолок видимого окна), столбец — окно STFT.
 * Растр намеренно не совпадает с холстом: область графика бывает 1470 CSS-пикселей
 * при `devicePixelRatio = 2` (≈1.76 млн пикселей по 4 записи на каждый), а ячеек
 * в видимом окне — несколько сотен тысяч. Растягивает растр композитор
 * (`drawRaster` + `imageSmoothingEnabled = false`), поэтому работа пропорциональна
 * **данным**, а не площади экрана.
 *
 * Бюджет холста (`maxColumns × maxRows` — размер области в bitmap-пикселях) —
 * верхняя граница: если сетка плотнее пикселей (окно 1 ч, 28 800 окон STFT),
 * столбцы и строки прореживаются ровно так же, как раньше прореживались пиксели,
 * и растр никогда не становится больше полного холста.
 */
export type SpectrogramRaster = {
  /** Столбцы: окна сетки слева направо */
  columns: number
  /** Строки: частоты сверху вниз (к потолку окна) */
  rows: number
  /** RGBA: `columns * rows * 4` */
  rgba: Uint8ClampedArray
}

/**
 * Собирает растр спектрограммы из чисел сетки: палитра, окно дБ и выбор ячеек.
 *
 * Формулы выбора ячейки — те же, что были в цикле по пикселям холста (`yToFreq`
 * по вертикали, линейная доля окна по горизонтали): изменилось только **число**
 * вычислений, а не картинка. Частота строки считается по обратной к `fmaxToY`
 * шкале (линейной или логарифмической, N18) прямо здесь.
 *
 * `erd` включает режим ERD/ERS (N18): значения переводятся в % по baseline и
 * нормируются окном `%` (`rangePct`), а не окном дБ — это параметры просмотра.
 */
export function spectrogramRaster(
  grid: SpectrogramGrid,
  shownWindow: { t0: number; t1: number },
  freqWindow: [number, number],
  dbRangeDb: [number, number],
  lut: Uint8ClampedArray,
  maxColumns: number,
  maxRows: number,
  freqScale: FreqScale = 'lin',
  erd: RasterErdOptions | null = null,
): SpectrogramRaster {
  const { from, to } = timeIndexRange(grid.times, shownWindow)
  const visibleColumns = Math.max(1, to - from + 1)
  const columns = Math.max(1, Math.min(visibleColumns, Math.trunc(maxColumns) || 1))
  const rows = Math.max(1, Math.min(Math.max(1, grid.nFreqs), Math.trunc(maxRows) || 1))
  const rgba = new Uint8ClampedArray(columns * rows * 4)
  if (grid.nFreqs === 0 || grid.nTimes === 0) return { columns, rows, rgba }

  const low = Math.min(freqWindow[0], freqWindow[1])
  const high = Math.max(freqWindow[0], freqWindow[1])
  // Лог-ось определена от 1 Гц (как `fmaxToY` в eegView): 0 Гц не логарифмируется
  const logMode = freqScale === 'log' && high > Math.max(low, LOG_FMIN_HZ)
  const logLow = Math.max(low, LOG_FMIN_HZ)
  const span = Math.max(1e-6, shownWindow.t1 - shownWindow.t0)
  const firstTime = grid.times[from] ?? 0
  const topFreq = Math.max(1e-6, grid.freqs[grid.nFreqs - 1] as number)

  // Значения: дБ как есть или ERD/ERS % по baseline (тогда окно палитры — %)
  const values =
    erd !== null
      ? erdErsPercent(
          grid.values,
          grid.nFreqs,
          grid.nTimes,
          grid.times,
          erd.baselineSec,
        )
      : null
  const unitOf =
    erd !== null && values !== null
      ? (row: number, column: number) =>
          erdToUnit(values[row * grid.nTimes + column] as number, erd.rangePct)
      : (row: number, column: number) =>
          dbToUnit(
            grid.values[row * grid.nTimes + column] ?? grid.dbMin,
            dbRangeDb,
            grid.dbMax,
          )

  // Столбцы — один раз на растр, а не на каждый пиксель экрана
  const columnOf = new Int32Array(columns)
  for (let x = 0; x < columns; x++) {
    const time = shownWindow.t0 + (x / columns) * span
    const ratio = (time - firstTime) / span
    columnOf[x] = Math.min(
      grid.nTimes - 1,
      Math.max(0, Math.round(from + ratio * (to - from))),
    )
  }

  for (let y = 0; y < rows; y++) {
    // Частота пиксельной строки: `fmin` внизу, потолок окна сверху (обратная к
    // `fmaxToY` своей шкалы)
    const ratio = (rows - y - 0.5) / rows
    const frequency = logMode
      ? Math.exp(Math.log(logLow) + ratio * (Math.log(high) - Math.log(logLow)))
      : low + ratio * (high - low)
    const rowIndex = Math.min(
      grid.nFreqs - 1,
      Math.max(0, Math.round((frequency / topFreq) * (grid.nFreqs - 1))),
    )
    const target = y * columns * 4
    for (let x = 0; x < columns; x++) {
      const colour = Math.round(unitOf(rowIndex, columnOf[x] as number) * 255) * 3
      const at = target + x * 4
      rgba[at] = lut[colour] as number
      rgba[at + 1] = lut[colour + 1] as number
      rgba[at + 2] = lut[colour + 2] as number
      rgba[at + 3] = 255
    }
  }
  return { columns, rows, rgba }
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




