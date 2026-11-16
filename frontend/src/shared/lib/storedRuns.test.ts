/**
 * Тесты сборки прогона пакета из строк БД (`batchFromStoredPoints`): показ
 * сохранённого прогона обязан быть честным — что БД не сохраняла, то пустое
 * («не измерено»), а не выдуманные нули; точки без координат считаются
 * пропущенными, а не рисуются в (0, 0, 0).
 */
import { describe, expect, it } from 'vitest'
import { batchFromStoredPoints } from './storedRuns'
import {
  analysisDetailFixture,
  analysisPointsFixture,
} from '@/test/fixtures'
import type { DipolePoint } from '@/shared/api/types'

describe('batchFromStoredPoints: прогон из строк БД', () => {
  it('собирает полосы и точки, вердикты КД честно трёхзначны', () => {
    const { batch, skippedPoints } = batchFromStoredPoints(
      analysisDetailFixture(),
      analysisPointsFixture(),
    )
    const bands = batch.bands ?? []
    const alphaPoints = bands[0]?.points ?? []

    expect(skippedPoints).toBe(0)
    expect(bands.map((band) => band.band_key)).toEqual(['alpha', 'beta'])
    // Пустая полоса паспорта видна, а не выпадает из набора
    expect(alphaPoints).toHaveLength(3)
    expect(bands[1]?.state).toBe('empty')
    expect(bands[1]?.points ?? []).toHaveLength(0)

    // КД: NULL — «не оценено», 1 → true, 0 → false (§8.4 п.5)
    expect(alphaPoints.map((point) => point.kd_passed)).toEqual([null, true, false])
    // Момент пика: time_ms из peak_time_ms, а не из другого поля
    expect(alphaPoints[1]?.time_ms).toBe(121)
    // Медиана GOF полосы — по её точкам (0.9, 0.85, 0.8 → 0.85)
    expect(bands[0]?.median_gof).toBeCloseTo(0.85)
  })

  it('пустые поля БД остаются «не измерено», а не нулями', () => {
    const { batch } = batchFromStoredPoints(analysisDetailFixture(), analysisPointsFixture())
    const point = (batch.bands ?? [])[0]?.points?.[0]

    expect(point?.riv).toBeNull()
    expect(point?.ci_mm).toBeNull()
    expect(point?.structure_distance_mm).toBeNull()
    expect(point?.outside_brain).toBeNull()
    // Сетевой фильтр и отбраковка эпох в БД не сохраняются
    expect(batch.notch_hz).toBeNull()
    expect((batch.bands ?? [])[0]?.bad_epoch_indexes).toEqual([])
    // Агрегаты, которых в БД нет, честно пусты — их нельзя считать на клиенте
    expect(batch.comparison).toEqual([])
    expect(batch.clusters).toEqual([])
  })

  it('точки без координат пропускаются со счётчиком и предупреждением полосы', () => {
    const broken: DipolePoint = {
      ...analysisPointsFixture()[0],
      epoch_index: 9,
      head_coords: null,
    }
    const { batch, skippedPoints } = batchFromStoredPoints(analysisDetailFixture(), [
      ...analysisPointsFixture(),
      broken,
    ])
    const alpha = (batch.bands ?? [])[0]

    expect(skippedPoints).toBe(1)
    expect((alpha?.points ?? []).map((point) => point.epoch_index)).toEqual([0, 1, 2])
    expect((alpha?.warnings ?? []).join(' ')).toContain('1')
  })

  it('«своя» полоса получает человечную подпись, а не адрес custom:от-до', () => {
    const rows: DipolePoint[] = [
      {
        ...analysisPointsFixture()[0],
        band_key: 'custom:4.5-6.2',
        band_hz_lo: 4.5,
        band_hz_hi: 6.2,
      },
    ]
    const { batch } = batchFromStoredPoints(
      analysisDetailFixture({ bands: [] }),
      rows,
    )
    const bands = batch.bands ?? []

    // Полосы нет в паспорте — она собирается из строк
    expect(bands).toHaveLength(1)
    expect(bands[0]?.label).toBe('Своя полоса')
    expect(bands[0]?.band_hz).toEqual([4.5, 6.2])
    expect(bands[0]?.state).toBe('ok')
  })
})