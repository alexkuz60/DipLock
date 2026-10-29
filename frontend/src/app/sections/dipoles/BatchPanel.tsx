/**
 * Панель «Пакет поддиапазонов» (С1/С2): полосы прогона, их отображение,
 * сопоставление и кластеры.
 *
 * Прогон всегда идёт по **всему каталогу** полос (`freq_bands` +
 * `functional_bands`) кнопкой «Рассчитать пакет» в шапке — выбор полос для
 * прогона из UI убран (его дублировал список отображения). Правка выбора
 * полос анимации/облака **ничего не запускает** (правило раздела). Результат —
 * набор (`batch`), а не один `result`: активная полоса выбирается в разделе
 * «Таблица локализации» (её точки показывают таблица и подписи), а здесь —
 * чекбоксы отображения, сопоставление и кластеры. В сопоставлении — только
 * **нормированные** величины: GOF между полосами не сравним (принцип 3,
 * `docs/rules/dipoles.md`), и колонки GOF здесь нет.
 */
import { bandLabel, shareLabel } from '@/shared/lib/dipoleBatch'
import { bandColor } from '@/shared/lib/bandColors'
import { clusterFeaturesLabel } from '@/shared/lib/clusterFeatures'
import { calcJobSummary } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'

/** Ячейка сопоставления: число с единицами или «—» (не измерено). */
function Cell({ value }: { value: string }) {
  return <td className="px-2 py-1 text-right tabular-nums">{value}</td>
}

export function BatchPanel() {
  const batch = useDipoleCalc((state) => state.batch)
  const batchJob = useDipoleCalc((state) => state.batchJob)
  const batchError = useDipoleCalc((state) => state.batchError)
  const activeBandKey = useDipoleCalc((state) => state.activeBandKey)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const togglePlaybackBand = useDipoleCalc((state) => state.togglePlaybackBand)
  const setPlaybackBandKeys = useDipoleCalc((state) => state.setPlaybackBandKeys)

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
        Прогон идёт по всем полосам каталога кнопкой «Рассчитать пакет» в шапке
        раздела; здесь — полосы результата и их отображение (правка ничего не
        запускает).
      </p>
      {batchJob ? <p className="mt-2 text-sm text-fg-2">{calcJobSummary(batchJob)}</p> : null}
      {batchError ? <p className="mt-2 text-sm text-warn">{batchError}</p> : null}

      {bands.length > 0 ? (
        <>
          {/* П.1.4 (17.10.2026): любая комбинация полос в анимации и облаке —
              от всех до одной. Цвета полос — гамма от красного (δ) до
              ярко-фиолетового (высокая гамма), маркеры чекбоксов показывают её */}
          <p className="mt-3 text-sm font-medium">Полосы в анимации и облаке</p>
          <p className="mt-1 text-xs text-fg-2">
            Отмеченные полосы рисуются одновременно своими цветами (красный — δ,
            ярко-фиолетовый — высокая гамма): чекбоксы управляют и кадром анимации, и
            облаком точек с векторами.
          </p>
          {bands.map((band) => (
            <CheckboxRow
              key={`playback-${band.band_key}`}
              label={band.label}
              mono
              swatch={bandColor(band.band_hz)}
              hint={`Полоса ${band.band_hz[0]}–${band.band_hz[1]} Гц — в анимации и облаке точек`}
              checked={playbackBandKeys.includes(band.band_key)}
              onChange={() => togglePlaybackBand(band.band_key)}
            />
          ))}
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => setPlaybackBandKeys(bands.map((band) => band.band_key))}
              title="Показать в анимации и облаке все полосы пакета"
            >
              Все полосы
            </Button>
            <Button
              onClick={() => setPlaybackBandKeys(activeBandKey ? [activeBandKey] : [])}
              title="Показать только активную полосу (она выбрана в разделе «Таблица локализации»)"
            >
              Только активная
            </Button>
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
                {/* Профиль признаков (ищем характерное сами): только измеренное */}
                <div className="mt-0.5 text-xs text-fg-2">
                  {clusterFeaturesLabel(cluster.features)}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  )
}