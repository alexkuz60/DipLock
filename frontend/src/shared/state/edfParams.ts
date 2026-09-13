/**
 * Параметры раздела EDF: где живёт выбор пользователя и как понять, что
 * результат предподготовки устарел.
 *
 * Ключевое правило (`docs/ui.md`): правка параметра **ничего не запускает**.
 * Обработка стартует только по кнопке, которая вызывает `markApplied()` —
 * с этого момента параметры и результат снова согласованы. До этого панель
 * показывает «параметры изменены, результат не пересчитан».
 *
 * В localStorage уходят только параметры (`params`), но не снимок `applied`:
 * результат расчёта живёт на сервере и после перезагрузки страницы к нему
 * нужен новый запуск, поэтому «результат не получен» — честное состояние.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MetaResponse } from '@/shared/api/types'

/** Типы артефактов — совпадают с `ArtifactTypes` в контракте API */
export type ArtifactKind = 'zscore_outlier' | 'peak_to_peak' | 'flat_line' | 'ica_eog'

export const ARTIFACT_KINDS: ArtifactKind[] = [
  'zscore_outlier',
  'peak_to_peak',
  'flat_line',
  'ica_eog',
]

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  zscore_outlier: 'z-score выбросы',
  peak_to_peak: 'Превышение peak-to-peak',
  flat_line: 'Плоская линия',
  ica_eog: 'ICA: EOG-компоненты',
}

/** Как масштабировать треки: одна шкала на все каналы или своя у каждого */
export type AmplitudeMode = 'shared' | 'per_channel'

export type ReferenceMode = 'average' | 'custom'

/** Единицы EDF: 'auto' — авто-детект масштаба на бэкенде (см. EDF_UNITS) */
export type EdfUnits = 'auto' | 'V' | 'mV' | 'uV'

export type FilterPresetId = 'band_1_40' | 'band_0_5_70' | 'none' | 'custom'

export type FilterPreset = {
  value: FilterPresetId
  label: string
  /** Границы полосы в Гц (нет — фильтр не применяется) */
  band?: [number, number]
}

export const FILTER_PRESETS: FilterPreset[] = [
  { value: 'band_1_40', label: '1–40 Гц (широкий)', band: [1, 40] },
  { value: 'band_0_5_70', label: '0.5–70 Гц (полный)', band: [0.5, 70] },
  { value: 'none', label: 'Без фильтра' },
  { value: 'custom', label: 'Свой диапазон' },
]

/** Дискретные уровни зума по времени: ×1 … ×16 (дробных нет — см. docs/ui.md) */
export const TIME_LEVELS = [1, 2, 4, 8, 16] as const
export const MAX_TIME_LEVEL = TIME_LEVELS.length - 1

/** Шкалы амплитуды для режима «общий масштаб», мкВ на деление */
export const AMPLITUDE_SCALES_UV = [10, 25, 50, 100, 200]

export type EdfParams = {
  /** Каналы, отображаемые в рабочей области (порядок — как в монтаже) */
  visibleChannels: string[]
  amplitudeMode: AmplitudeMode
  amplitudeScaleUv: number
  /** Уровень зума: индекс в TIME_LEVELS (0 = вся сессия) */
  timeLevel: number
  filterPreset: FilterPresetId
  customBand: [number, number]
  /** Частота notch-фильтра, Гц (0 — выключен) */
  notchHz: number
  reference: ReferenceMode
  zScoreThreshold: number
  peakToPeakUv: number
  flatLineUv: number
  flatLineMs: number
  epochLengthMs: number
  edfUnits: EdfUnits
  artifactVisibility: Record<ArtifactKind, boolean>
  epochBoundaries: boolean
  droppedEpochsHatched: boolean
}

export const EDF_PARAM_DEFAULTS: EdfParams = {
  visibleChannels: [],
  amplitudeMode: 'shared',
  amplitudeScaleUv: 50,
  timeLevel: 0,
  filterPreset: 'band_1_40',
  customBand: [1, 40],
  notchHz: 0,
  reference: 'average',
  zScoreThreshold: 5,
  peakToPeakUv: 100,
  flatLineUv: 5,
  flatLineMs: 200,
  epochLengthMs: 2000,
  edfUnits: 'auto',
  artifactVisibility: {
    zscore_outlier: true,
    peak_to_peak: true,
    flat_line: true,
    ica_eog: true,
  },
  epochBoundaries: true,
  droppedEpochsHatched: true,
}

/**
 * Дефолты из `/api/v1/meta`: пороги, длины эпох и стандартные каналы берутся
 * из конфигурации сервера (`backend/.env`), а не дублируются в UI.
 */
export function edfParamsFromMeta(meta: MetaResponse | null | undefined): EdfParams {
  if (!meta) return { ...EDF_PARAM_DEFAULTS }

  const lengths = meta.epoch_lengths_ms ?? []
  // 2000 мс — привычная длина эпохи для дипольного анализа; иначе максимальная.
  const epochLengthMs = lengths.includes(2000)
    ? 2000
    : (lengths[lengths.length - 1] ?? EDF_PARAM_DEFAULTS.epochLengthMs)

  return {
    ...EDF_PARAM_DEFAULTS,
    visibleChannels: [...meta.standard_channels],
    zScoreThreshold: meta.artifact_thresholds.z_score_threshold,
    peakToPeakUv: meta.artifact_thresholds.peak_to_peak_threshold_uv,
    flatLineUv: meta.artifact_thresholds.flat_line_threshold_uv,
    flatLineMs: meta.artifact_thresholds.flat_line_min_duration_ms,
    epochLengthMs,
  }
}

