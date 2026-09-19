/**
 * Таблица локализации (срез 4): семантическая `<table>` со «липкой» шапкой.
 *
 * Почему `<table>`, а не набор div'ов: это таблица данных — со скринридером,
 * навигацией и заголовками колонок (`scope="col"`). Виртуализация (TanStack
 * Virtual) и фильтры — отдельный срез: строк в быстром режиме ровно столько,
 * сколько эпох прошло reject-фильтр (десятки), и виртуализировать пока нечего.
 *
 * Компонент **только рисует**: строки и колонки приходят готовыми (итог
 * `shared/lib/tableRows.ts`), цвета — токенами темы, числа — классом `tnum`,
 * чтобы колонки не «плясали» при пересчёте.
 */
import type { ReactNode } from 'react'
import type { LocalizationRow, TableColumn } from '@/shared/lib/tableRows'
import { cellText, rowTooltip } from '@/shared/lib/tableRows'
import { cx } from '@/shared/ui/cx'

export type LocalizationTableProps = {
  rows: LocalizationRow[]
  columns: TableColumn[]
  /**
   * Действие строки (кнопка «Уточнить…», F19): рисуется последней колонкой.
   * Рендер приходит снаружи — таблица остаётся «только рисующей», запросы и
   * состояние задачи живут в разделе.
   */
  renderRowAction?: (row: LocalizationRow) => ReactNode
}

export function LocalizationTable({ rows, columns, renderRowAction }: LocalizationTableProps) {
  return (
    <div
      data-testid="localization-table-scroll"
      className="scroll-y-always min-h-0 flex-1 overflow-x-auto rounded-lg border border-border bg-bg-1"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Точки диполей текущей записи: эпоха, время пика GFP, координаты MNI, полушарие,
          структура атласа, амплитуда момента, GOF и поле Бродмана. Порядок строк — по номеру
          эпохи.
        </caption>
        <thead className="sticky top-0 z-10 bg-bg-2">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-testid={`loc-col-${column.key}`}
                title={column.hint}
                className={cx(
                  'border-b border-border px-3 py-2 font-semibold whitespace-nowrap text-fg-2',
                  column.numeric ? 'text-right' : 'text-left',
                  column.width,
                )}
              >
                {column.label}
              </th>
            ))}
            {renderRowAction ? (
              <th
                scope="col"
                className="border-b border-border px-3 py-2 text-left font-semibold whitespace-nowrap text-fg-2"
              >
                Уточнение
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid={`loc-row-${row.id}`}
              title={rowTooltip(row)}
              className="border-b border-border/60 last:border-0 hover:bg-bg-2"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-testid={`loc-cell-${column.key}-${row.id}`}
                  className={cx(
                    'px-3 py-1.5 text-fg-1',
                    column.numeric && 'tnum text-right',
                    column.key === 'area' && 'font-mono',
                  )}
                >
                  {cellText(row, column.key)}
                </td>
              ))}
              {renderRowAction ? (
                <td
                  data-testid={`loc-action-${row.id}`}
                  className="px-3 py-1.5 whitespace-nowrap text-fg-1"
                >
                  {renderRowAction(row)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}