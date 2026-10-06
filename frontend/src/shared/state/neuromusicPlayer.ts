/**
 * Состояние транспорта и вида плеера «Нейромузыки»: источник сигнала, зум,
 * скорость, play/pause/stop и готовность движка (docs/rules/neuromusic.md,
 * §«Плеер-трекер»).
 *
 * Отдельный стор от `neuromusic.ts` (параметры рендера): у плеера свой жизненный
 * цикл — движок создаётся трекером при mounted и освобождается при unmount
 * (смена записи/уход из раздела), а кнопки транспорта живут в хедере раздела и
 * делят с трекером этот стор. Персиста нет (как у рендера): WAV-ы живут на
 * сервере в памяти TTL 15 мин.
 *
 * Позиция проигрывания в стор НЕ кладётся: её опрашивает rAF трекера и рисует
 * позиционер на canvas — состояние на каждый кадр перерисовывало бы весь хедер
 * (правило `docs/rules/frontend-perf.md`).
 */
import { create } from 'zustand'
import type { NeuromusicPlayer } from '@/shared/lib/neuromusicPlayer'
import type { PlaybackRate, TimeZoom } from '@/shared/lib/waveformView'

/** Ключ источника «микс до пост-обработки эффектами». */
export const MASTER_SOURCE = 'master'
/** Дефолты вида: весь файл, обычная скорость (настройки просмотра хранятся). */
export const DEFAULT_PLAYER_ZOOM: TimeZoom = 1
export const DEFAULT_PLAYER_RATE: PlaybackRate = 1

/**
 * Активный движок (синглтон вне React): трекер создаёт при монтировании и
 * отдаёт сюда, хедер-кнопки зовут экшены стора — им нужен доступ без props.
 */
let activePlayer: NeuromusicPlayer | null = null

/** Активный движок или `null` (ещё грузится / раздел закрыт). */
export function getActivePlayer(): NeuromusicPlayer | null {
  return activePlayer
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Неизвестная ошибка плеера'
}

export type NeuromusicPlayerState = {
  /** Источник «проигрывания и визуального контроля»: микс до эффектов или полоса */
  source: string
  /** Горизонтальный зум времени: 1 — весь файл, 10/100 — окно уже */
  zoom: TimeZoom
  /** Скорость: только замедление ×0.5 (слуховой контроль) или ×1.0 */
  rate: PlaybackRate
  /** Плеер играет (для хедер-кнопок; позиция — вне стора, rAF трекера) */
  playing: boolean
  /** Движок построен и готов к игре */
  ready: boolean
  /** Грузится движок/буфер/граф — трекер показывает «Загрузка…» */
  loading: boolean
  /** Текст ошибки сети/декодирования — рисуется трекером */
  error: string | null
  /** Длительность текущего источника, сек (из движка, для шага seek) */
  duration: number
  /** Play/Pause: вызывается кнопкой хедера раздела */
  togglePlay: () => Promise<void>
  /** Стоп: пауза + в начало */
  stop: () => Promise<void>
  /** Перемотка на точку, сек (клик/драг по волне) */
  seek: (seconds: number) => void
  /** Флаг «играет» извне (конец трека, обнаруженный rAF трекера) */
  setPlaying: (playing: boolean) => void
  /** Смена источника: неудача — откат к `currentSource` движка */
  setSource: (source: string) => Promise<void>
  /** Смена зума — чисто вид, без движка */
  setZoom: (zoom: TimeZoom) => void
  /** Смена скорости — на лету, с сохранением позиции */
  setRate: (rate: PlaybackRate) => Promise<void>
  /** Движок построен (трекер) */
  attach: (player: NeuromusicPlayer) => void
  /** Движок освобождён (трекер размонтирован) */
  detach: () => void
  /** Началась загрузка (движок/источник/граф) */
  beginLoad: () => void
  /** Завершилась без ошибки (например, перестройка 3D-графа) */
  endLoad: () => void
  /** Ошибка загрузки/построения */
  fail: (error: string) => void
  /**
   * Сброс результата (смена записи): источник возвращает к мастеру, настройки
   * вида (зум/скорость) остаются — они принадлежат пользователю, не записи.
   */
  reset: () => void
}

export const useNeuromusicPlayer = create<NeuromusicPlayerState>()((set, get) => ({
  source: MASTER_SOURCE,
  zoom: DEFAULT_PLAYER_ZOOM,
  rate: DEFAULT_PLAYER_RATE,
  playing: false,
  ready: false,
  loading: false,
  error: null,
  duration: 0,

  togglePlay: async () => {
    const player = activePlayer
    if (!player) return
    if (get().playing) {
      player.pause()
      set({ playing: false })
      return
    }
    try {
      await player.play()
      set({ playing: true })
    } catch (cause) {
      set({ playing: false, error: errorText(cause) })
    }
  },

  stop: async () => {
    const player = activePlayer
    if (!player) return
    try {
      await Promise.resolve(player.stop())
    } finally {
      set({ playing: false })
    }
  },

  seek: (seconds) => {
    void activePlayer?.seek(seconds)
  },

  setPlaying: (playing) => set({ playing }),

  setSource: async (source) => {
    const previous = get().source
    if (source === previous) return
    set({ source, loading: true, error: null })
    const player = activePlayer
    if (!player) {
      set({ loading: false })
      return
    }
    try {
      await player.setSource(source)
      set({ loading: false, duration: player.duration })
    } catch (cause) {
      set({ source: player.currentSource, loading: false, error: errorText(cause) })
    }
  },

  setZoom: (zoom) => set({ zoom }),

  setRate: async (rate) => {
    if (rate === get().rate) return
    set({ rate })
    await activePlayer?.setRate(rate)
  },

  attach: (player) => {
    activePlayer = player
    set({
      ready: true,
      loading: false,
      error: null,
      duration: player.duration,
      source: player.currentSource,
    })
  },

  detach: () => {
    activePlayer = null
    set({ ready: false, playing: false, loading: false, duration: 0 })
  },

  beginLoad: () => set({ loading: true, error: null }),

  endLoad: () => set({ loading: false }),

  fail: (error) => set({ loading: false, ready: false, playing: false, error }),

  reset: () => {
    activePlayer = null
    set({
      source: MASTER_SOURCE,
      playing: false,
      ready: false,
      loading: false,
      error: null,
      duration: 0,
    })
  },
}))
