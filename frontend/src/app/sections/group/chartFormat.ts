/**
 * Форматирование и шкалы графиков «Сравнения двух записей» (B9).
 *
 * Вынесены из `GroupCharts.tsx`: модуль компонентов по правилу
 * `react-refresh/only-export-components` экспортирует только компоненты,
 * а хелперы делятся отдельным файлом (как `shared/lib/*` у `FftHistogram`).
 */
import type { CompareBand } from '@/shared/api/types'

/** Формат p-значения: три значащих числа, мелочь — «< 0.001». */
export function formatP(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 0.001) return '< 0.001'
  return value.toFixed(3)
}

/** Формат дБ: знак всегда виден (+2.3 / −1.5 / 0.0). */
export function formatDb(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const rounded = Math.abs(value) < 0.05 ? 0 : value
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`
}

/** Симметричная шкала дельт: максимум по |Δ| и |CI| всех полос (min 1 дБ). */
export function bandDeltaScale(bands: CompareBand[]): number {
  let maxAbs = 1
  for (const band of bands) {
    maxAbs = Math.max(maxAbs, Math.abs(band.delta_db ?? 0))
    if (band.ci95_delta_db) {
      maxAbs = Math.max(
        maxAbs,
        Math.abs(band.ci95_delta_db[0] ?? 0),
        Math.abs(band.ci95_delta_db[1] ?? 0),
      )
    }
  }
  return maxAbs
}
