/**
 * Спектр по диапазонам и топокарты (срез 3.4): арифметика вокруг ответа сервера.
 *
 * Сервер считает PSD и отдаёт **числа** (`SpectrumResult`) плюс ссылки на
 * готовые PNG топокарт. Поэтому модуль занимается тем, что нужно отрисовке:
 *
 * * собирает URL топокарты — с параметрами **того же** расчёта (полоса фильтра,
 *   notch, длина эпохи, порог reject) и версией ассета: ETag картинки считается
 *   по этим параметрам, поэтому смена фильтра обязана менять URL, иначе браузер
 *   покажет картинку прошлого расчёта;
 * * готовит полосы гистограммы (нормировка по максимуму) и ломаную PSD;
 * * честно показывает «—» там, где мощность не измерена (`null`, а не 0):
 *   диапазон вне полосы фильтра — это не «нулевая мощность».
 *
 * Шкала PSD — логарифмическая (`log10(1+x)`): на линейной шкале альфа-пик
 * «съедает» весь график, и остальные ритмы выглядят прямой линией.
 *
 * Окно частот (срез 3.5) — **параметр просмотра**, а не расчёта: выбранный
 * диапазон лишь срезает уже полученные числа PSD (`spectrumWithinWindow`), а
 * масштаб логарифмической шкалы берётся по всему спектру (`psdScale`): иначе при
 * сужении окна график «подтягивался» бы к максимуму внутри окна, и пики меняли
 * бы высоту на глазах — сравнение с полным спектром стало бы ложным.
 */
import type { SpectrumBandOut, SpectrumResult } from '@/shared/api/types'

/** Окно частот графика, Гц: [нижняя, верхняя] — обе внутри измеренного диапазона. */
export type FreqWindow = [number, number]

export type SpectrumQuery = {
  filterBandHz: [number, number] | null
  notchHz: number | null
  epochLengthMs: number
  /** Метод PSD (N17): `welch` | `multitaper` — входит в URL/ETag топокарт */
  psdMethod: string
}

/** Русские подписи ритмов; неизвестный ключ показывается как есть (не «теряется»). */
export const BAND_LABELS: Record<string, string> = {
  delta: 'δ — дельта',
  theta: 'θ — тета',
  alpha: 'α — альфа',
  beta: 'β — бета',
  gamma: 'γ — гамма',
}

export function bandLabel(name: string): string {
  return BAND_LABELS[name] ?? name
}

/** Подпись частотного диапазона: «8–13 Гц» (одна сторона — целое, если так задано). */
export function bandRangeLabel(band: SpectrumBandOut): string {
  return `${band.fmin}–${band.fmax} Гц`
}

/** Строка запроса топокарты, повторяющая параметры расчёта (и её ETag). */
export function spectrumQueryString(query: SpectrumQuery): string {
  const parts: string[] = []
  if (query.filterBandHz) {
    parts.push(`band_min=${query.filterBandHz[0]}`, `band_max=${query.filterBandHz[1]}`)
  }
  if (query.notchHz) parts.push(`notch_hz=${query.notchHz}`)
  parts.push(`epoch_length_ms=${query.epochLengthMs}`)
  parts.push(`psd_method=${query.psdMethod}`)
  return parts.join('&')
}

/**
 * URL картинки топокарты: база от сервера + параметры расчёта + версия ассета.
 * `null` — сервер картинку не построил (например нет позиций каналов в монтаже).
 */
export function topomapUrl(
  spectrum: SpectrumResult,
  band: SpectrumBandOut,
  query: SpectrumQuery,
): string | null {
  if (!band.topomap_url) return null
  return `${band.topomap_url}?${spectrumQueryString(query)}&v=${spectrum.topomap_version}`
}

/**
 * Параметры расчёта для URL топокарт — **из самого результата**.
 *
 * Не из текущих настроек панели: картинка должна соответствовать тому расчёту,
 * чьи числа показаны рядом. Правка длины эпохи после расчёта не «перекрашивает»
 * старую картинку, а делает пару «числа + картинка» рассинхронизированной — это
 * исправляется кнопкой «Пересчитать спектр», а не подменой параметров URL.
 */
export function spectrumQueryOf(result: SpectrumResult): SpectrumQuery {
  const band = result.filter_band_hz
  return {
    filterBandHz: band && band.length === 2 ? [band[0], band[1]] : null,
    notchHz: result.notch_hz,
    epochLengthMs: result.epoch_length_ms,
    // `?? 'welch'` — для результатов задач, записанных до появления поля
    // (файлы `results_dir/jobs/*.json`): тогда методом был Welch.
    psdMethod: result.psd_method || 'welch',
  }
}

/** Мощность для подписи: «—» вместо нуля там, где значение не измерено. */
export function formatPower(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(2)
}

