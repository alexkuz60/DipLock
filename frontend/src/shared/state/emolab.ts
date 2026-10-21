/**
 * Состояние раздела «ЕмоЛаб» (шаг 1): внешний аудиотрек, его анализ
 * (ФФТ-кадры «Эмо» + карты темпа/аккордов VAMP) и blob-URL для плеера.
 *
 * Раздел разложен на компоненты каркаса (как «Нейромузыка»): кнопка
 * «Открыть аудио» и транспорт — тулс-хедер (`emolab/EmoLabToolActions`),
 * паспорт трека и параметры анализа — панель опций (`emolab/EmoLabPanel`),
 * трекер и звезда-полигон — рабочая область (`emolab/EmoLabSection`),
 * поэтому общее состояние живёт здесь.
 *
 * Файл пользователя **не уходит на сервер для воспроизведения**: плеер играет
 * из `blob:` URL локального `File`, на сервер уходит копия для анализа
 * (sha256 = `trackId`, дисковый кэш — повторное открытие мгновенно).
 * Поллинг — свой цикл (у анализа контракт running/succeeded/failed без
 * job_id, как у рендера «Нейромузыки»), переживает уход из раздела;
 * персиста нет: результат живёт на сервере, а `File` — в памяти страницы.
 */
import { create } from 'zustand'
import { api, ApiError } from '@/shared/api/client'
import type { AudioEmo, EmoTrackStatus } from '@/shared/api/types'
import { createRunToken, JOB_POLL_MS } from '@/shared/lib/jobPolling'

/** Токен запуска: новый трек или сброс делают поллинг прежнего цикла чужим. */
const analysisToken = createRunToken()

/**
 * Таб секции «Визуализация» (шаг 4, «Эмограмма»): графики разделены по табам,
 * чтобы звезда-полигон не мельчал под вторым графиком; позже тут же появятся
 * новые аналитические графики.
 */
export type EmoVizTab = 'star' | 'emogram'

/**
 * Динамический диапазон шкалы лучей звезды по умолчанию, дБ — окно
 * `[−60 … 0]` совпадает со шкалой контракта (`db_floor` кадров «Эмо»).
 */
export const EMO_DB_RANGE_DEFAULT = 60

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Неизвестная ошибка'
}

/** Пауза между опросами статуса — тот же ритм, что `JOB_POLL_MS` у задач. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export type EmoLabState = {
  /** Имя открытого файла (как выбрал пользователь) */
  filename: string | null
  /** Длительность трека, с (из ответа POST — заголовок файла) */
  durationSec: number | null
  /** Идентификатор трека на сервере (sha256 содержимого, хвост 32) */
  trackId: string | null
  /** Статус анализа: шаг, проценты, ошибка (поллинг) */
  status: EmoTrackStatus | null
  /** POST ушёл или поллинг ещё идёт */
  busy: boolean
  /** true — результат взят из дискового кэша сервера (расчёт не запускался) */
  cached: boolean
  /** Текст ошибки загрузки/анализа (для UI) */
  error: string | null
  /** Кадры «Эмо» + карты темпа/аккордов — база звезды-полигона */
  emo: AudioEmo | null
  /** `blob:` URL выбранного файла — плеер играет локально, без сервера */
  audioUrl: string | null
  /**
   * Динамический диапазон шкалы лучей звезды, дБ: окно `[−dbRangeDb … 0]` →
   * `[0 … 100]` % R (отображение, анализ не пересчитывается)
   */
  dbRangeDb: number
  /** Значения темпа участвуют в расчёте лучей звезды (темп-коррекция) */
  tempoRays: boolean
  /** Активный таб секции «Визуализация» (звезда / «Эмограмма» / дальше) */
  vizTab: EmoVizTab

  /** Открыть внешний аудиотрек (wav/mp3): запуск анализа на сервере */
  openFile: (file: File) => Promise<void>
  /** Смена динамического диапазона шкалы лучей («Опции раздела») */
  setDbRangeDb: (value: number) => void
  /** Вкл/выкл значений темпа при расчёте лучей звезды («Опции раздела») */
  setTempoRays: (value: boolean) => void
  /** Смена таба секции «Визуализация» */
  setVizTab: (value: EmoVizTab) => void
  /** Сброс раздела (смена трека/уход): отмена поллинга, освобождение blob */
  reset: () => void
}

export const useEmoLab = create<EmoLabState>()((set, get) => ({
  filename: null,
  durationSec: null,
  trackId: null,
  status: null,
  busy: false,
  cached: false,
  error: null,
  emo: null,
  audioUrl: null,
  dbRangeDb: EMO_DB_RANGE_DEFAULT,
  tempoRays: true,
  vizTab: 'star',

  setDbRangeDb: (value) => {
    set({ dbRangeDb: Number.isFinite(value) && value > 0 ? value : EMO_DB_RANGE_DEFAULT })
  },

  setTempoRays: (value) => {
    set({ tempoRays: Boolean(value) })
  },

  setVizTab: (value) => {
    set({ vizTab: value === 'emogram' ? 'emogram' : 'star' })
  },

  openFile: async (file) => {
    const token = analysisToken.next()
    const isCurrent = () => analysisToken.isCurrent(token)
    const previousUrl = get().audioUrl
    const audioUrl = URL.createObjectURL(file)
    set({
      filename: file.name,
      durationSec: null,
      trackId: null,
      status: null,
      busy: true,
      cached: false,
      error: null,
      emo: null,
      audioUrl,
    })
    if (previousUrl) URL.revokeObjectURL(previousUrl)
    try {
      const started = await api.emolabAnalyze(file)
      if (!isCurrent()) return
      set({
        trackId: started.track_id,
        cached: started.cached,
        durationSec: started.duration_s,
      })
      // Поллинг до терминального статуса (контракт running/succeeded/failed);
      // cached=true — первый же опрос вернёт succeeded («Из дискового кэша»).
      for (;;) {
        const next = await api.emolabTrackStatus(started.track_id)
        if (!isCurrent()) return
        set({ status: next })
        if (next.status === 'running') {
          await delay(JOB_POLL_MS)
          if (!isCurrent()) return
          continue
        }
        if (next.status === 'failed') {
          set({ busy: false, error: next.error ?? 'Анализ не удался' })
          return
        }
        const emo = await api.emolabTrackEmo(started.track_id)
        if (!isCurrent()) return
        set({ emo, busy: false })
        return
      }
    } catch (cause) {
      if (!isCurrent()) return
      set({ busy: false, error: errorText(cause) })
    }
  },

  reset: () => {
    analysisToken.cancel()
    const { audioUrl } = get()
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    set({
      filename: null,
      durationSec: null,
      trackId: null,
      status: null,
      busy: false,
      cached: false,
      error: null,
      emo: null,
      audioUrl: null,
      dbRangeDb: EMO_DB_RANGE_DEFAULT,
      tempoRays: true,
      vizTab: 'star',
    })
  },
}))