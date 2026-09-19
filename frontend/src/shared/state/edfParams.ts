/**
 * Параметры раздела EDF: где живёт выбор пользователя и как понять, что
 * результат предподготовки устарел.
 *
 * Ключевое правило (`docs/ui.md`): правка параметра **ничего не запускает**.
 * Обработка стартует только по кнопке, которая вызывает `markStageApplied()` —
 * с этого момента параметры стадии и результат снова согласованы. До этого
 * панель и тулс-хедер показывают «параметры изменены, результат не пересчитан».
 *
 * **Стадии** (`RecalcStage`): фильтр/референс, поиск артефактов, нарезка эпох.
 * У каждой свой набор параметров (`STAGE_PARAM_KEYS`) и свой снимок результата,
 * поэтому пересчёт одной стадии не обесценивает две другие. Параметры
 * отображения (зум, шкала мкВ, видимость зон) расчёт не устаревают вовсе.
 *
 * В localStorage уходят только параметры (`params`), но не снимки результатов:
 * результат живёт на сервере и после перезагрузки страницы к нему нужен новый
 * запуск, поэтому «результат не рассчитан» — честное состояние.
 */
import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MetaResponse } from '@/shared/api/types'
import type { ArtifactKind } from '@/shared/lib/artifacts'

// Контракт артефактов живёт в `shared/lib/artifacts.ts` (срез 2.6): цвета селектят
// и панель, и слои вьюера. Реэкспорт — чтобы раздел импортировал одно место.
export type { ArtifactKind } from '@/shared/lib/artifacts'
export {
  ARTIFACT_COLORS,
  ARTIFACT_KINDS,
  ARTIFACT_LABELS,
  ARTIFACT_SHORT_LABELS,
} from '@/shared/lib/artifacts'

/** Как масштабировать треки: одна шкала на все каналы или своя у каждого */
export type AmplitudeMode = 'shared' | 'per_channel'

export type ReferenceMode = 'average' | 'custom'

/** Единицы EDF: 'auto' — авто-детект масштаба на бэкенде (см. EDF_UNITS) */
export type EdfUnits = 'auto' | 'V' | 'mV' | 'uV'

/** Варианты единиц для селектов (панель и паспорт сессии) — один источник */
export const EDF_UNITS_OPTIONS: { value: EdfUnits; label: string }[] = [
  { value: 'auto', label: 'Авто (по масштабу файла)' },
  { value: 'V', label: 'Вольты (V)' },
  { value: 'mV', label: 'Милливольты (mV)' },
  { value: 'uV', label: 'Микровольты (µV)' },
]

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
  // Дефолт совпадает с backend (config.flat_line_threshold_uv): размах
  // в окне 100 мс, а не абсолютная амплитуда (N7/F20). /meta уточняет.
  flatLineUv: 1,
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

/**
 * Стадии предподготовки. У каждой — свой набор параметров и свой снимок
 * результата: пересчёт фильтра не обесценивает найденные артефакты.
 */
export type RecalcStage = 'filter' | 'artifacts' | 'epochs'

export const RECALC_STAGES: RecalcStage[] = ['filter', 'artifacts', 'epochs']

export const RECALC_STAGE_LABELS: Record<RecalcStage, string> = {
  filter: 'Фильтр и референс',
  artifacts: 'Поиск артефактов',
  epochs: 'Нарезка эпох',
}

/**
 * Параметры каждой стадии. Зум, шкала мкВ и видимость зон сюда не входят:
 * это отрисовка, а не расчёт. Выбор каналов — исключение: при референсе «по
 * каналам» он меняет результат фильтрации, поэтому относится к стадии «фильтр».
 */
export const STAGE_PARAM_KEYS: Record<RecalcStage, (keyof EdfParams)[]> = {
  filter: ['filterPreset', 'customBand', 'notchHz', 'reference', 'edfUnits', 'visibleChannels'],
  artifacts: ['zScoreThreshold', 'peakToPeakUv', 'flatLineUv', 'flatLineMs'],
  epochs: ['epochLengthMs'],
}

/** Состояние стадии: не считалась / параметры изменились / результат актуален. */
export type EdfStageState = 'not_run' | 'stale' | 'ready'

/** Снимки результатов по стадиям: null — стадия ещё не рассчитывалась. */
export type EdfStageSnapshot = Record<RecalcStage, string | null>

export function emptyStageSnapshot(): EdfStageSnapshot {
  return { filter: null, artifacts: null, epochs: null }
}

/** Сериализованный снимок параметров стадии — сравнение без глубокого equals. */
export function stageSignature(params: EdfParams, stage: RecalcStage): string {
  return JSON.stringify(STAGE_PARAM_KEYS[stage].map((key) => params[key]))
}

export function stageStateOf(
  params: EdfParams,
  snapshot: EdfStageSnapshot,
  stage: RecalcStage,
): EdfStageState {
  const applied = snapshot[stage]
  if (!applied) return 'not_run'
  return applied === stageSignature(params, stage) ? 'ready' : 'stale'
}

export function stageStatesOf(
  params: EdfParams,
  snapshot: EdfStageSnapshot,
): Record<RecalcStage, EdfStageState> {
  return {
    filter: stageStateOf(params, snapshot, 'filter'),
    artifacts: stageStateOf(params, snapshot, 'artifacts'),
    epochs: stageStateOf(params, snapshot, 'epochs'),
  }
}

