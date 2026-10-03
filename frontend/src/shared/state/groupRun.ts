/**
 * Состояние «Группового анализа» — режим «Группа (N>2)» (остаток 4.7, Фаза 5).
 *
 * Правило раздела то же, что в паре: правка параметра **ничего не запускает** —
 * агрегат стартует только кнопкой «Считать» в тулс-хедере (`POST
 * /group/aggregate`, синхронный JSON). Сохранение в историю — отдельная кнопка
 * «Сохранить прогон» (`POST /group/analyses`, снимок определения), загрузка
 * истории — `GET /group/analyses/{id}` (свежий пересчёт на сервере).
 *
 * Персистятся только фильтры и подпись (как ярлыки в `groupCompare`):
 * выборка участников, результат и история — состояние сессии (после
 * перезапуска нужно запускать заново).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiErrorText } from '@/shared/api/client'
import type {
  GroupAggregateIn,
  GroupAggregateOut,
  GroupAnalysisSummary,
} from '@/shared/api/types'

/** Режим раздела: сравнение пары (B − A) или групповой срез N>2. */
export type GroupMode = 'pair' | 'group'

/** Дата из формы `YYYY-MM-DD` → ISO-строка для сервера (день целиком). */
function isoDay(date: string, end: boolean): string | null {
  if (!date) return null
  return `${date}T${end ? '23:59:59' : '00:00:00'}`
}

/** Числовой фильтр из текстового поля: пусто/мусор → None. */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

export type GroupRunState = {
  /** Режим раздела: пара живёт в `groupCompare`, группа — здесь. */
  mode: GroupMode
  /** Записи-участники в порядке выбора (колонки тепловой карты; сессия). */
  recordingIds: string[]
  // — фильтры (персистятся) —
  bandKey: string
  gofMin: string
  epochLengthMs: string
  dateFrom: string
  dateTo: string
  names: string
  topN: number
  /** Подпись сохраняемого прогона истории. */
  runName: string
  // — состояние (сессия) —
  aggregate: GroupAggregateOut | null
  loading: boolean
  error: string | null
  saved: GroupAnalysisSummary | null
  /** История прогонов (`GET /group/analyses`), null — ещё не брали. */
  history: GroupAnalysisSummary[] | null
  historyLoading: boolean
  historyError: string | null

  setMode: (mode: GroupMode) => void
  toggleRecording: (recordingId: string) => void
  clearRecordings: () => void
  setBandKey: (bandKey: string) => void
  setGofMin: (value: string) => void
  setEpochLengthMs: (value: string) => void
  setDateFrom: (value: string) => void
  setDateTo: (value: string) => void
  setNames: (value: string) => void
  setTopN: (value: number) => void
  setRunName: (value: string) => void
  reset: () => void
  /** Собрать вход из состояния (фильтры → GroupAggregateIn). */
  buildPayload: () => GroupAggregateIn
  /** `POST /group/aggregate`: живой агрегат кнопкой «Считать». */
  run: () => Promise<void>
  /** `POST /group/analyses`: снимок определения в историю (расчёт не запускает). */
  saveRun: () => Promise<void>
  /** `GET /group/analyses/{id}`: паспорт истории + свежий пересчёт. */
  loadRun: (runId: number) => Promise<void>
  /** `GET /group/analyses`: история прогонов (кнопкой «Обновить»). */
  loadHistory: () => Promise<void>
}

const initialFilters = {
  bandKey: 'alpha',
  gofMin: '',
  epochLengthMs: '',
  dateFrom: '',
  dateTo: '',
  names: '',
  topN: 12,
  runName: '',
}


export const useGroupRun = create<GroupRunState>()(
  persist(
    (set, get) => ({
      mode: 'pair',
      recordingIds: [],
      ...initialFilters,
      aggregate: null,
      loading: false,
      error: null,
      saved: null,
      history: null,
      historyLoading: false,
      historyError: null,

      setMode: (mode) => set({ mode }),
      toggleRecording: (recordingId) =>
        set((state) => ({
          recordingIds: state.recordingIds.includes(recordingId)
            ? state.recordingIds.filter((id) => id !== recordingId)
            : [...state.recordingIds, recordingId],
        })),
      clearRecordings: () => set({ recordingIds: [] }),
      setBandKey: (bandKey) => set({ bandKey }),
      setGofMin: (gofMin) => set({ gofMin }),
      setEpochLengthMs: (epochLengthMs) => set({ epochLengthMs }),
      setDateFrom: (dateFrom) => set({ dateFrom }),
      setDateTo: (dateTo) => set({ dateTo }),
      setNames: (names) => set({ names }),
      setTopN: (topN) => set({ topN }),
      setRunName: (runName) => set({ runName }),
      reset: () => set({ aggregate: null, error: null, saved: null }),

      buildPayload: () => {
        const state = get()
        const names = state.names
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
        return {
          recording_ids: state.recordingIds,
          band_key: state.bandKey,
          gof_min: numberOrNull(state.gofMin),
          epoch_length_ms: numberOrNull(state.epochLengthMs),
          date_from: isoDay(state.dateFrom, false),
          date_to: isoDay(state.dateTo, true),
          names: names.length ? names : null,
          top_n: state.topN,
        } as GroupAggregateIn
      },

      run: async () => {
        set({ loading: true, error: null, saved: null })
        try {
          const aggregate = await api.group.aggregate(get().buildPayload())
          set({ aggregate, loading: false })
        } catch (error) {
          set({ loading: false, error: apiErrorText(error) })
        }
      },

      saveRun: async () => {
        const state = get()
        const payload = { ...state.buildPayload(), name: state.runName || null }
        set({ loading: true, error: null })
        try {
          const saved = await api.group.save(payload)
          set({ saved, loading: false })
          await get().loadHistory()
        } catch (error) {
          set({ loading: false, error: apiErrorText(error) })
        }
      },


      loadRun: async (runId) => {
        set({ loading: true, error: null })
        try {
          const detail = await api.group.run(runId)
          const filters = detail.aggregate.filters
          set({
            aggregate: detail.aggregate,
            saved: detail.run,
            loading: false,
            // Фильтры истории подтягиваем в панель: видно, что именно
            // пересчитывает сервер (свежие числа — серверные, не кэш).
            bandKey: filters.band_key || get().bandKey,
            gofMin: filters.gof_min === null ? '' : String(filters.gof_min),
            epochLengthMs:
              filters.epoch_length_ms === null ? '' : String(filters.epoch_length_ms),
            names: (filters.names ?? []).join(', '),
            topN: filters.top_n,
            recordingIds: detail.aggregate.participants.map((item) => item.recording_id),
          })
        } catch (error) {
          set({ loading: false, error: apiErrorText(error) })
        }
      },

      loadHistory: async () => {
        set({ historyLoading: true, historyError: null })
        try {
          const page = await api.group.runs({ limit: 50 })
          set({ history: page.items ?? [], historyLoading: false })
        } catch (error) {
          set({ historyLoading: false, historyError: apiErrorText(error) })
        }
      },
    }),
    {
      name: 'diplock.group-run',
      // Персистятся только фильтры и подпись: выборка, результат и
      // история — состояние сессии (правило `docs/rules/frontend-state.md`).
      partialize: (state) => ({
        bandKey: state.bandKey,
        gofMin: state.gofMin,
        epochLengthMs: state.epochLengthMs,
        dateFrom: state.dateFrom,
        dateTo: state.dateTo,
        names: state.names,
        topN: state.topN,
        runName: state.runName,
      }),
    },
  ),
)

