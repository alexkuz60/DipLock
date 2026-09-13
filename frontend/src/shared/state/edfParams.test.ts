/** Тесты слоя параметров EDF: дефолты из /meta, выбор каналов, признак устаревания. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EDF_PARAM_DEFAULTS,
  edfParamsFromMeta,
  paramsEqual,
  useEdfParams,
} from '@/shared/state/edfParams'
import { metaFixture } from '@/test/fixtures'

function resetStore(): void {
  localStorage.clear()
  useEdfParams.setState({
    params: { ...EDF_PARAM_DEFAULTS },
    availableChannels: [],
    applied: null,
  })
}

describe('слой параметров EDF', () => {
  beforeEach(resetStore)

  it('берёт пороги, длину эпохи и каналы из /meta', () => {
    const params = edfParamsFromMeta(metaFixture)

    expect(params.zScoreThreshold).toBe(5)
    expect(params.peakToPeakUv).toBe(100)
    expect(params.flatLineUv).toBe(5)
    expect(params.flatLineMs).toBe(200)
    expect(params.epochLengthMs).toBe(2000)
    expect(params.visibleChannels).toEqual(metaFixture.standard_channels)
  })

  it('без meta возвращает статические дефолты', () => {
    expect(edfParamsFromMeta(null)).toEqual(EDF_PARAM_DEFAULTS)
    expect(edfParamsFromMeta(undefined)).toEqual(EDF_PARAM_DEFAULTS)
  })

  it('setParams меняет только переданные поля', () => {
    useEdfParams.getState().setParams({ notchHz: 50 })

    const params = useEdfParams.getState().params
    expect(params.notchHz).toBe(50)
    expect(params.zScoreThreshold).toBe(EDF_PARAM_DEFAULTS.zScoreThreshold)
    expect(params.epochLengthMs).toBe(EDF_PARAM_DEFAULTS.epochLengthMs)
  })

  it('при первой загрузке записи показывает все каналы, при следующей сохраняет выбор', () => {
    const store = useEdfParams.getState()

    store.setAvailableChannels(['Fp1', 'Fp2', 'C3'])
    expect(useEdfParams.getState().params.visibleChannels).toEqual(['Fp1', 'Fp2', 'C3'])

    useEdfParams.getState().toggleChannel('C3')
    expect(useEdfParams.getState().params.visibleChannels).toEqual(['Fp1', 'Fp2'])

    // Другая запись с тем же набором каналов — прежний выбор не теряется
    useEdfParams.getState().setAvailableChannels(['Fp1', 'Fp2', 'C3'])
    expect(useEdfParams.getState().params.visibleChannels).toEqual(['Fp1', 'Fp2'])

    // Запись без выбранных каналов — показываем доступные
    useEdfParams.getState().setAvailableChannels(['F4', 'C4'])
    expect(useEdfParams.getState().params.visibleChannels).toEqual(['F4', 'C4'])
  })

  it('setAllChannels включает и выключает все каналы записи', () => {
    useEdfParams.getState().setAvailableChannels(['Fp1', 'Fp2'])
    useEdfParams.getState().setAllChannels(false)
    expect(useEdfParams.getState().params.visibleChannels).toEqual([])

    useEdfParams.getState().setAllChannels(true)
    expect(useEdfParams.getState().params.visibleChannels).toEqual(['Fp1', 'Fp2'])
  })

  it('resetToDefaults возвращает значения сервера и пересекает каналы с записью', () => {
    useEdfParams.getState().setAvailableChannels(['Fp1', 'Fp2'])
    useEdfParams.getState().setParams({ notchHz: 60, zScoreThreshold: 12, epochLengthMs: 500 })

    useEdfParams.getState().resetToDefaults(metaFixture)

    const params = useEdfParams.getState().params
    expect(params.notchHz).toBe(EDF_PARAM_DEFAULTS.notchHz)
    expect(params.zScoreThreshold).toBe(5)
    expect(params.epochLengthMs).toBe(2000)
    // Каналы, которых нет в записи, в выбор не попадают
    expect(params.visibleChannels).toEqual(['Fp1', 'Fp2'])
  })

  it('markApplied согласует снимок с параметрами, правка параметра его рассинхронизирует', () => {
    useEdfParams.getState().setAvailableChannels(['Fp1'])
    expect(useEdfParams.getState().applied).toBeNull()

    useEdfParams.getState().markApplied()

    const applied = useEdfParams.getState().applied
    expect(applied).not.toBeNull()
    expect(paramsEqual(applied!, useEdfParams.getState().params)).toBe(true)

    useEdfParams.getState().setParams({ filterPreset: 'custom' })
    expect(paramsEqual(useEdfParams.getState().applied!, useEdfParams.getState().params)).toBe(false)
  })

  it('clearApplied забывает результат (например, при открытии другой записи)', () => {
    useEdfParams.getState().markApplied()
    useEdfParams.getState().clearApplied()

    expect(useEdfParams.getState().applied).toBeNull()
  })

  it('paramsEqual реагирует на каждый значимый параметр', () => {
    const base = { ...EDF_PARAM_DEFAULTS }
    const variants: Partial<typeof base>[] = [
      { amplitudeMode: 'per_channel' },
      { amplitudeScaleUv: 100 },
      { timeLevel: 3 },
      { filterPreset: 'none' },
      { customBand: [2, 30] },
      { notchHz: 50 },
      { reference: 'custom' },
      { zScoreThreshold: 7 },
      { peakToPeakUv: 120 },
      { flatLineUv: 3 },
      { flatLineMs: 300 },
      { epochLengthMs: 1000 },
      { edfUnits: 'uV' },
      { epochBoundaries: false },
      { droppedEpochsHatched: false },
      { visibleChannels: ['Fp1'] },
      { artifactVisibility: { ...base.artifactVisibility, ica_eog: false } },
    ]

    for (const variant of variants) {
      expect(paramsEqual(base, { ...base, ...variant })).toBe(false)
    }
    expect(paramsEqual(base, { ...base })).toBe(true)
  })

  it('в localStorage уходят параметры, но не снимок результата', () => {
    useEdfParams.getState().markApplied()
    useEdfParams.getState().setParams({ notchHz: 50 })

    const raw = localStorage.getItem('diplock.edf') ?? ''
    expect(raw).toContain('"notchHz":50')
    expect(raw).not.toContain('applied')
  })
})