export type BandBar = {
  name: string
  label: string
  /** Границы диапазона из конфига сервера, Гц */
  fmin: number
  fmax: number
  /** Мощность диапазона — интеграл PSD, мкВ² (0 для «не измерено») */
  power: number
  /** Доля от максимальной мощности диапазона, 0..1 (высота полосы) */
  ratio: number
  /** Мощность не измерена: подпись «—», полоса не рисуется */
  missing: boolean
  /** Диапазон пересекает выбранное окно частот (вне окна полоса приглушается) */
  inRange: boolean
}

/**
 * Полосы гистограммы по диапазонам: нормировка по максимальной мощности.
 *
 * Нормировка считается по **всем** диапазонам, даже когда показано окно частот:
 * иначе при выборе узкого окна полосы «подтягивались» бы к своему максимуму и
 * сравнение ритмов между собой стало бы ложным.
 */
export function histogramBars(
  bands: SpectrumBandOut[],
  window: FreqWindow | null = null,
): BandBar[] {
  const powers = bands.map((band) =>
    band.power_uv2 !== null && Number.isFinite(band.power_uv2) ? band.power_uv2 : null,
  )
  const max = Math.max(0, ...powers.map((value) => value ?? 0))

  return bands.map((band, index) => {
    const power = powers[index]
    return {
      name: band.name,
      label: bandLabel(band.name),
      fmin: band.fmin,
      fmax: band.fmax,
      power: power ?? 0,
      ratio: power !== null && max > 0 ? power / max : 0,
      missing: power === null,
      inRange: bandInFreqWindow(band, window),
    }
  })
}

/**
 * Общий максимум логарифмической шкалы: считается по **всему** спектру, поэтому
 * сужение окна частот не меняет высоту пиков (иначе график «прыгал» бы при
 * выборе ритма, и сравнить окно с полным спектром было бы нельзя).
 */
export function psdScale(power: number[]): number {
  return Math.max(...power.map((value) => Math.log10(1 + Math.max(0, value))), 1e-9)
}

/**
 * Ломаная PSD в координатах SVG: логарифмическая шкала мощности.
 * Частоты раскладываются линейно по ширине — так шкала читается как «Гц».
 *
 * `scale` по умолчанию считается по переданным значениям; при показе окна частот
 * его передают посчитанным по полному спектру (`psdScale`).
 */
