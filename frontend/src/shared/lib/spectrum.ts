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
 */
import type { SpectrumBandOut, SpectrumResult } from '@/shared/api/types'

export type SpectrumQuery = {
  filterBandHz: [number, number] | null
  notchHz: number | null
  epochLengthMs: number
  rejectThresholdUv: number
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
  parts.push(`reject_threshold_uv=${query.rejectThresholdUv}`)
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
    rejectThresholdUv: result.reject_threshold_uv,
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
  /** Мощность диапазона, мкВ²/Гц (0 для «не измерено» — полоса рисуется пустой) */
  power: number
  /** Доля от максимальной мощности диапазона, 0..1 (высота полосы) */
  ratio: number
  /** Мощность не измерена: подпись «—», полоса не рисуется */
  missing: boolean
}

/** Полосы гистограммы по диапазонам: нормировка по максимальной мощности. */
export function histogramBars(bands: SpectrumBandOut[]): BandBar[] {
  const powers = bands.map((band) =>
    band.power_uv2 !== null && Number.isFinite(band.power_uv2) ? band.power_uv2 : null,
  )
  const max = Math.max(0, ...powers.map((value) => value ?? 0))

  return bands.map((band, index) => {
    const power = powers[index]
    return {
      name: band.name,
      label: bandLabel(band.name),
      power: power ?? 0,
      ratio: power !== null && max > 0 ? power / max : 0,
      missing: power === null,
    }
  })
}

/**
 * Ломаная PSD в координатах SVG: логарифмическая шкала мощности.
 * Частоты раскладываются линейно по ширине — так шкала читается как «Гц».
 */
export function psdPolyline(
  freqs: number[],
  power: number[],
  width: number,
  height: number,
  padding = 2,
): string {
  if (freqs.length < 2 || freqs.length !== power.length) return ''
  const fMin = freqs[0]
  const fMax = freqs[freqs.length - 1]
  const span = fMax - fMin || 1
  const innerWidth = Math.max(1, width - padding * 2)
  const innerHeight = Math.max(1, height - padding * 2)
  // Логарифм: 0 и отрицательные значения после центрирования сигнала возможны
  const scaled = power.map((value) => Math.log10(1 + Math.max(0, value)))
  const maxLog = Math.max(...scaled, 1e-9)

  return freqs
    .map((freq, index) => {
      const x = padding + ((freq - fMin) / span) * innerWidth
      const y = padding + innerHeight * (1 - scaled[index] / maxLog)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
}

/** Подпись параметров расчёта для панели: полоса, длина эпохи, шаг сетки. */
export function rangeSummary(query: Pick<SpectrumQuery, 'filterBandHz' | 'epochLengthMs'>): string {
  const band = query.filterBandHz ? `${query.filterBandHz[0]}–${query.filterBandHz[1]} Гц` : 'без фильтра'
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
 * Подпись результата спектра для выдвижной панели: параметры **своего** расчёта
 * (полоса, длина эпохи), окно Welch и число эпох. Именно этими параметрами
 * считался и PSD, и топокарты, поэтому подпись собирается из результата, а не из
 * текущих настроек панели (после их правки расчёт остаётся прежним).
 */
export function spectrumSummary(result: SpectrumResult): string {
  const { filterBandHz, epochLengthMs } = spectrumQueryOf(result)
  return `Спектр: ${rangeSummary({ filterBandHz, epochLengthMs })} · окно ${result.n_fft} · эпох ${result.n_epochs}`
}
