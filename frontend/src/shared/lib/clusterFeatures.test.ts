/**
 * Подпись профиля признаков кластера: только измеренное показывается,
 * неизмерённое не превращается в «0 %» (честность «не измерено ≠ 0»).
 */
import { describe, expect, it } from 'vitest'

import type { ClusterFeatures } from '@/shared/api/types'
import { clusterFeaturesLabel } from './clusterFeatures'

describe('clusterFeaturesLabel', () => {
  it('без профиля — «—», а не пустая правда', () => {
    expect(clusterFeaturesLabel(null)).toBe('—')
    expect(clusterFeaturesLabel(undefined)).toBe('—')
  })

  it('неизмерённое не показывается: профиль без данных — «—», без нулей', () => {
    const empty = {
      n_points: 3,
      n_kd_evaluated: 0,
      n_kd_passed: 0,
    } as ClusterFeatures
    expect(clusterFeaturesLabel(empty)).toBe('—')
  })

  it('измеренное собирается в строку: момент, GOF, КД, состав, полушария', () => {
    const features: ClusterFeatures = {
      n_points: 3,
      share: 0.3,
      structure_share: [
        { name: 'A', share: 0.667 },
        { name: 'B', share: 0.333 },
      ],
      structure_entropy: 0.811,
      hemisphere_share: { left: 0.333, midline: 0.333, right: 0.333 },
      moment_sum_nam: 600,
      moment_mean_nam: 200,
      moment_max_nam: 300,
      gof_median: 0.85,
      gof_min: 0.8,
      n_kd_evaluated: 3,
      n_kd_passed: 2,
      kd_pass_share: 0.667,
      radius_rms_mm: 5,
    }
    const label = clusterFeaturesLabel(features)
    expect(label).toContain('момент ср 200 нАм (макс 300)')
    expect(label).toContain('GOF 0.85 (мин 0.8)')
    expect(label).toContain('КД 67 % (2/3)')
    expect(label).toContain('состав: A 67 %, B 33 %')
    expect(label).toContain('энтропия 0.811')
    expect(label).toContain('Л/П/С 33 %/33 %/33 %')
    expect(label).toContain('R 5 мм')
  })

  it('КД без вердиктов не показывается как «0 %»', () => {
    const label = clusterFeaturesLabel({
      n_points: 2,
      n_kd_evaluated: 0,
      n_kd_passed: 0,
      kd_pass_share: null,
      moment_mean_nam: 100,
    } as ClusterFeatures)
    expect(label).toContain('момент ср 100 нАм')
    expect(label).not.toContain('КД')
    expect(label).not.toContain('0 %')
  })
})