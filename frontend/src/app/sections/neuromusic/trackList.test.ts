import { api } from '@/shared/api/client'
import { buildTrackList } from './trackList'

describe('buildTrackList — треки для движка плеера', () => {
  const base = { renderId: 'r-42', bands: ['delta', 'alpha'] }

  it('«Экспресс»: трек на полосу, без ряда', () => {
    const tracks = buildTrackList({ ...base, variant: 'express', rows: [] })
    expect(tracks).toHaveLength(2)
    expect(tracks[0]).toEqual({
      key: 'delta',
      url: expect.stringContaining(`/audio/render/r-42/track/delta.wav`),
    })
    expect(tracks[0].row).toBeUndefined()
  })

  it('«Монтаж»: ряд × полоса — каждый трек несёт свой ряд', () => {
    const tracks = buildTrackList({
      ...base,
      variant: 'montage',
      rows: ['frontal', 'temporal'],
    })
    // 2 ряда × 2 полосы = 4 стема, порядок row-major (слоты считает движок).
    expect(tracks).toHaveLength(4)
    expect(tracks.map((track) => track.row)).toEqual([
      'frontal',
      'frontal',
      'temporal',
      'temporal',
    ])
    expect(tracks[0].url).toBe(api.audioRowTrackUrl('r-42', 'frontal', 'delta'))
    expect(tracks[3].url).toBe(api.audioRowTrackUrl('r-42', 'temporal', 'alpha'))
  })

  it('«Монтаж» без рядов (неполный EDF) — фоллбэк на полосовые треки', () => {
    const tracks = buildTrackList({ ...base, variant: 'montage', rows: [] })
    expect(tracks).toHaveLength(2)
    expect(tracks.every((track) => track.row === undefined)).toBe(true)
  })
})
