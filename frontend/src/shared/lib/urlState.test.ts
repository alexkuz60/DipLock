/**
 * Тесты разбора/сборки общих параметров URL (3.2б, N33): ссылка воспроизводит
 * состояние, мусор игнорируется, дефолты в URL не носятся. Полоса фильтра
 * (`band`) убрана вместе с одиночным расчётом: `?band=` в старых ссылках просто
 * игнорируется.
 */
import { describe, expect, it } from 'vitest'
import { clampSlice, defaultSlices, roundMm } from '@/shared/lib/mriProjections'
import { parseSharedUrl, serializeSharedUrl, type SharedUrlState } from './urlState'

const DEFAULT_SLICES = defaultSlices()

describe('parseSharedUrl', () => {
  it('разбирает rec и slice из query', () => {
    const parsed = parseSharedUrl('?rec=rec-1&slice=axial:12,sagittal:-24,coronal:30')

    expect(parsed.rec).toBe('rec-1')
    expect(parsed.slices).toEqual({ axial: 12, sagittal: -24, coronal: 30 })
  })

  it('мм — roundMm + clampSlice плоскости', () => {
    const parsed = parseSharedUrl('slice=axial:900')

    // Миллиметр за границей плоскости зажимается, а не уходит в ссылке как есть
    expect(parsed.slices?.axial).toBe(clampSlice('axial', roundMm(900)))
  })

  it('мусор игнорируется: чужой ключ, путь вместо id, устаревший band, NaN', () => {
    const parsed = parseSharedUrl(
      '?other=1&rec=../../etc&band=13-8&slice=midi:5,axial:oops',
    )

    expect(parsed.rec).toBeUndefined()
    expect(parsed).not.toHaveProperty('band')
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
  it('дефолтные срезы не пишутся', () => {
    const query = serializeSharedUrl({
      rec: null,
      slices: DEFAULT_SLICES,
    })

    expect(query.toString()).toBe('')
  })

  it('недефолтные значения пишутся и разбираются обратно (roundtrip)', () => {
    const state: SharedUrlState = {
      rec: 'rec-1',
      slices: { ...DEFAULT_SLICES, axial: 12 },
    }

    const parsed = parseSharedUrl(`?${serializeSharedUrl(state).toString()}`)

    expect(parsed.rec).toBe('rec-1')
    expect(parsed.slices).toEqual(state.slices)
  })
})