/** Полное сравнение параметров: определяет, устарел ли результат расчёта. */
export function paramsEqual(a: EdfParams, b: EdfParams): boolean {
  return (
    a.amplitudeMode === b.amplitudeMode &&
    a.amplitudeScaleUv === b.amplitudeScaleUv &&
    a.timeLevel === b.timeLevel &&
    a.filterPreset === b.filterPreset &&
    a.customBand[0] === b.customBand[0] &&
    a.customBand[1] === b.customBand[1] &&
    a.notchHz === b.notchHz &&
    a.reference === b.reference &&
    a.zScoreThreshold === b.zScoreThreshold &&
    a.peakToPeakUv === b.peakToPeakUv &&
    a.flatLineUv === b.flatLineUv &&
    a.flatLineMs === b.flatLineMs &&
    a.epochLengthMs === b.epochLengthMs &&
    a.edfUnits === b.edfUnits &&
    a.epochBoundaries === b.epochBoundaries &&
    a.droppedEpochsHatched === b.droppedEpochsHatched &&
    ARTIFACT_KINDS.every((kind) => a.artifactVisibility[kind] === b.artifactVisibility[kind]) &&
    a.visibleChannels.length === b.visibleChannels.length &&
    a.visibleChannels.every((name, index) => b.visibleChannels[index] === name)
  )
}

export type EdfParamsState = {
  /** Текущий выбор пользователя (то, что видно в панели) */
  params: EdfParams
  /** Каналы записи, доступные для выбора (пустой — запись не загружена) */
  availableChannels: string[]
  /** Снимок параметров, для которого получен результат; null — результата нет */
  applied: EdfParams | null
  setParams: (patch: Partial<EdfParams>) => void
  setAvailableChannels: (channels: string[]) => void
  toggleChannel: (name: string) => void
  setAllChannels: (visible: boolean) => void
  /** Сброс к значениям сервера (пороги/эпохи из `/meta`) */
  resetToDefaults: (meta?: MetaResponse | null) => void
  /** Фиксирует, что расчёт выполнен именно с текущими параметрами */
  markApplied: () => void
  /** Забыть результат (например, при открытии другой записи) */
  clearApplied: () => void
}

export const useEdfParams = create<EdfParamsState>()(
  persist(
    (set) => ({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      applied: null,
      setParams: (patch) => set((state) => ({ params: { ...state.params, ...patch } })),
      setAvailableChannels: (channels) =>
        set((state) => {
          const known = new Set(channels)
          const kept = state.params.visibleChannels.filter((name) => known.has(name))
          return {
            availableChannels: channels,
            // Первая загрузка записи: показываем все каналы; иначе сохраняем выбор.
            params: { ...state.params, visibleChannels: kept.length ? kept : [...channels] },
          }
        }),
      toggleChannel: (name) =>
        set((state) => {
          const selected = state.params.visibleChannels.includes(name)
          return {
            params: {
              ...state.params,
              visibleChannels: selected
                ? state.params.visibleChannels.filter((item) => item !== name)
                : [...state.params.visibleChannels, name],
            },
          }
        }),
      setAllChannels: (visible) =>
        set((state) => ({
          params: {
            ...state.params,
            visibleChannels: visible ? [...state.availableChannels] : [],
          },
        })),
      resetToDefaults: (meta) =>
        set((state) => {
          const next = edfParamsFromMeta(meta)
          const known = new Set(state.availableChannels)
          return {
            params: {
              ...next,
              visibleChannels: state.availableChannels.length
                ? next.visibleChannels.filter((name) => known.has(name))
                : next.visibleChannels,
            },
          }
        }),
      markApplied: () => set((state) => ({ applied: state.params })),
      clearApplied: () => set({ applied: null }),
    }),
    {
      name: 'diplock.edf',
      // Результат расчёта не переживает перезагрузку — храним только параметры.
      partialize: (state) => ({ params: state.params }),
      // Старые сохранённые параметры дополняем новыми ключами дефолтов,
      // иначе после обновления UI часть полей окажется undefined.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as { params?: Partial<EdfParams> }
        const storedParams = stored.params ?? {}
        return {
          ...current,
          params: {
            ...current.params,
            ...storedParams,
            artifactVisibility: {
              ...current.params.artifactVisibility,
              ...(storedParams.artifactVisibility ?? {}),
            },
          },
        }
      },
    },
  ),
)

/** Текущие параметры (подписка на изменения). */
export function useEdfParamsValue(): EdfParams {
  return useEdfParams((state) => state.params)
}

/** Снимок параметров, для которого получен результат (null — не рассчитано). */
export function useEdfApplied(): EdfParams | null {
  return useEdfParams((state) => state.applied)
}

/**
 * Изменены ли параметры после последнего расчёта.
 * Результата ещё нет → false: это не «изменено», а «не рассчитано».
 */
export function useEdfDirty(): boolean {
  const params = useEdfParams((state) => state.params)
  const applied = useEdfParams((state) => state.applied)
  if (!applied) return false
  return !paramsEqual(params, applied)
}
