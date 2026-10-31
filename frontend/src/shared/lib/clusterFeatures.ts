/**
 * Подпись профиля признаков кластера (исследовательский слой, 29.10.2026).
 *
 * Признаки кластеров **ищем сами** — профиль показывает характерные черты
 * скопления данных (состав, сила, качество, КД, компактность). Неизмерённое
 * не показываем: никаких «0 %» и «не оценено → 0» — только измеренные числа.
 */
import type { ClusterFeatures } from '@/shared/api/types'

/** Проценты из доли (0..1) одним знаком: 0.667 → «67 %». */
function pct(share: number): string {
  return `${(share * 100).toFixed(0)} %`
}

/** Проценты из доли (0..1) одним знаком, если доля измерена. */
function pctOrNull(share: number | null | undefined): string | null {
  return share == null ? null : pct(share)
}

/**
 * Ячейки таблицы профиля: только измеренное, `null` → «—».
 * Структура возвращает «доминирующая структура» (топ-1 + доля).
 */
export type ClusterFeatureCells = {
  topStructure: string
  entropy: string
  hemisphere: string
  momentMean: string
  gof: string
  kd: string
  radius: string
}

export function clusterFeatureCells(
  features: ClusterFeatures | null | undefined,
): ClusterFeatureCells {
  const dash = '—'
  if (!features) {
    return {
      topStructure: dash,
      entropy: dash,
      hemisphere: dash,
      momentMean: dash,
      gof: dash,
      kd: dash,
      radius: dash,
    }
  }
  const top = features.structure_share?.[0]
  const topStructure = top
    ? `${top.name} ${pct(top.share)}`
    : dash
  const hemi = features.hemisphere_share
  const hemisphere = hemi
    ? `${pct(hemi.left ?? 0)}/${pct(hemi.right ?? 0)}/${pct(hemi.midline ?? 0)}`
    : dash
  const momentParts: string[] = []
  if (features.moment_mean_nam != null) momentParts.push(String(features.moment_mean_nam))
  if (features.moment_max_nam != null) momentParts.push(`макс ${features.moment_max_nam}`)
  const gof =
    features.gof_median != null
      ? features.gof_min != null
        ? `${features.gof_median} (${features.gof_min})`
        : String(features.gof_median)
      : dash
  const kd =
    pctOrNull(features.kd_pass_share) != null
      ? `${pct(features.kd_pass_share!)} (${features.n_kd_passed}/${features.n_kd_evaluated})`
      : dash
  return {
    topStructure,
    entropy: features.structure_entropy != null ? String(features.structure_entropy) : dash,
    hemisphere,
    momentMean: momentParts.length ? momentParts.join(' / ') : dash,
    gof,
    kd,
    radius: features.radius_rms_mm != null ? String(features.radius_rms_mm) : dash,
  }
}

/** Компактная строка признаков кластера для UI; «—» — профиля/признаков нет. */
export function clusterFeaturesLabel(
  features: ClusterFeatures | null | undefined,
): string {
  if (!features) return '—'
  const parts: string[] = []
  if (features.moment_mean_nam != null) {
    parts.push(
      features.moment_max_nam != null
        ? `момент ср ${features.moment_mean_nam} нАм (макс ${features.moment_max_nam})`
        : `момент ср ${features.moment_mean_nam} нАм`,
    )
  }
  if (features.gof_median != null) {
    parts.push(
      features.gof_min != null
        ? `GOF ${features.gof_median} (мин ${features.gof_min})`
        : `GOF ${features.gof_median}`,
    )
  }
  if (features.kd_pass_share != null) {
    parts.push(
      `КД ${pct(features.kd_pass_share)} (${features.n_kd_passed}/${features.n_kd_evaluated})`,
    )
  }
  const structures = features.structure_share ?? []
  if (structures.length > 0) {
    parts.push(
      `состав: ${structures.map((row) => `${row.name} ${pct(row.share)}`).join(', ')}`,
    )
  }
  if (features.structure_entropy != null) {
    parts.push(`энтропия ${features.structure_entropy}`)
  }
  const hemi = features.hemisphere_share
  if (hemi) {
    parts.push(`Л/П/С ${pct(hemi.left ?? 0)}/${pct(hemi.right ?? 0)}/${pct(hemi.midline ?? 0)}`)
  }
  if (features.radius_rms_mm != null) {
    parts.push(`R ${features.radius_rms_mm} мм`)
  }
  return parts.length > 0 ? parts.join('; ') : '—'
}