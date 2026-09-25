/**
 * Геометрия графика АЧХ для SVG (шаг 2.5): чистая функция без DOM — тестируема.
 *
 * Холст — фиксированный `viewBox` (пересоздание/резайз чарту не нужны, Р4), ось
 * X адаптивна: узкая полоса (7.83 ± 0.25 Гц) разворачивается на экран, широкая
 * (1–40 Гц) показывается целиком с запасом на оба обреза. Все значения ниже
 * `CHART_MIN_DB` прижимаются к полу — глубина провалов notch видна как «ниже
 * пола», без логарифмов и без искажения полосы пропускания.
 */
import type { FilterResponse } from '@/shared/api/types'

/** Пол шкалы Y, дБ: глубже — контрактно «ниже пола графика» */
export const CHART_MIN_DB = -60
/** Потолок шкалы Y, дБ: малый запас над нулём, чтобы 0 дБ читался по сетке */
export const CHART_MAX_DB = 5

export type ChartTick = { pos: number; label: string }

export type ResponseChartGeometry = {
  width: number
  height: number
  /** Точки `<polyline>` в координатах viewBox: «x,y x,y …» */
  points: string
  /** Видимый диапазон частот, Гц */
  xDomain: [number, number]
  /** Шкала Y, дБ */
  yDomain: [number, number]
  xTicks: ChartTick[]
  yTicks: ChartTick[]
  /** Полоса пропускания: заливка прямоугольником (null — полосы нет) */
  passband: { x: number; width: number } | null
  /** Метки notch-частот, x viewBox (вне домена — не рисуются) */
  notchMarks: number[]
}

/** Подпись частоты на оси: два знака для узкого домена, целые — для широкого */
function freqLabel(value: number, span: number): string {
  return span < 10 ? value.toFixed(2) : value.toFixed(0)
}

export function responseChart(
  response: Pick<FilterResponse, 'freqs_hz' | 'gain_db' | 'band_hz' | 'notch_freqs'>,
  width = 320,
  height = 120,
): ResponseChartGeometry {
  const { freqs_hz: freqs, gain_db: gains, band_hz: bandRaw, notch_freqs: notchs } = response
  const fMax = freqs.length ? freqs[freqs.length - 1] : 1
  const band =
    bandRaw && bandRaw.length === 2 ? ([bandRaw[0], bandRaw[1]] as [number, number]) : null
  // Узкую полосу разворачиваем на экран: запас = max(2 ширины полосы, 2 Гц)
  const pad = Math.max((band ? band[1] - band[0] : 0) * 2, 2)
  const x0 = band ? Math.max(0, band[0] - pad) : 0
  const x1 = band ? Math.min(fMax, band[1] + pad) : fMax
  const xDomain: [number, number] = [x0, Math.max(x1, x0 + 1e-9)]
  const yDomain: [number, number] = [CHART_MIN_DB, CHART_MAX_DB]

  const xOf = (f: number) => ((f - xDomain[0]) / (xDomain[1] - xDomain[0])) * width
  const yOf = (g: number) => {
    const clamped = Math.min(Math.max(g, CHART_MIN_DB), CHART_MAX_DB)
    return height - ((clamped - CHART_MIN_DB) / (CHART_MAX_DB - CHART_MIN_DB)) * height
  }

  // Только точки внутри домена: полилиния через весь домен рисовала бы
  // пересекающие кадр хвосты (узкая полоса на общей сетке 0…Nyquist).
  const points = freqs
    .map((f, i) => ({ f, g: gains[i] ?? CHART_MIN_DB }))
    .filter(({ f }) => f >= xDomain[0] && f <= xDomain[1])
    .map(({ f, g }) => `${xOf(f).toFixed(1)},${yOf(g).toFixed(1)}`)
    .join(' ')

  const span = xDomain[1] - xDomain[0]
  const xTicks: ChartTick[] = [xDomain[0], (xDomain[0] + xDomain[1]) / 2, xDomain[1]].map(
    (value) => ({ pos: xOf(value), label: freqLabel(value, span) }),
  )
  const yTicks: ChartTick[] = [0, -20, -40, -60]
    .filter((value) => value >= CHART_MIN_DB)
    .map((value) => ({ pos: yOf(value), label: String(value) }))

  return {
    width,
    height,
    points,
    xDomain,
    yDomain,
    xTicks,
    yTicks,
    passband: band
      ? {
          x: Math.max(xOf(band[0]), 0),
          width: Math.max(xOf(band[1]) - xOf(band[0]), 2),
        }
      : null,
    notchMarks: notchs.filter((f) => f >= xDomain[0] && f <= xDomain[1]).map(xOf),
  }
}

/** Подпись метода и цены фильтра под графиком (паспорт N11/N12 для UI). */
export function filterPassportText(response: FilterResponse): string {
  const parts: string[] = []
  if (response.method === 'fir') {
    parts.push('метод: FIR')
    if (response.filter_length_sec !== null) {
      parts.push(`ядро ${response.filter_length_sec.toFixed(2)} с`)
    }
    if (response.edge_buffer_sec > 0) {
      parts.push(`краевой буфер ±${response.edge_buffer_sec.toFixed(2)} с (BAD_edge)`)
    }
    if (response.l_trans_bandwidth_hz !== null && response.h_trans_bandwidth_hz !== null) {
      parts.push(
        `переходные полосы ${response.l_trans_bandwidth_hz.toFixed(1)}/${response.h_trans_bandwidth_hz.toFixed(1)} Гц`,
      )
    }
  } else if (response.method === 'iir') {
    parts.push('метод: IIR (Butterworth, zero-phase) — ядро короткое, края не режутся')
  } else {
    parts.push('только notch — полосового фильтра нет')
  }
  if (response.notch_freqs.length) {
    parts.push(`notch: ${response.notch_freqs.map((f) => f.toFixed(0)).join('/')} Гц`)
  }
  return parts.join(' · ')
}