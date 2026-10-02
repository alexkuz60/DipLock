/**
 * Тесты схемы подписей каналов (`shared/lib/channelNaming.ts`).
 *
 * Проверяется то, что видит пользователь: четыре переименования MCN в обе
 * стороны, неизменность остальных каналов и миксов, и состав вариантов селекта.
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_NAMING_OPTIONS,
  channelDisplayName,
  channelDisplayNames,
} from './channelNaming'

describe('схема имён каналов', () => {
  it('в классической 10-20 показывает четыре переименованных электрода', () => {
    expect(['T7', 'T8', 'P7', 'P8'].map((name) => channelDisplayName(name, '10-20'))).toEqual([
      'T3',
      'T4',
      'T5',
      'T6',
    ])
  })

  it('в современной 10-10 классические имена приводятся к каноническим', () => {
    expect(['T3', 'T4', 'T5', 'T6'].map((name) => channelDisplayName(name, '10-10'))).toEqual([
      'T7',
      'T8',
      'P7',
      'P8',
    ])
    // Канонические имена в 10-10 не меняются
    expect(channelDisplayName('T7', '10-10')).toBe('T7')
  })

  it('остальные каналы и миксы не трогает ни одна схема', () => {
    for (const name of ['Fp1', 'F3', 'Cz', 'Oz', 'mix:frontal', 'ЧСС', '']) {
      expect(channelDisplayName(name, '10-20')).toBe(name)
      expect(channelDisplayName(name, '10-10')).toBe(name)
    }
  })

  it('список подписей переводится целиком (височные ЧСС, каналы микса)', () => {
    expect(channelDisplayNames(['T7', 'Fp1', 'T8'], '10-20')).toEqual(['T3', 'Fp1', 'T4'])
  })

  it('селект «Имена» — ровно две схемы, 10-10 первой (дефолт)', () => {
    expect(CHANNEL_NAMING_OPTIONS.map((option) => option.value)).toEqual(['10-10', '10-20'])
    expect(CHANNEL_NAMING_OPTIONS.every((option) => option.label === option.value)).toBe(true)
  })
})