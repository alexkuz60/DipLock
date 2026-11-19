/**
 * Список треков для движка плеера «Нейромузыки»: трек на полосу (оба
 * варианта рендера — «Экспресс» и дипольный «Монтаж» отдают
 * `track/{band}.wav`; пространство «Монтажа» запечено в самих треках).
 *
 * Чистая функция поверх URL-адресов API — рендерится трекером
 * (`WaveTracker`) при построении движка и покрыта тестами.
 */
import { api } from '@/shared/api/client'
import type { NeuromusicTrack } from '@/shared/lib/neuromusicPlayer'

export function buildTrackList(options: {
  renderId: string
  /** Ключи полос в порядке партитуры (`status.tracks`) */
  bands: readonly string[]
}): NeuromusicTrack[] {
  return options.bands.map((key) => ({ key, url: api.audioTrackUrl(options.renderId, key) }))
}
