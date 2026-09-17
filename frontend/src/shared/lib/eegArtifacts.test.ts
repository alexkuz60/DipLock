/**
 * Тесты отбора артефактов для раздела «ЭЭГ» (`shared/lib/eegArtifacts.ts`).
 *
 * Отбор по каналу — не украшение: у зоны есть список электродов, и зона «только
 * F8» на треке F3 читалась бы как артефакт F3. Отдельно проверяется попадание в
 * окно: зона, начавшаяся до окна, видна на графике и обязана попасть в счёт.
 */
import { describe, expect, it } from 'vitest'
import { artifactZonesForChannels, zonesInWindow } from './eegArtifacts'
import type { ArtifactZone } from './viewerLayers'

function zone(patch: Partial<ArtifactZone>): ArtifactZone {
  return {
    id: patch.id ?? 'z1',
    kind: patch.kind ?? 'zscore_outlier',
    onsetSec: patch.onsetSec ?? 0,
    durationSec: patch.durationSec ?? 1,
    channels: patch.channels ?? [],
  }
}

describe('артефакты в «ЭЭГ»', () => {
  it('показывает зоны канала и зоны всего монтажа, чужие — нет', () => {
    const zones = [
      zone({ id: 'own', channels: ['Fp1'] }),
      zone({ id: 'montage', channels: [] }),
      zone({ id: 'other', channels: ['O1', 'O2'] }),
    ]

    expect(artifactZonesForChannels(zones, ['Fp1']).map((item) => item.id)).toEqual([
      'own',
      'montage',
    ])
    // Микс: зона, задевшая любой электрод группы, к нему относится
    expect(artifactZonesForChannels(zones, ['Fp2', 'O1']).map((item) => item.id)).toEqual([
      'montage',
      'other',
    ])
    // Канал не выбран — показывать нечего
    expect(artifactZonesForChannels(zones, [])).toEqual([])
  })

  it('считает зоны, видимые в окне: по интервалам, а не по началу', () => {
    const zones = [
      zone({ id: 'before', onsetSec: 0.5, durationSec: 0.5 }), // закончилась до окна
      zone({ id: 'crossing', onsetSec: 1.5, durationSec: 2 }), // началась до, тянется в окно
      zone({ id: 'inside', onsetSec: 3, durationSec: 0.5 }),
      zone({ id: 'after', onsetSec: 5, durationSec: 1 }),
    ]
    const window = { t0: 2, t1: 4 }

    expect(zonesInWindow(zones, window).map((item) => item.id)).toEqual(['crossing', 'inside'])
  })
})
