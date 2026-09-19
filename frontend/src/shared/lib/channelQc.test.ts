/** Пороговая логика QC-индикаторов каналов (шаг 0.4) — без DOM. */
import { describe, expect, it } from 'vitest'
import { channelQcStatus, channelQcTooltip } from '@/shared/lib/channelQc'
import type { ChannelQc } from '@/shared/api/types'

const qc = (share: number, byKind: ChannelQc['by_kind'] = {}): ChannelQc => ({
  channel: 'C3',
  artifact_sec: share * 100,
  artifact_share: share,
  by_kind: byKind,
})

describe('channelQcStatus', () => {
  it('границы порогов: < warn — ок, warn..bad — внимание, >= bad — плохо', () => {
    expect(channelQcStatus(0, 0.05, 0.2)).toBe('ok')
    expect(channelQcStatus(0.049, 0.05, 0.2)).toBe('ok')
    expect(channelQcStatus(0.05, 0.05, 0.2)).toBe('warn')
    expect(channelQcStatus(0.19, 0.05, 0.2)).toBe('warn')
    expect(channelQcStatus(0.2, 0.05, 0.2)).toBe('bad')
    expect(channelQcStatus(1, 0.05, 0.2)).toBe('bad')
  })
})

describe('channelQcTooltip', () => {
  it('чистый канал — без процента и разбивки', () => {
    expect(channelQcTooltip('C3', qc(0))).toBe('C3: артефактов не найдено')
  })

  it('показывает долю и разбивку по типам с русскими подписями', () => {
    const text = channelQcTooltip('C3', qc(0.25, { flat_line: 25, peak_to_peak: 0 }))
    expect(text).toBe('C3: артефакты 25% времени (Плоская линия 25.0 с)')
  })
})