/** Сводка готовности перерасчёта: одна строка для панели и сегменты прогресс-бара. */
export type EdfRecalcStatus = {
  states: Record<RecalcStage, EdfStageState>
  ready: number
  stale: number
  notRun: number
  total: number
  tone: 'neutral' | 'ok' | 'warn'
  text: string
}

export function recalcStatusFrom(states: Record<RecalcStage, EdfStageState>): EdfRecalcStatus {
  const total = RECALC_STAGES.length
  const values = RECALC_STAGES.map((stage) => states[stage])
  const ready = values.filter((value) => value === 'ready').length
  const stale = values.filter((value) => value === 'stale').length
  const notRun = values.filter((value) => value === 'not_run').length

  if (ready === total) {
    return { states, ready, stale, notRun, total, tone: 'ok', text: 'Результат соответствует параметрам' }
  }
  if (stale > 0) {
    return {
      states,
      ready,
      stale,
      notRun,
      total,
      tone: 'warn',
      text: 'Параметры изменены — результат не пересчитан',
    }
  }
  if (ready === 0) {
    return { states, ready, stale, notRun, total, tone: 'neutral', text: 'Результат не рассчитан' }
  }
  return {
    states,
    ready,
    stale,
    notRun,
    total,
    tone: 'warn',
    text: `Результат неполный: пересчитано ${ready} из ${total} стадий`,
  }
}

export type EdfParamsState = {
  /** Текущий выбор пользователя (то, что видно в панели) */
  params: EdfParams
  /** Каналы записи, доступные для выбора (пустой — запись не загружена) */
  availableChannels: string[]
  /** Снимки результатов по стадиям (null — стадия ещё не рассчитывалась) */
  stageApplied: EdfStageSnapshot
  setParams: (patch: Partial<EdfParams>) => void
  setAvailableChannels: (channels: string[]) => void
  toggleChannel: (name: string) => void
  setAllChannels: (visible: boolean) => void
  /** Сброс к значениям сервера (пороги/эпохи из `/meta`) */
  resetToDefaults: (meta?: MetaResponse | null) => void
  /** Фиксирует, что стадия рассчитана именно с текущими параметрами */
  markStageApplied: (stage: RecalcStage, signature?: string) => void
  /** Все стадии рассчитаны (полная предподготовка одной задачей) */
  markApplied: () => void
  /** Забыть результат одной стадии или всех (при открытии другой записи) */
  clearApplied: (stage?: RecalcStage) => void
  /**
   * Показать/скрыть тип артефакта в слоях вьюера. Параметр отрисовки: расчёт
   * не устаревает и запросов не делает (легенда в панели и в шапке вьюера).
   */
  toggleArtifactVisibility: (kind: ArtifactKind) => void
}

export const useEdfParams = create<EdfParamsState>()(
  persist(
    (set) => ({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
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
      markStageApplied: (stage, signature) =>
        set((state) => ({
          stageApplied: {
            ...state.stageApplied,
            // Подпись можно передать явно: задача могла считаться по параметрам,
            // которые пользователь успел изменить, пока она выполнялась.
            [stage]: signature ?? stageSignature(state.params, stage),
          },
        })),
      markApplied: () =>
        set((state) => {
          const next = { ...state.stageApplied }
          for (const stage of RECALC_STAGES) next[stage] = stageSignature(state.params, stage)
          return { stageApplied: next }
        }),
      clearApplied: (stage) =>
        set((state) =>
          stage
            ? { stageApplied: { ...state.stageApplied, [stage]: null } }
            : { stageApplied: emptyStageSnapshot() },
        ),
      toggleArtifactVisibility: (kind) =>
        set((state) => ({
          params: {
            ...state.params,
            artifactVisibility: {
              ...state.params.artifactVisibility,
              [kind]: !state.params.artifactVisibility[kind],
            },
          },
        })),
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
          // Снимки результатов не переживают перезагрузку — берём из дефолтов,
          // а не из возможного мусора в localStorage.
          stageApplied: emptyStageSnapshot(),
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

/** Сводка готовности перерасчёта: состояния стадий + текст и тон для панели. */
export function useEdfRecalcStatus(): EdfRecalcStatus {
  const params = useEdfParams((state) => state.params)
  const snapshot = useEdfParams((state) => state.stageApplied)
  return useMemo(() => recalcStatusFrom(stageStatesOf(params, snapshot)), [params, snapshot])
}

/**
 * Готовность конкретной стадии: пересчитана ли она и не устарела ли.
 * Кнопка перерасчёта активна при непустом `needsRecalc`.
 */
export function useEdfStageState(stage: RecalcStage): {
  state: EdfStageState
  needsRecalc: boolean
} {
  const params = useEdfParams((state) => state.params)
  const snapshot = useEdfParams((state) => state.stageApplied)
  const state = stageStateOf(params, snapshot, stage)
  return { state, needsRecalc: state !== 'ready' }
}

/** Есть ли хоть одна стадия, которую надо пересчитать (для кнопки «всё»). */
export function useEdfNeedsRecalc(): boolean {
  const status = useEdfRecalcStatus()
  return status.ready !== status.total
}
