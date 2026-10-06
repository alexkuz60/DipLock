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
import type { AudioRenderStatus } from '@/shared/api/types'
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

/** Токен запуска: новый рендер или сброс делают поллинг прежнего цикла чужим. */
const renderToken = createRunToken()

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
  /** id запущенного рендера — `null`, пока не запускали */
  renderId: string | null
  /** Запись, для которой запущен рендер (сброс при закрытии/смене записи) */
  renderRecordingId: string | null
  /** Статус поллинга (шаг, проценты, треки) — `null` до первого опроса */
  status: AudioRenderStatus | null
  /** POST ушёл или поллинг ещё идёт */
  busy: boolean
  /** Текст ошибки сети/сервера — показывается рабочей областью */
  error: string | null
  setBoostDb: (value: number) => void
  setLoudness: (value: boolean) => void
  setLoudnessPhon: (value: number) => void
  setAutobase: (value: boolean) => void
  setOctaveShift: (value: OctaveShift) => void
  /** Запуск рендера кнопкой тулс-хедера: текущая запись + параметры из формы */
  start: () => Promise<void>
  /** Сброс результата и поллинга (закрытие/смена записи) — параметры остаются */
  reset: () => void
}

export const useNeuromusic = create<NeuromusicState>()((set, get) => ({
  boostDb: DEFAULT_BOOST_DB,
  loudness: true,
  loudnessPhon: DEFAULT_LOUDNESS_PHON,
  autobase: true,
  octaveShift: DEFAULT_OCTAVE_SHIFT,
  renderId: null,
  renderRecordingId: null,
  status: null,
  busy: false,
  error: null,

  setBoostDb: (boostDb) => set({ boostDb }),
  setLoudness: (loudness) => set({ loudness }),
  setLoudnessPhon: (loudnessPhon) => set({ loudnessPhon }),
  setAutobase: (autobase) => set({ autobase }),
  setOctaveShift: (octaveShift) => set({ octaveShift }),

  start: async () => {
    const recording = useEdfRecording.getState().recording
    if (!recording) return
    const { boostDb, loudness, loudnessPhon, autobase, octaveShift } = get()
    const token = renderToken.next()
    const isCurrent = () => renderToken.isCurrent(token)
    set({
      busy: true,
      error: null,
      status: null,
      renderId: null,
      renderRecordingId: recording.recording_id,
    })
    try {
      const started = await api.audioRender(recording.recording_id, {
        boostDb,
        octaveShift,
        loudnessPhon: loudness ? loudnessPhon : null,
        loudnessAutobase: autobase,
      })
      if (!isCurrent()) return
      set({ renderId: started.render_id })
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

  reset: () => {
    renderToken.cancel()
    set({ renderId: null, renderRecordingId: null, status: null, busy: false, error: null })
  },
}))