export function psdPolyline(
  freqs: number[],
  power: number[],
  width: number,
  height: number,
  padding = 2,
  scale?: number,
): string {
  if (freqs.length < 2 || freqs.length !== power.length) return ''
  const fMin = freqs[0]
  const fMax = freqs[freqs.length - 1]
  const innerHeight = Math.max(1, height - padding * 2)
  // Логарифм: 0 и отрицательные значения после центрирования сигнала возможны
  const scaled = power.map((value) => Math.log10(1 + Math.max(0, value)))
  const maxLog = scale && scale > 0 ? scale : Math.max(...scaled, 1e-9)

  return freqs
    .map((freq, index) => {
      const x = psdX(freq, fMin, fMax, width, padding)
      const y = padding + innerHeight * (1 - scaled[index] / maxLog)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

/**
 * X-координата частоты на графике PSD: та же шкала, что и у ломаной (`psdPolyline`),
 * поэтому маркер пика (specparam) встаёт ровно над своим бином, а не «примерно».
 */
export function psdX(
  freq: number,
  fMin: number,
  fMax: number,
  width: number,
  padding = 2,
): number {
  const span = fMax - fMin || 1
  return padding + ((freq - fMin) / span) * Math.max(1, width - padding * 2)
}

/** Подпись параметров расчёта для панели: полоса, длина эпохи, шаг сетки. */
export function rangeSummary(query: Pick<SpectrumQuery, 'filterBandHz' | 'epochLengthMs'>): string {
  const band = query.filterBandHz
    ? `${query.filterBandHz[0]}–${query.filterBandHz[1]} Гц`
    : 'без фильтра'
  return `${band} · эпоха ${query.epochLengthMs} мс`
}

/**
 * Пределы частотной оси графика FFT — по фактическим частотам расчёта, а не по
 * диапазонам конфига: ось обязана совпадать с тем, что реально посчитал сервер.
 */
export function freqRange(freqs: number[]): [number, number] {
  if (freqs.length === 0) return [0, 1]
  return [freqs[0], freqs[freqs.length - 1]]
}

/**
 * Окно из ввода пользователя: границы по возрастанию; мусор (не-числа) — «весь
 * диапазон». Округление до десятых — окно показывается в подписи как «Гц».
 */
export function normalizeFreqWindow(range: FreqWindow | null): FreqWindow | null {
  if (range === null) return null
  const [a, b] = range
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const round = (value: number) => Math.round(value * 10) / 10
  return [round(Math.min(a, b)), round(Math.max(a, b))]
}

/**
 * Окно частот, зажатое в измеренный диапазон. `null` — весь диапазон: график
 * показывает всё, что посчитал сервер.
 *
 * Окно хранится в предпочтениях просмотра и переживает расчёт другой записи,
 * поэтому оно всегда приводится к частотам **текущего** спектра: чужое окно не
 * должно показывать пустой график.
 */
export function clampFreqWindow(freqs: number[], window: FreqWindow | null): FreqWindow {
  const full = freqRange(freqs)
  const normalized = normalizeFreqWindow(window)
  // Частот нет (пустой ответ) — зажимать не к чему: отдаём диапазон как есть
  if (normalized === null || freqs.length < 2) return full
  const clamp = (value: number) => Math.min(full[1], Math.max(full[0], value))
  return [clamp(normalized[0]), clamp(normalized[1])]
}

/** Подпись окна: «показано 8–13 Гц из 1–40 Гц» (без окна — просто весь диапазон). */
export function freqWindowLabel(window: FreqWindow | null, full: FreqWindow): string {
  if (window === null) return `Весь диапазон: ${full[0]}–${full[1]} Гц`
  return `Показано ${window[0]}–${window[1]} Гц из ${full[0]}–${full[1]} Гц`
}

/**
 * Числа PSD внутри окна: частоты и мощности фильтруются вместе (индексы не
 * разъезжаются). Пустой результат — честный ответ «в окне нет измеренных частот»,
 * а не подмена на весь спектр.
 */
export function spectrumWithinWindow(
  freqs: number[],
  power: number[],
  window: FreqWindow | null,
): { freqs: number[]; power: number[] } {
  if (window === null || freqs.length !== power.length) return { freqs, power }
  const [minHz, maxHz] = window
  const insideFreqs: number[] = []
  const insidePower: number[] = []
  for (let index = 0; index < freqs.length; index++) {
    const freq = freqs[index]
    if (freq < minHz - 1e-9 || freq > maxHz + 1e-9) continue
    insideFreqs.push(freq)
    insidePower.push(power[index])
  }
  return { freqs: insideFreqs, power: insidePower }
}

/** Полоса ритма, пересекающая окно частот (для подсветки гистограммы). */
export function bandInFreqWindow(
  band: Pick<SpectrumBandOut, 'fmin' | 'fmax'>,
  window: FreqWindow | null,
): boolean {
  if (window === null) return true
  return band.fmax > window[0] && band.fmin < window[1]
}

/**
 * Подпись результата спектра для выдвижной панели: параметры **своего** расчёта
 * (полоса, длина эпохи), окно Welch и число эпох. Именно этими параметрами
 * считался и PSD, и топокарты, поэтому подпись собирается из результата, а не из
 * текущих настроек панели (после их правки расчёт остаётся прежним).
 */
export function spectrumSummary(result: SpectrumResult): string {
  const { filterBandHz, epochLengthMs, psdMethod } = spectrumQueryOf(result)
  const method = psdMethod === 'multitaper' ? 'multitaper' : 'Welch'
  return `Спектр: ${rangeSummary({ filterBandHz, epochLengthMs })} · ${method} · окно ${result.n_fft} · эпох ${result.n_epochs}`
}

/**
 * Интерпретируемые метрики спектра (N16 + 1/f): IAF, θ/β-индексы, наклон
 * апериодического фона и ведущий пик над ним. Неизмеренные значения (`null`)
 * пропускаются — строка никогда не покажет «null».
 */
export function spectrumMetrics(result: SpectrumResult): string[] {
  const metrics: string[] = []
  if (result.iaf_hz !== null && Number.isFinite(result.iaf_hz)) {
    metrics.push(`IAF ${result.iaf_hz.toFixed(1)} Гц`)
  }
  if (result.theta_beta_ratio !== null && Number.isFinite(result.theta_beta_ratio)) {
    metrics.push(`θ/β ${result.theta_beta_ratio.toFixed(2)}`)
  }
  if (result.theta_alpha_beta_ratio !== null && Number.isFinite(result.theta_alpha_beta_ratio)) {
    metrics.push(`(θ+α)/β ${result.theta_alpha_beta_ratio.toFixed(2)}`)
  }
  if (result.aperiodic_exponent !== null && Number.isFinite(result.aperiodic_exponent)) {
    metrics.push(`1/f ${result.aperiodic_exponent.toFixed(2)}`)
  }
  const top = result.peaks[0]
  if (top && Number.isFinite(top.center_hz)) {
    metrics.push(`пик ${top.center_hz.toFixed(1)} Гц`)
  }
  return metrics
}
