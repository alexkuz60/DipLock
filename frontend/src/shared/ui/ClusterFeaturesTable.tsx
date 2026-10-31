/**
 * Сравнительная таблица профилей признаков кластеров (Т2, Шаг 3).
 *
 * Одна строка = один кластер; колонки — измеренные признаки `ClusterFeaturesOut`.
 * Неизмеренное — «—» (не 0). GOF/момент — **внутри своей полосы** (принцип 3),
 * таблица не нормирует между полосами — читатель сравнивает строки одного прогона.
 */
import type { ClusterFeatures } from '@/shared/api/types'
import { clusterFeatureCells } from '@/shared/lib/clusterFeatures'

export type ClusterFeaturesTableRow = {
  /** Стабильный key строки. */
  id: string
  /** Левая колонка: полоса, центроид и т.п. */
  label: string
  /** Дополнительная подпись в первой колонке (устойчивость, индекс…). */
  labelHint?: string
  features: ClusterFeatures | null | undefined
}

const HEADERS = [
  'Кластер',
  'Топ-структура',
  'H',
  'Л/П/С, %',
  'Момент нАм',
  'GOF med (min)',
  'КД',
  'R, мм',
] as const

/** Таблица профилей: горизонтальный скролл узких колонок не ломает. */
export function ClusterFeaturesTable({
  rows,
  testId = 'cluster-features-table',
}: {
  rows: ClusterFeaturesTableRow[]
  testId?: string
}) {
  if (rows.length === 0) return null
  return (
    <div className="mt-1 overflow-x-auto" data-testid={testId}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-fg-2">
            {HEADERS.map((header) => (
              <th
                key={header}
                className={`px-2 py-1 font-normal${header === 'Кластер' ? '' : ' text-right'}`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cells = clusterFeatureCells(row.features)
            return (
              <tr
                key={row.id}
                className="border-b border-line-soft"
                data-testid="cluster-features-row"
              >
                <td className="px-2 py-1">
                  <span className="font-medium">{row.label}</span>
                  {row.labelHint ? (
                    <span className="ml-1 text-xs text-fg-2">{row.labelHint}</span>
                  ) : null}
                </td>
                <td className="px-2 py-1 text-right" title={cells.topStructure}>
                  {cells.topStructure}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{cells.entropy}</td>
                <td className="px-2 py-1 text-right tabular-nums">{cells.hemisphere}</td>
                <td className="px-2 py-1 text-right tabular-nums">{cells.momentMean}</td>
                <td className="px-2 py-1 text-right tabular-nums">{cells.gof}</td>
                <td className="px-2 py-1 text-right tabular-nums">{cells.kd}</td>
                <td className="px-2 py-1 text-right tabular-nums">{cells.radius}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
