/**
 * Артефакты в разделе «ЭЭГ»: слои, посчитанные в EDF, показанные на одном канале.
 *
 * Зоны приходят из результата стадии «Артефакты» (срез 2.7) — раздел «ЭЭГ» их не
 * считает и не имитирует: он показывает то же, что вьюер EDF, чтобы найденное
 * можно было контролировать глазами рядом со спектрограммой.
 *
 * Отбор по каналу — обязательный шаг: у зоны есть список затронутых электродов, и
 * зона «только F8» на треке F3 читалась бы как артефакт F3. Пустой список каналов
 * у зоны означает «весь монтаж» (так выглядят, например, ICA-компоненты) — такие
 * зоны показываются на любом канале.
 *
 * Модуль чистый (без DOM и zustand): и отбор, и попадание в окно проверяются
 * тестами, а холст только рисует готовый список.
 */
import type { ArtifactZone } from './viewerLayers'
import type { TimeWindow } from './viewerMath'

/**
 * Зоны, относящиеся к каналу (или к каналам микса).
 *
 * `channels` — электроды записи, которые стоят за выбранным каналом: для электрода
 * это он сам, для микса — вся группа. Пустой список означает «канал не выбран» —
 * показывать нечего.
 */
export function artifactZonesForChannels(
  zones: readonly ArtifactZone[],
  channels: readonly string[],
): ArtifactZone[] {
  if (channels.length === 0) return []
  const picked = new Set(channels)
  return zones.filter(
    (zone) => zone.channels.length === 0 || zone.channels.some((name) => picked.has(name)),
  )
}

/**
 * Зоны, пересекающие окно времени: подпись «артефактов в окне» считает именно их.
 *
 * Сравнение по интервалам, а не по началу зоны: зона, начавшаяся до окна и
 * продолжающаяся в нём, видна на графике и должна попасть в счёт.
 */
export function zonesInWindow(
  zones: readonly ArtifactZone[],
  window: TimeWindow,
): ArtifactZone[] {
  return zones.filter(
    (zone) => zone.onsetSec < window.t1 && zone.onsetSec + zone.durationSec > window.t0,
  )
}
