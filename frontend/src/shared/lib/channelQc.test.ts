/** Пороговая логика QC-индикаторов каналов (шаг 0.4) — без DOM. */
import { describe, expect, it } from 'vitest'
import { channelQcStatus, channelQcTooltip } from '@/shared/lib/channelQc'
import type { ChannelQc } from '@/shared/api/types'

const qc = (share: number, byKind: ChannelQc['by_kind'] = {}): ChannelQc => ({
  channel: 'C3',
  artifact_sec: share * 100,
  artifact_share: share,
  by_kind: byKind,
  snr_db: null,
  dead: false,
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

  it('мёртвый канал — «плохо» всегда (шаг 2.2)', () => {
    expect(channelQcStatus(0, 0.05, 0.2, null, true)).toBe('bad')
    expect(channelQcStatus(0, 0.05, 0.2, 20, true)).toBe('bad')
  })

  it('низкий SNR поднимает статус до порогов конфига (шаг 2.2)', () => {
    expect(channelQcStatus(0, 0.05, 0.2, 15)).toBe('ok')
    expect(channelQcStatus(0, 0.05, 0.2, 8)).toBe('warn')
    expect(channelQcStatus(0, 0.05, 0.2, 3)).toBe('bad')
    // доля зон уже «плохо» — низкий SNR не смягчает
    expect(channelQcStatus(0.3, 0.05, 0.2, 20)).toBe('bad')
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

  it('добавляет SNR и признак мёртвого канала (шаг 2.2)', () => {
    const text = channelQcTooltip('C3', { ...qc(0), snr_db: 7.5, dead: true })
    expect(text).toBe(
      'C3: артефактов не найдено · мёртвый канал (константный до референса) · SNR 7.5 дБ',
    )
  })
})
