/**
 * Тесты разбора/сборки общих параметров URL (3.2б, N33): ссылка воспроизводит
 * состояние, мусор игнорируется, дефолты в URL не носятся.
 */
import { describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { clampSlice, defaultSlices, roundMm } from '@/shared/lib/mriProjections'
import { parseSharedUrl, serializeSharedUrl, type SharedUrlState } from './urlState'

const DEFAULT_SLICES = defaultSlices()
const DEFAULT_BAND = CALC_PARAM_DEFAULTS.filterBandHz

describe('parseSharedUrl', () => {
  it('разбирает rec, band и slice из query', () => {
    const parsed = parseSharedUrl('?rec=rec-1&band=8-13&slice=axial:12,sagittal:-24,coronal:30')

    expect(parsed.rec).toBe('rec-1')
    expect(parsed.band).toEqual([8, 13])
    expect(parsed.slices).toEqual({ axial: 12, sagittal: -24, coronal: 30 })
  })

  it('дробные частоты — как есть, мм — roundMm + clampSlice плоскости', () => {
    const parsed = parseSharedUrl('band=7.5-13.2&slice=axial:900')

    expect(parsed.band).toEqual([7.5, 13.2])
    // Миллиметр за границей плоскости зажимается, а не уходит в ссылке как есть
    expect(parsed.slices?.axial).toBe(clampSlice('axial', roundMm(900)))
  })

  it('мусор игнорируется: чужой ключ, путь вместо id, перевёрнутая полоса, NaN', () => {
    const parsed = parseSharedUrl(
      '?other=1&rec=../../etc&band=13-8&slice=midi:5,axial:oops',
    )

    expect(parsed.rec).toBeUndefined()
    expect(parsed.band).toBeUndefined()
    expect(parsed.slices).toBeUndefined()
  })

  it('частичный slice дополняется дефолтами остальных плоскостей', () => {
    const parsed = parseSharedUrl('?slice=axial:12')

    expect(parsed.slices).toEqual({ ...DEFAULT_SLICES, axial: 12 })
  })

  it('пустой query — пустой результат: действуют дефолты сторов', () => {
    expect(parseSharedUrl('')).toEqual({})
    expect(parseSharedUrl('?')).toEqual({})
  })
})

describe('serializeSharedUrl', () => {
  it('дефолты не пишутся: band из CALC_PARAM_DEFAULTS, срезы как defaultSlices', () => {
    expect(DEFAULT_BAND).not.toBeNull()

    const query = serializeSharedUrl({
      rec: null,
      band: DEFAULT_BAND as [number, number],
      slices: DEFAULT_SLICES,
    })

    expect(query.toString()).toBe('')
  })

  it('недефолтные значения пишутся и разбираются обратно (roundtrip)', () => {
    const state: SharedUrlState = {
      rec: 'rec-1',
      band: [8, 13],
      slices: { ...DEFAULT_SLICES, axial: 12 },
    }

    const parsed = parseSharedUrl(`?${serializeSharedUrl(state).toString()}`)

    expect(parsed.rec).toBe('rec-1')
    expect(parsed.band).toEqual([8, 13])
    expect(parsed.slices).toEqual(state.slices)
  })

  it('null band — параметр отсутствует (фильтр выключен)', () => {
    const query = serializeSharedUrl({ rec: null, band: null, slices: DEFAULT_SLICES })

    expect(query.has('band')).toBe(false)
  })
})