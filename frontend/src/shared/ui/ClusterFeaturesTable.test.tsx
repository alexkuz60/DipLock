/**
 * Таблица профилей признаков (Т2): колонки есть, «—» без превращения в 0.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ClusterFeatures } from '@/shared/api/types'
import { renderWithProviders } from '@/test/renderWithProviders'
import { ClusterFeaturesTable } from './ClusterFeaturesTable'

const measured: ClusterFeatures = {
  n_points: 14,
  share: 0.875,
  structure_share: [{ name: 'ствол мозга', share: 0.571 }],
  structure_entropy: 0.754,
  hemisphere_share: { left: 0.5, midline: 0, right: 0.5 },
  moment_sum_nam: 600,
  moment_mean_nam: 483,
  moment_max_nam: 827.7,
  gof_median: 0.93,
  gof_min: 0.905,
  n_kd_evaluated: 14,
  n_kd_passed: 14,
  kd_pass_share: 1,
  radius_rms_mm: 21.1,
}

describe('ClusterFeaturesTable', () => {
  it('строка с профилем: измеренные числа в колонках', () => {
    renderWithProviders(
      <ClusterFeaturesTable
        rows={[{ id: 'a:0', label: 'delta', labelHint: 'устойчивость 1/2 полос', features: measured }]}
      />,
    )
    expect(screen.getByTestId('cluster-features-table')).toBeInTheDocument()
    expect(screen.getByText('delta')).toBeInTheDocument()
    expect(screen.getByText('устойчивость 1/2 полос')).toBeInTheDocument()
    expect(screen.getByText(/ствол мозга/)).toBeInTheDocument()
    expect(screen.getByText('0.754')).toBeInTheDocument()
    expect(screen.getByText('483 / макс 827.7')).toBeInTheDocument()
    expect(screen.getByText('0.93 (0.905)')).toBeInTheDocument()
    expect(screen.getByText('100 % (14/14)')).toBeInTheDocument()
    expect(screen.getByText('21.1')).toBeInTheDocument()
  })

  it('без профиля — только «—», без нулей в числовых колонках', () => {
    renderWithProviders(
      <ClusterFeaturesTable
        rows={[{ id: 'x', label: 'beta', features: null }]}
      />,
    )
    const row = screen.getByTestId('cluster-features-row')
    expect(row).toHaveTextContent('beta')
    expect(row).toHaveTextContent('—')
    expect(row).not.toHaveTextContent('0 %')
    expect(row).not.toHaveTextContent('NaN')
  })

  it('пустой список — таблицы нет', () => {
    const { container } = renderWithProviders(<ClusterFeaturesTable rows={[]} />)
    expect(screen.queryByTestId('cluster-features-table')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })
})
