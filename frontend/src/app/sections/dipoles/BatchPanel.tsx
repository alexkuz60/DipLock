/**
 * Панель «Пакет поддиапазонов» (С1/С2): набор полос, прогон одним запуском,
 * сопоставление и кластеры.
 *
 * Правило раздела то же, что везде: правка выбора полос **ничего не
 * запускает** — считает кнопка «Считать пакет». Результат — набор
 * (`batch`), а не один `result`: активная полоса переключается чипами, её
 * точки показывают проекции и таблица (`result` держит скан активной полосы —
 * прежняя отрисовка работает без правок). В сопоставлении — только
 * **нормированные** величины: GOF между полосами не сравним (принцип 3,
 * `docs/rules/dipoles.md`), и колонки GOF здесь нет.
 */
import { useQuery } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { api } from '@/shared/api/client'
import { BATCH_MIN_BANDS, bandLabel, shareLabel } from '@/shared/lib/dipoleBatch'
import { calcJobSummary } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { cx } from '@/shared/ui/cx'

/** Ячейка сопоставления: число с единицами или «—» (не измерено). */
function Cell({ value }: { value: string }) {
  return <td className="px-2 py-1 text-right tabular-nums">{value}</td>
}

export function BatchPanel() {
  const recordingId = useEdfRecording((state) => state.recording?.recording_id ?? null)
  const batch = useDipoleCalc((state) => state.batch)
  const batchJob = useDipoleCalc((state) => state.batchJob)
  const batchError = useDipoleCalc((state) => state.batchError)
  const batchBandKeys = useDipoleCalc((state) => state.batchBandKeys)
  const activeBandKey = useDipoleCalc((state) => state.activeBandKey)
  const setBatchBandKeys = useDipoleCalc((state) => state.setBatchBandKeys)
  const runBatch = useDipoleCalc((state) => state.runBatch)
  const setActiveBand = useDipoleCalc((state) => state.setActiveBand)

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const freqBands = meta.data?.freq_bands ?? {}
  const functionalBands = meta.data?.functional_bands ?? {}
  const catalog: Array<{ key: string; range: number[] }> = [
    ...Object.entries(freqBands).map(([key, range]) => ({ key, range })),
    ...Object.entries(functionalBands).map(([key, range]) => ({ key, range })),
  ]

  const toggleBand = (key: string, checked: boolean) => {
    setBatchBandKeys(
      checked
        ? [...batchBandKeys, key]
        : batchBandKeys.filter((item) => item !== key),
    )
  }

  const bands = batch?.bands ?? []
  const comparison = batch?.comparison ?? []
  const clusters = batch?.clusters ?? []
  const clusterParams = batch?.cluster_params

  return (
    <Panel
      title="Пакет поддиапазонов"
      hint="С1: несколько расчётов одной сессии (узкие поддиапазоны δ/θ/α…) одним прогоном и их сопоставление. Ядро перебора строится один раз на пакет."
    >
      <p className="text-sm text-fg-2">
        Выберите полосы (минимум {BATCH_MIN_BANDS}) и нажмите «Считать пакет»:
        правка выбора ничего не запускает.
      </p>
      {catalog.length === 0 ? (
        <p className="mt-1 text-sm text-fg-2">
          Каталог полос придёт из метаданных сервера (/meta).
        </p>
      ) : (
        catalog.map(({ key, range }) => (
          <CheckboxRow
            key={key}
            label={`${key} (${range[0]}–${range[1]} Гц)`}
            mono
            checked={batchBandKeys.includes(key)}
            onChange={(checked) => toggleBand(key, checked)}
          />
        ))
      )}
      <div className="mt-3">
        <Button
          icon={<Play className="size-4" />}
          disabled={!recordingId || batchBandKeys.length < BATCH_MIN_BANDS}
          onClick={() => void runBatch(recordingId)}
          title="Один прогон по выбранным полосам: набор результатов вместо одного"
        >
          Считать пакет
        </Button>
      </div>
      {batchJob ? <p className="mt-2 text-sm text-fg-2">{calcJobSummary(batchJob)}</p> : null}
      {batchError ? <p className="mt-2 text-sm text-warn">{batchError}</p> : null}

      {bands.length > 0 ? (
        <>
          <p className="mt-3 text-sm font-medium">Полосы прогона</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {bands.map((band) => (
              <button
                key={band.band_key}
                type="button"
                className={cx(
                  'rounded-full border px-3 py-1 text-sm transition-colors',
                  band.band_key === activeBandKey
                    ? 'border-accent bg-accent text-on-accent'
                    : 'border-line text-fg hover:border-accent',
                )}
                onClick={() => setActiveBand(band.band_key)}
                title="Показать точки этой полосы на проекциях и в таблице"
              >
                {bandLabel(band)}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {comparison.length > 0 ? (
        <>
          <p className="mt-3 text-sm font-medium">Сопоставление полос</p>
          <p className="mt-1 text-xs text-fg-2">
            Только нормированные величины: GOF между полосами не сравним
            (узкая полоса завышает R²), кросс-полосной фильтр доверия — RIV.
          </p>
          <div className="mt-1 overflow-x-auto">
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
      ) : null}

      {clusters.length > 0 ? (
        <>
          <p className="mt-3 text-sm font-medium">Кластеры диполей (С2)</p>
          {clusterParams ? (
            <p className="mt-1 text-xs text-fg-2">
              {`Воксель ${clusterParams.voxel_norm} от диаметра области поиска (${clusterParams.voxel_mm} мм), минимум ${clusterParams.min_points} точек`}
              {clusterParams.kd_filter === 'kd_passed'
                ? '; в кластеры взяты точки, прошедшие КД'
                : '; пороги КД методикой не заданы — взяты все точки'}
              .
            </p>
          ) : null}
          <ul className="mt-2 space-y-1 text-sm">
            {clusters.map((cluster) => (
              <li
                key={`${cluster.band_key}:${cluster.cluster_index}`}
                className="rounded-lg border border-line-soft px-2 py-1"
              >
                <span className="font-medium">{cluster.band_key}</span>
                {`: ${cluster.n_points} точек (${shareLabel(cluster.share)} полосы), `}
                {`устойчивость ${cluster.n_bands_matched}/${bands.length} полос`}
                {cluster.density_per_cm3 != null
                  ? `, плотность ${cluster.density_per_cm3} /см³`
                  : ''}
                {cluster.top_structures?.length
                  ? ` — ${cluster.top_structures.join(', ')}`
                  : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  )
}