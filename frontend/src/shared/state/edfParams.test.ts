/** Тесты слоя параметров EDF: дефолты из /meta, выбор каналов, стадии перерасчёта. */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EDF_PARAM_DEFAULTS,
  RECALC_STAGES,
  STAGE_PARAM_KEYS,
  edfParamsFromMeta,
  emptyStageSnapshot,
  recalcStatusFrom,
  stageSignature,
  stageStateOf,
  stageStatesOf,
  useEdfParams,
  type EdfParams,
  type RecalcStage,
} from '@/shared/state/edfParams'
import { metaFixture } from '@/test/fixtures'

function resetStore(): void {
  localStorage.clear()
  useEdfParams.setState({
    params: { ...EDF_PARAM_DEFAULTS },
    availableChannels: [],
    stageApplied: emptyStageSnapshot(),
  })
}

/** Состояние стадии по текущим параметрам стора. */
function stageState(stage: RecalcStage): string {
  const { params, stageApplied } = useEdfParams.getState()
  return stageStateOf(params, stageApplied, stage)
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

  it('снимок стадии делает её актуальной, правка её параметра — устаревшей', () => {
    useEdfParams.getState().setAvailableChannels(['Fp1'])
    expect(stageState('filter')).toBe('not_run')

    useEdfParams.getState().markStageApplied('filter')

    expect(stageState('filter')).toBe('ready')
    // Соседние стадии пересчёт фильтра не «подтягивает»
    expect(stageState('artifacts')).toBe('not_run')
    expect(stageState('epochs')).toBe('not_run')

    useEdfParams.getState().setParams({ notchHz: 50 })
    expect(stageState('filter')).toBe('stale')
    expect(stageState('artifacts')).toBe('not_run')
  })

  it('markApplied отмечает все стадии, clearApplied(stage) — только одну', () => {
    useEdfParams.getState().markApplied()
    expect(RECALC_STAGES.map(stageState)).toEqual(['ready', 'ready', 'ready'])

    useEdfParams.getState().clearApplied('artifacts')
    expect(stageState('filter')).toBe('ready')
    expect(stageState('artifacts')).toBe('not_run')

    useEdfParams.getState().clearApplied()
    expect(RECALC_STAGES.map(stageState)).toEqual(['not_run', 'not_run', 'not_run'])
  })

  it('параметры отрисовки не устаревают расчёт', () => {
    useEdfParams.getState().markApplied()

    useEdfParams.getState().setParams({
      timeLevel: 3,
      amplitudeMode: 'per_channel',
      amplitudeScaleUv: 100,
      epochBoundaries: false,
      droppedEpochsHatched: false,
      artifactVisibility: { ...EDF_PARAM_DEFAULTS.artifactVisibility, ica_eog: false },
    })

    const status = recalcStatusFrom(
      stageStatesOf(useEdfParams.getState().params, useEdfParams.getState().stageApplied),
    )
    expect(status.stale).toBe(0)
    expect(status.ready).toBe(3)
    expect(status.text).toBe('Результат соответствует параметрам')
  })

  it('сводка различает «не рассчитан», «неполный» и «устаревший» результат', () => {
    const notRun = recalcStatusFrom({ filter: 'not_run', artifacts: 'not_run', epochs: 'not_run' })
    expect(notRun.tone).toBe('neutral')
    expect(notRun.text).toBe('Результат не рассчитан')

    const partial = recalcStatusFrom({ filter: 'ready', artifacts: 'not_run', epochs: 'not_run' })
    expect(partial.text).toBe('Результат неполный: пересчитано 1 из 3 стадий')

    const stale = recalcStatusFrom({ filter: 'stale', artifacts: 'ready', epochs: 'ready' })
    expect(stale.tone).toBe('warn')
    expect(stale.text).toBe('Параметры изменены — результат не пересчитан')
  })

  it('подпись стадии реагирует на каждый свой параметр и не реагирует на чужие', () => {
    const base = { ...EDF_PARAM_DEFAULTS }
    const variants: Record<RecalcStage, Partial<EdfParams>[][]> = {
      filter: [
        [{ filterPreset: 'none' }],
        [{ customBand: [2, 30] }],
        [{ notchHz: 50 }],
        [{ reference: 'custom' }],
        [{ edfUnits: 'uV' }],
        [{ visibleChannels: ['Fp1'] }],
      ],
      artifacts: [
        [{ zScoreThreshold: 7 }],
        [{ peakToPeakUv: 120 }],
        [{ flatLineUv: 3 }],
        [{ flatLineMs: 300 }],
      ],
      epochs: [[{ epochLengthMs: 1000 }]],
    }

    for (const stage of RECALC_STAGES) {
      // Каждый «свой» параметр меняет подпись стадии
      for (const variant of variants[stage]) {
        expect(stageSignature({ ...base, ...variant[0] }, stage)).not.toBe(
          stageSignature(base, stage),
        )
      }
    }

    // Чужие параметры подпись не меняют: пороги артефактов не влияют на эпохи и т.д.
    expect(stageSignature({ ...base, zScoreThreshold: 9 }, 'filter')).toBe(
      stageSignature(base, 'filter'),
    )
    expect(stageSignature({ ...base, epochLengthMs: 500 }, 'artifacts')).toBe(
      stageSignature(base, 'artifacts'),
    )
    expect(stageSignature({ ...base, filterPreset: 'none' }, 'epochs')).toBe(
      stageSignature(base, 'epochs'),
    )
  })

  it('каждая стадия описана своим набором ключей параметров', () => {
    for (const stage of RECALC_STAGES) {
      expect(STAGE_PARAM_KEYS[stage].length).toBeGreaterThan(0)
      // Параметры отрисовки в расчёте не участвуют
      expect(STAGE_PARAM_KEYS[stage]).not.toContain('timeLevel')
      expect(STAGE_PARAM_KEYS[stage]).not.toContain('amplitudeScaleUv')
    }
  })

  it('в localStorage уходят параметры, но не снимки результатов', () => {
    useEdfParams.getState().markApplied()
    useEdfParams.getState().setParams({ notchHz: 50 })

    const raw = localStorage.getItem('diplock.edf') ?? ''
    expect(raw).toContain('"notchHz":50')
    expect(raw).not.toContain('stageApplied')
  })
})
