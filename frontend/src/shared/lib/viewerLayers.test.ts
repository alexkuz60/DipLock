/**
 * Тесты чистых слоёв вьюера (срез 2.6): сетка эпох, видимость зон, подписи
 * и детерминированная фикстура артефактов.
 *
 * Слои — обычная арифметика поверх параметров, поэтому проверяются без DOM:
 * рендер зон/штриховки вынесен в `TrackLayers.test.tsx`, вьюер целиком — в
 * `viewer/TrackStack.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { ARTIFACT_KINDS } from '@/shared/lib/artifacts'
import {
  MAX_EPOCH_CELLS,
  artifactCounts,
  artifactZoneText,
  buildEpochCells,
  demoLayers,
  formatSecondsRange,
  visibleZones,
  type ArtifactZone,
} from '@/shared/lib/viewerLayers'

const VISIBLE_ALL = { zscore_outlier: true, peak_to_peak: true, flat_line: true, ica_eog: true }

function zone(overrides: Partial<ArtifactZone> = {}): ArtifactZone {
  return {
    id: 'zscore_outlier-1',
    kind: 'zscore_outlier',
    onsetSec: 1.25,
    durationSec: 0.5,
    channels: ['F3', 'C3'],
    ...overrides,
  }
}

describe('сетка эпох', () => {
  it('покрывает запись подряд, хвост последней эпохи короче', () => {
    const cells = buildEpochCells(5, 2000)

    expect(cells.map((cell) => cell.onsetSec)).toEqual([0, 2, 4])
    expect(cells.map((cell) => cell.durationSec)).toEqual([2, 2, 1])
    expect(cells.map((cell) => cell.index)).toEqual([0, 1, 2])
  })

  it('делит ровную длину без «лишней» эпохи из-за погрешности float', () => {
    const cells = buildEpochCells(30, 2000)
    expect(cells).toHaveLength(15)
    expect(cells.at(-1)?.durationSec).toBe(2)
  })

  it('помечает отброшенные эпохи, не меняя геометрию', () => {
    const cells = buildEpochCells(10, 2000, [0, 3, 99])

    expect(cells.map((cell) => cell.rejected)).toEqual([true, false, false, true, false])
  })

  it('пустая или нулевая сессия не даёт эпох', () => {
    expect(buildEpochCells(0, 2000)).toEqual([])
    expect(buildEpochCells(-5, 2000)).toEqual([])
  })

  it('вырожденные параметры не раздувают сетку', () => {
    // 0.5 мс на 10 минут = 1.2 млн эпох: потолок обязателен
    expect(buildEpochCells(600, 0.5)).toHaveLength(MAX_EPOCH_CELLS)
    expect(buildEpochCells(600, 0)).toHaveLength(MAX_EPOCH_CELLS)
  })
})

describe('видимость и подписи зон', () => {
  const zones = [
    zone(),
    zone({ id: 'flat_line-1', kind: 'flat_line', onsetSec: 3, durationSec: 0.25 }),
    zone({ id: 'ica_eog-1', kind: 'ica_eog', onsetSec: 5, durationSec: 2, channels: [] }),
  ]

  it('visibleZones убирает выключенные в легенде типы', () => {
    const visible = visibleZones(zones, {
      ...VISIBLE_ALL,
      flat_line: false,
      ica_eog: false,
    })
    expect(visible.map((item) => item.id)).toEqual(['zscore_outlier-1'])
  })

  it('отсутствующий в настройках тип считается видимым (старый localStorage)', () => {
    const visible = visibleZones(zones, {} as Record<ArtifactZone['kind'], boolean>)
    expect(visible).toHaveLength(3)
  })

  it('подпись зоны содержит тип, интервал и каналы', () => {
    expect(artifactZoneText(zone())).toBe('z-score выбросы: 1.250–1.750 с · каналы: F3, C3')
    expect(artifactZoneText(zones[2]!)).toContain('каналы: весь монтаж')
    expect(formatSecondsRange(0, 0.4)).toBe('0.000–0.400 с')
  })

  it('artifactCounts считает зоны по типам, включая нули', () => {
    expect(artifactCounts(zones)).toEqual({
      zscore_outlier: 1,
      peak_to_peak: 0,
      flat_line: 1,
      ica_eog: 1,
    })
  })
})

describe('фикстура слоёв', () => {
  it('детерминирована: одинаковый вход — одинаковые зоны', () => {
    const first = demoLayers(120, ['F3', 'F4'])
    const second = demoLayers(120, ['F3', 'F4'])
    expect(second).toEqual(first)
    expect(first.source).toBe('demo')
  })

  it('даёт 2–4 зоны каждого типа и все — внутри записи', () => {
    const { artifacts } = demoLayers(120, ['F3', 'F4', 'C3'])

    for (const kind of ARTIFACT_KINDS) {
      const ofKind = artifacts.filter((item) => item.kind === kind)
      expect(ofKind.length).toBeGreaterThanOrEqual(2)
      expect(ofKind.length).toBeLessThanOrEqual(4)
    }
    for (const item of artifacts) {
      expect(item.onsetSec).toBeGreaterThanOrEqual(0)
      expect(item.onsetSec + item.durationSec).toBeLessThanOrEqual(120.0001)
      expect(item.durationSec).toBeGreaterThan(0)
      expect(item.channels.length).toBeGreaterThan(0)
    }
  })

  it('EOG-компонент ICA бьёт по всему монтажу, остальные — по подмножеству', () => {
    const channels = ['F3', 'F4', 'C3', 'C4']
    const { artifacts } = demoLayers(60, channels)

    const ica = artifacts.find((item) => item.kind === 'ica_eog')!
    expect(ica.channels).toEqual(channels)
    for (const item of artifacts.filter((zone) => zone.kind !== 'ica_eog')) {
      expect(item.channels.length).toBeLessThanOrEqual(3)
      for (const name of item.channels) expect(channels).toContain(name)
    }
  })

  it('эпохи-отбросы непусты и лежат в пределах записи', () => {
    const { rejectedEpochs } = demoLayers(60, ['F3'])
    expect(rejectedEpochs.length).toBeGreaterThan(0)
    for (const index of rejectedEpochs) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(30)
    }
  })

  it('короткая запись не даёт зон за границей (нулевая длительность тоже)', () => {
    const { artifacts, rejectedEpochs } = demoLayers(0.5, [])
    for (const item of artifacts) {
      expect(item.onsetSec + item.durationSec).toBeLessThanOrEqual(0.5001)
    }
    expect(rejectedEpochs).toEqual([0])
  })
})
