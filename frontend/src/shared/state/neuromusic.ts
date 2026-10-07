/**
 * Состояние раздела «Нейромузыка»: параметры рендера, запуск и поллинг статуса.
 *
 * Раздел разложен на три компонента каркаса (как «Итоги» — `summaryReport`):
 * кнопка «Создать аудио» — иконка тулс-хедера (`neuromusic/NeuromusicToolActions`),
 * параметры — секция правого сайдбара «Опции раздела» (`neuromusic/NeuromusicPanel`),
 * прогресс и плеер — рабочая область (`neuromusic/NeuromusicSection`), поэтому
 * общее состояние живёт здесь, а не в React-state секции.
 *
 * Правило UI не меняется: правка параметра **ничего не запускает** — POST уходит
 * только по кнопке. Персиста нет: рендер живёт в памяти сервера (TTL 15 мин,
 * `docs/rules/neuromusic.md`), а результат принадлежит записи — при закрытии/смене
 * записи его сбрасывает `NeuromusicSection` (паттерн `summaryReport`).
 */
import { create } from 'zustand'
import { api, ApiError } from '@/shared/api/client'
import type { AudioBakeStatus, AudioRenderStatus, AudioRenderVariant } from '@/shared/api/types'
import { createRunToken, JOB_POLL_MS } from '@/shared/lib/jobPolling'
import { useEdfRecording } from '@/shared/state/edfRecording'

/** Дефолтное усиление полос (дБ) — как на сервере (приёмка 05.10.2026: +6…+12). */
export const DEFAULT_BOOST_DB = 6
/** Дефолтный опорный уровень компенсации ISO 226 (фон) — как на сервере. */
export const DEFAULT_LOUDNESS_PHON = 75
/** Выбор транспонирования: октавы → множитель ×2**n (эксперимент 06.10.2026). */
export type OctaveShift = 5 | 6 | 7
export const OCTAVE_SHIFTS: readonly OctaveShift[] = [5, 6, 7]
/** Дефолт сервера — 7 октав (×128), как до появления выбора. */
export const DEFAULT_OCTAVE_SHIFT: OctaveShift = 7
/** Пространственная обработка (spatial-audio, п.1): дефолты параметров плеера. */
export const DEFAULT_SPATIAL_WIDTH_PCT = 100
export const DEFAULT_SPATIAL_SPREAD_PCT = 100
export const DEFAULT_SPATIAL_WET_PCT = 25
export const DEFAULT_SPATIAL_IR = 'room_small'
/** Ширина базы UI ограничена 150 %: width Tone > 0.75 звучит как фазовый сдвиг. */
export const MAX_SPATIAL_WIDTH_PCT = 150

/** Токен запуска: новый рендер или сброс делают поллинг прежнего цикла чужим. */
const renderToken = createRunToken()
/** Тот же приём для поллинга 3D-bake: сброс/новый бак обнуляют чужой цикл. */
const bakeToken = createRunToken()

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Неизвестная ошибка'
}

/** Пауза между опросами статуса — тот же ритм, что `JOB_POLL_MS` у задач. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export type NeuromusicState = {
  /** Базовое усиление полосовых треков, дБ (0…12): правка не запускает расчёт */
  boostDb: number
  /** Компенсация ISO 226 (равная субъективная громкость инструментов) */
  loudness: boolean
  /** Опорный уровень компенсации, фон (60…90) */
  loudnessPhon: number
  /** Режим базы при включённой компенсации: автобаза «ямы» ↔ максимум громкости */
  autobase: boolean
  /** Транспонирование партитуры, октав (5/6/7 → ×32/×64/×128, дефолт 7) */
  octaveShift: OctaveShift
  /** Вариант рендера: «Экспресс» (7 треков L/C/R) ↔ «Монтаж» (4 ряда × полосы) */
  variant: AudioRenderVariant
  /** 3D-режим плеера: Tone-цепочка вместо `<audio>` (правка ≠ расчёт) */
  spatialEnabled: boolean
  /** Ширина стереобазы, % (0…150, 100 — без изменения) */
  spatialWidthPct: number
  /** Разброс источников по дуге, % (0…100, 100 — ±60°) */
  spatialSpreadPct: number
  /** Влажность реверберации, % (0…100) */
  spatialWetPct: number
  /** Пресет IR из `GET /audio/ir` (id) */
  spatialIr: string
  /** id запущенного рендера — `null`, пока не запускали */
  renderId: string | null
  /** Запись, для которой запущен рендер (сброс при закрытии/смене записи) */
  renderRecordingId: string | null
  /** Статус поллинга (шаг, проценты, треки) — `null` до первого опроса */
  status: AudioRenderStatus | null
  /** POST ушёл или поллинг ещё идёт */
  busy: boolean
  /** true — результат взят из дискового кэша (поле `cached` ответа POST) */
  cached: boolean
  /** Текст ошибки сети/сервера — показывается рабочей областью */
  error: string | null
  /** 3D-bake: id запекания (`null` — не запускали), статус, флаг и ошибка */
  bakeId: string | null
  bakeStatus: AudioBakeStatus | null
  bakeBusy: boolean
  bakeError: string | null
  setBoostDb: (value: number) => void
  setLoudness: (value: boolean) => void
  setLoudnessPhon: (value: number) => void
  setAutobase: (value: boolean) => void
  setOctaveShift: (value: OctaveShift) => void
  /** Вариант рендера: правка ≠ расчёт, считает только кнопка запуска */
  setVariant: (value: AudioRenderVariant) => void
  /** Пространственная обработка: правка применяется к живому графу плеера */
  setSpatialEnabled: (value: boolean) => void
  setSpatialWidthPct: (value: number) => void
  setSpatialSpreadPct: (value: number) => void
  setSpatialWetPct: (value: number) => void
  setSpatialIr: (value: string) => void
  /** Запуск рендера кнопкой тулс-хедера: текущая запись + параметры из формы */
  start: () => Promise<void>
  /**
   * 3D-bake: параметры «Пространства» → backend печатает детерминированный
   * WAV (spatial-audio, п.3); поллинг статуса до терминального.
   */
  startBake: () => Promise<void>
  /** Сброс результата и поллинга (закрытие/смена записи) — параметры остаются */
  reset: () => void
}

