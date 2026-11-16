/**
 * Вкладка «Кластеры диполей (С2)» раздела «Таблица локализации».
 *
 * Блок перенесён из панели «Пакет поддиапазонов» (16.11.2026): паспорт
 * нормировки + сравнительная таблица профилей кластеров (`ClusterFeaturesTable`,
 * Т2). Чистое представление — ни запросов, ни правок состояния (правило раздела:
 * запросы идут только по явной кнопке «Уточнить…»). Форма «Черновик правила из
 * профиля» (Т5) осталась в панели «Пакет поддиапазонов» — она делает запросы и
 * в раздел просмотра не входит.
 */
import type { ClusterParams, DipoleCluster } from '@/shared/api/types'
import { ClusterFeaturesTable } from '@/shared/ui/ClusterFeaturesTable'

export function BatchClustersTable({
  clusters,
  clusterParams,
  bandsCount,
}: {
  clusters: DipoleCluster[]
  clusterParams: ClusterParams | null | undefined
  bandsCount: number
}) {
  return (
    <>
      {clusterParams ? (
        <p className="text-sm text-fg-2">
          {`Воксель ${clusterParams.voxel_norm} от диаметра области поиска (${clusterParams.voxel_mm} мм), минимум ${clusterParams.min_points} точек`}
          {clusterParams.kd_filter === 'kd_passed'
            ? '; в кластеры взяты точки, прошедшие КД'
            : '; пороги КД методикой не заданы — взяты все точки'}
          .
        </p>
      ) : null}
      <ClusterFeaturesTable
        testId="batch-cluster-features"
        rows={clusters.map((cluster) => ({
          id: `${cluster.band_key}:${cluster.cluster_index}`,
          label: cluster.band_key,
          labelHint: `устойчивость ${cluster.n_bands_matched}/${bandsCount} полос`,
          features: cluster.features,
        }))}
      />
      <p className="mt-1 text-xs text-fg-2">
        Строка — один кластер: только измеренные признаки; «—» — не измерено
        (не 0). Момент и GOF сравниваются внутри одной полосы.
      </p>
    </>
  )
}