/**
 * Вкладка «Сопоставление полос» (С1) раздела «Таблица локализации».
 *
 * Таблица перенесена из панели «Пакет поддиапазонов» (16.11.2026): в сайдбаре она
 * листалась, а раздел «Таблица локализации» — место просмотра таблиц результата.
 * Только **нормированные** величины: GOF между полосами не сравним (принцип 3,
 * `docs/rules/dipoles.md`), колонки GOF здесь нет, кросс-полосной фильтр доверия —
 * RIV. Компонент — чистое представление: ни запросов, ни правок состояния.
 */
import { bandLabel, shareLabel } from '@/shared/lib/dipoleBatch'
import type { DipoleBandComparison } from '@/shared/api/types'

/** Ячейка сопоставления: число с единицами или «—» (не измерено). */
function Cell({ value }: { value: string }) {
  return <td className="px-2 py-1 text-right tabular-nums">{value}</td>
}

export function BandComparisonTable({ comparison }: { comparison: DipoleBandComparison[] }) {
  return (
    <>
      <p className="text-sm text-fg-2">
        Только нормированные величины: GOF между полосами не сравним
        (узкая полоса завышает R²), кросс-полосной фильтр доверия — RIV.
      </p>
      <div className="mt-1 overflow-x-auto" data-testid="band-comparison">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-fg-2">
              <th className="px-2 py-1">Полоса</th>
              <th className="px-2 py-1 text-right">Точек</th>
              <th className="px-2 py-1 text-right">Прошли КД</th>
              <th className="px-2 py-1 text-right">Момент, медиана</th>
              <th className="px-2 py-1 text-right">Пик, мс</th>
              <th className="px-2 py-1 text-right">RIV</th>
              <th className="px-2 py-1 text-right">Кластеров</th>
              <th className="px-2 py-1 text-right">В кластерах</th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((row) => (
              <tr key={row.band_key} className="border-b border-line-soft">
                <td className="px-2 py-1">{bandLabel(row)}</td>
                <Cell value={String(row.n_points)} />
                <Cell value={shareLabel(row.kd_share)} />
                <Cell value={shareLabel(row.moment_share_median)} />
                <Cell
                  value={
                    row.peak_time_median_ms == null
                      ? '—'
                      : `${Math.round(row.peak_time_median_ms)}`
                  }
                />
                <Cell value={row.median_riv == null ? '—' : row.median_riv.toFixed(2)} />
                <Cell value={String(row.n_clusters ?? 0)} />
                <Cell value={shareLabel(row.cluster_share)} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}