export const useNeuromusic = create<NeuromusicState>()((set, get) => ({
  boostDb: DEFAULT_BOOST_DB,
  loudness: true,
  loudnessPhon: DEFAULT_LOUDNESS_PHON,
  autobase: true,
  octaveShift: DEFAULT_OCTAVE_SHIFT,
  variant: 'express',
  spatialEnabled: false,
  spatialWidthPct: DEFAULT_SPATIAL_WIDTH_PCT,
  spatialSpreadPct: DEFAULT_SPATIAL_SPREAD_PCT,
  spatialWetPct: DEFAULT_SPATIAL_WET_PCT,
  spatialIr: DEFAULT_SPATIAL_IR,
  renderId: null,
  renderRecordingId: null,
  status: null,
  busy: false,
  cached: false,
  error: null,
  bakeId: null,
  bakeStatus: null,
  bakeBusy: false,
  bakeError: null,

  setBoostDb: (boostDb) => set({ boostDb }),
  setLoudness: (loudness) => set({ loudness }),
  setLoudnessPhon: (loudnessPhon) => set({ loudnessPhon }),
  setAutobase: (autobase) => set({ autobase }),
  setOctaveShift: (octaveShift) => set({ octaveShift }),
  setVariant: (variant) => set({ variant }),
  setSpatialEnabled: (spatialEnabled) => set({ spatialEnabled }),
  setSpatialWidthPct: (spatialWidthPct) => set({ spatialWidthPct }),
  setSpatialSpreadPct: (spatialSpreadPct) => set({ spatialSpreadPct }),
  setSpatialWetPct: (spatialWetPct) => set({ spatialWetPct }),
  setSpatialIr: (spatialIr) => set({ spatialIr }),

  start: async () => {
    const recording = useEdfRecording.getState().recording
    if (!recording) return
    const { boostDb, loudness, loudnessPhon, autobase, octaveShift, variant } = get()
    const token = renderToken.next()
    const isCurrent = () => renderToken.isCurrent(token)
    // Новый рендер обнуляет и чужой цикл 3D-bake: его файлы принадлежали
    // прежним артефактам (старый bake_id перестаёт отдаваться).
    bakeToken.cancel()
    set({
      busy: true,
      error: null,
      status: null,
      renderId: null,
      renderRecordingId: recording.recording_id,
      cached: false,
      bakeId: null,
      bakeStatus: null,
      bakeBusy: false,
      bakeError: null,
    })
    try {
      const started = await api.audioRender(recording.recording_id, {
        boostDb,
        octaveShift,
        loudnessPhon: loudness ? loudnessPhon : null,
        loudnessAutobase: autobase,
        variant,
      })
      if (!isCurrent()) return
      // cached=true — результат уже был посчитан: UI честно показывает «из кэша».
      set({ renderId: started.render_id, cached: started.cached })
      /*
        Поллинг до терминального статуса: у рендера свой контракт
        (running/succeeded/failed, без отмены и job_id), поэтому цикл здесь,
        а не `waitForJob` — как и раньше в React-state секции.
      */
      for (;;) {
        const next = await api.audioRenderStatus(started.render_id)
        if (!isCurrent()) return
        set({ status: next })
        if (next.status !== 'running') {
          set({ busy: false })
          return
        }
        await delay(JOB_POLL_MS)
        if (!isCurrent()) return
      }
    } catch (cause) {
      if (!isCurrent()) return
      set({ busy: false, error: errorText(cause) })
    }
  },

  startBake: async () => {
    const { renderId, status, spatialWidthPct, spatialSpreadPct, spatialWetPct, spatialIr } = get()
    // Запекать можно только готовый рендер: до succeeded кнопка в UI погашена,
    // здесь — вторая линия защиты от 409 «рендер ещё идёт».
    if (!renderId || status?.status !== 'succeeded') return
    const token = bakeToken.next()
    const isCurrent = () => bakeToken.isCurrent(token)
    set({ bakeBusy: true, bakeError: null, bakeStatus: null, bakeId: null })
    try {
      const started = await api.audioBakeStart(renderId, {
        widthPct: spatialWidthPct,
        spreadPct: spatialSpreadPct,
        wetPct: spatialWetPct,
        ir: spatialIr,
      })
      if (!isCurrent()) return
      set({ bakeId: started.bake_id })
      // Поллинг как у рендера: у бака свой контракт (running/succeeded/failed).
      for (;;) {
        const next = await api.audioBakeStatus(renderId, started.bake_id)
        if (!isCurrent()) return
        set({ bakeStatus: next })
        if (next.status !== 'running') {
          set({ bakeBusy: false })
          return
        }
        await delay(JOB_POLL_MS)
        if (!isCurrent()) return
      }
    } catch (cause) {
      if (!isCurrent()) return
      set({ bakeBusy: false, bakeError: errorText(cause) })
    }
  },

  reset: () => {
    renderToken.cancel()
    bakeToken.cancel()
    set({
      renderId: null,
      renderRecordingId: null,
      status: null,
      busy: false,
      cached: false,
      error: null,
      bakeId: null,
      bakeStatus: null,
      bakeBusy: false,
      bakeError: null,
    })
  },
}))
