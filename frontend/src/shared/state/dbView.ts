/**
 * Параметры раздела «БД»: фильтры/группировка/сортировка и выборка записей.
 *
 * Правило разделов (`docs/rules/frontend-state.md`): правка параметра ничего не
 * запускает — фильтры лишь перечитывают страницу `GET /recordings/readiness`
 * (чтение БД, не расчёт). Персистятся только настройки просмотра (фильтры,
 * группировка, сортировка); выборка записей — состояние сессии (как выборка
 * участников в `groupRun`): после перезагрузки её набирают заново.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DbSortKey } from '@/shared/lib/dbTable'

export type DbViewState = {
  /** Показывать только записи с записанными результатами (фильтр сервера) */
  onlyProcessed: boolean
  /** Поиск по файлу/псевдониму (серверный фильтр, debounce в разделе) */
  search: string
  /** Группировка строк по испытуемому (`patient_alias`) */
  groupByPatient: boolean
  /** Порядок строк (серверная сортировка `GET /recordings/readiness`) */
  sortKey: DbSortKey
  /** Записей на странице (серверная пагинация) */
  pageLimit: number
  /** Смещение страницы (сессия: смена фильтров возвращает на первую страницу) */
  pageOffset: number
  /** Выбранные записи в порядке выбора (A/B пары — первая/вторая) */
  selectedIds: string[]
  /** Раскрытая строка (карточка готовности), `null` — не раскрыта */
  expandedId: string | null

  setOnlyProcessed: (value: boolean) => void
  setSearch: (value: string) => void
  setGroupByPatient: (value: boolean) => void
  setSortKey: (value: DbSortKey) => void
  setPageLimit: (value: number) => void
  setPageOffset: (value: number) => void
  toggleSelected: (recordingId: string) => void
  selectMany: (recordingIds: string[]) => void
  clearSelection: () => void
  toggleExpanded: (recordingId: string) => void
}

export const useDbView = create<DbViewState>()(
  persist(
    (set) => ({
      onlyProcessed: true,
      search: '',
      groupByPatient: true,
      sortKey: 'created',
      pageLimit: 50,
      pageOffset: 0,
      selectedIds: [],
      expandedId: null,

      // Смена фильтра/сортировки возвращает на первую страницу: смещение
      // прежней выборки про новому набору бессмысленно (и «total» другой).
      setOnlyProcessed: (value) => set({ onlyProcessed: value, pageOffset: 0 }),
      setSearch: (value) => set({ search: value, pageOffset: 0 }),
      setGroupByPatient: (value) => set({ groupByPatient: value }),
      setSortKey: (value) => set({ sortKey: value, pageOffset: 0 }),
      setPageLimit: (value) => set({ pageLimit: value, pageOffset: 0 }),
      setPageOffset: (value) => set({ pageOffset: Math.max(0, value) }),

      toggleSelected: (recordingId) =>
        set((state) => ({
          selectedIds: state.selectedIds.includes(recordingId)
            ? state.selectedIds.filter((id) => id !== recordingId)
            : [...state.selectedIds, recordingId],
        })),
      selectMany: (recordingIds) =>
        set((state) => ({
          selectedIds: [
            ...state.selectedIds,
            ...recordingIds.filter((id) => !state.selectedIds.includes(id)),
          ],
        })),
      clearSelection: () => set({ selectedIds: [] }),
      toggleExpanded: (recordingId) =>
        set((state) => ({
          expandedId: state.expandedId === recordingId ? null : recordingId,
        })),
    }),
    {
      name: 'diplock.db',
      // Выборка записей и раскрытая строка — состояние сессии: выбор относится
      // к текущей задаче (пара/группа), а не к настройкам просмотра.
      partialize: (state) => ({
        onlyProcessed: state.onlyProcessed,
        groupByPatient: state.groupByPatient,
        sortKey: state.sortKey,
        pageLimit: state.pageLimit,
      }),
    },
  ),
)