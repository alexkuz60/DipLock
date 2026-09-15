/**
 * Параметры таблицы локализации (срез 4): порядок строк и видимые колонки.
 *
 * Живут в zustand-срезе, а не в компоненте, потому что настраиваются в правой
 * панели, а рисуются в рабочей области. Правка параметра, как и в остальных
 * разделах (`docs/ui.md`), **ничего не запускает и не запрашивает**: таблица
 * читает уже полученный результат задачи, сортировка и видимость колонок —
 * чистая перерисовка (`shared/lib/tableRows.ts`).
 *
 * Персистится только это: результат расчёта относится к конкретной записи и
 * после перезагрузки страницы бессмыслен (файл живёт по TTL) — как в
 * `dipoleCalc`. Фильтры и сохранение выборки в БД — следующий срез; здесь
 * ровно то, что просил срез: сортировка по номеру эпохи и состав колонок.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  defaultColumnVisibility,
  type TableColumnKey,
  type TableColumnVisibility,
  type TableSortDirection,
} from '@/shared/lib/tableRows'

/** Варианты сортировки панели: пока единственный ключ — номер эпохи. */
export const TABLE_SORT_OPTIONS: { value: TableSortDirection; label: string; title: string }[] = [
  {
    value: 'asc',
    label: 'Эпоха ↑',
    title: 'Сначала ранние эпохи: сортировка по возрастанию номера',
  },
  {
    value: 'desc',
    label: 'Эпоха ↓',
    title: 'Сначала поздние эпохи: сортировка по убыванию номера',
  },
]

export type TableParams = {
  sortDirection: TableSortDirection
  columnVisibility: TableColumnVisibility
}

export const TABLE_PARAM_DEFAULTS: TableParams = {
  sortDirection: 'asc',
  columnVisibility: defaultColumnVisibility(),
}

export type TableParamsState = {
  params: TableParams
  setSortDirection: (direction: TableSortDirection) => void
  setColumnVisible: (key: TableColumnKey, visible: boolean) => void
  /** Показать все колонки (быстрый возврат после скрытия) */
  showAllColumns: () => void
  /** Вернуть параметры по умолчанию (сортировка и все колонки) */
  reset: () => void
}

export const useTableParams = create<TableParamsState>()(
  persist(
    (set) => ({
      params: { ...TABLE_PARAM_DEFAULTS, columnVisibility: defaultColumnVisibility() },

      setSortDirection: (sortDirection) =>
        set((state) => ({ params: { ...state.params, sortDirection } })),

      setColumnVisible: (key, visible) =>
        set((state) => ({
          params: {
            ...state.params,
            columnVisibility: { ...state.params.columnVisibility, [key]: visible },
          },
        })),

      showAllColumns: () =>
        set((state) => ({ params: { ...state.params, columnVisibility: defaultColumnVisibility() } })),

      reset: () =>
        set({ params: { ...TABLE_PARAM_DEFAULTS, columnVisibility: defaultColumnVisibility() } }),
    }),
    {
      name: 'diplock.table',
      // Порядок строк и состав колонок — настройки просмотра: их переживает
      // перезагрузка страницы, а результат задачи — нет (он в `dipoleCalc`).
      partialize: (state) => ({ params: state.params }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as { params?: Partial<TableParams> }
        const storedParams = stored.params ?? {}
        return {
          ...current,
          params: {
            ...current.params,
            ...storedParams,
            // Частично сохранённый набор колонок добирается значениями по умолчанию,
            // иначе колонка, добавленная новой версией, оказалась бы скрытой
            columnVisibility: {
              ...current.params.columnVisibility,
              ...(storedParams.columnVisibility ?? {}),
            },
          },
        }
      },
    },
  ),
)