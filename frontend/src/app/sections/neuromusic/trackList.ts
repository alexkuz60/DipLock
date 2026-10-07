/**
 * Список треков для движка плеера «Нейромузыки»: «Экспресс» — трек на полосу,
 * «Монтаж» — ряд × полоса (28 стемов) с указанием ряда модуля.
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
  /** Вариант рендера из статуса (`status.variant`) */
  variant: string
  /** id рядов «Монтажа» (`status.rows`) */
  rows: readonly string[]
}): NeuromusicTrack[] {
  const { renderId, bands, variant, rows } = options
  if (variant === 'montage' && rows.length > 0) {
    // row-major: ряд → его полосы (слоты в модуле считает сам движок).
    return rows.flatMap((row) =>
      bands.map((key) => ({ key, url: api.audioRowTrackUrl(renderId, row, key), row })),
    )
  }
  return bands.map((key) => ({ key, url: api.audioTrackUrl(renderId, key) }))
}
