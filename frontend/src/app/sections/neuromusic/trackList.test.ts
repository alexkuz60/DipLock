import { api } from '@/shared/api/client'
import { buildTrackList } from './trackList'

describe('buildTrackList — треки для движка плеера', () => {
  const base = { renderId: 'r-42', bands: ['delta', 'alpha'] }

  it('«Экспресс»: трек на полосу', () => {
    const tracks = buildTrackList(base)
    expect(tracks).toHaveLength(2)
    expect(tracks[0]).toEqual({
      key: 'delta',
      url: expect.stringContaining(`/audio/render/r-42/track/delta.wav`),
    })
  })

  it('«Монтаж» (дипольный рендер): тот же список — пространство запечено в треках', () => {
    const tracks = buildTrackList(base)
    expect(tracks).toHaveLength(2)
    expect(tracks[0].url).toBe(api.audioTrackUrl('r-42', 'delta'))
    expect(tracks[1].url).toBe(api.audioTrackUrl('r-42', 'alpha'))
  })
})
