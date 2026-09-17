/**
 * Панель опций раздела «Таблица локализации» (срез 4): порядок строк и состав
 * колонок.
 *
 * Панель, как и в остальных разделах, **ничего не запускает и не запрашивает**:
 * это настройки представления уже полученного результата (zustand `tableParams`),
 * поэтому здесь нет ни кнопки расчёта, ни `useQuery`. Результат показывается
 * справкой: сколько строк, есть ли точки без MNI, актуален ли он относительно
 * текущих параметров расчёта из раздела «Диполи».
 *
 * Фильтры (GOF, амплитуда, BA), экспорт выборки и переход к диполю кликом по
 * строке — следующий срез (`docs/ui.md` §3.4), и панель говорит об этом прямо,
 * чтобы отсутствие контролов не читалось как «их забыли».
 */
import { RotateCcw } from 'lucide-react'
import {
  TABLE_COLUMNS,
  hiddenColumnCount,
  sortDirectionLabel,
  tableRows,
} from '@/shared/lib/tableRows'
import { resultMatchesParams } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { TABLE_SORT_OPTIONS, useTableParams } from '@/shared/state/tableParams'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { StatusPill } from '@/shared/ui/StatusPill'

export function LocalizationTablePanel() {
  const sortDirection = useTableParams((state) => state.params.sortDirection)
  const columnVisibility = useTableParams((state) => state.params.columnVisibility)
  const setSortDirection = useTableParams((state) => state.setSortDirection)
  const setColumnVisible = useTableParams((state) => state.setColumnVisible)
  const showAllColumns = useTableParams((state) => state.showAllColumns)

  const recording = useEdfRecording((state) => state.recording)
  const result = useDipoleCalc((state) => state.result)
  const calcParams = useDipoleCalc((state) => state.params)

  const rows = result ? tableRows(result, sortDirection) : []
  const hidden = hiddenColumnCount(columnVisibility)
  const stale = result !== null && !resultMatchesParams(result, calcParams)

  return (
    <>
      <Panel
        title="Сортировка"
        hint="Пока единственный ключ — номер эпохи: строки идут по порядку нарезки, направление переключается здесь. Сортировка по MNI, амплитуде и GOF появится вместе с фильтрами."
      >
        <SegmentedControl
          label="Порядок эпох"
          value={sortDirection}
          options={TABLE_SORT_OPTIONS}
          onChange={setSortDirection}
          hint={`Сейчас: ${sortDirectionLabel(sortDirection)}`}
        />
      </Panel>

      <Panel
        title="Колонки"
        hint={
          hidden > 0
            ? `Скрыто колонок: ${hidden}. Данные в результате остаются — скрытие меняет только показ.`
            : 'Показаны все колонки результата.'
        }
      >
        {TABLE_COLUMNS.map((column) => (
          <CheckboxRow
            key={column.key}
            label={column.label}
            hint={column.hint}
            checked={columnVisibility[column.key] !== false}
            onChange={(checked) => setColumnVisible(column.key, checked)}
          />
        ))}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            icon={<RotateCcw className="size-4" />}
            disabled={hidden === 0}
            onClick={showAllColumns}
            title="Показать все колонки результата"
          >
            Показать все
          </Button>
        </div>
      </Panel>

      <Panel
        title="Результат расчёта"
        hint="Таблица читает результат задачи раздела «Диполи» — здесь он показан справкой. Фильтры по GOF/амплитуде/BA, экспорт выборки и сохранение в БД — следующий срез."
      >
        <div className="mb-2 flex flex-wrap gap-2">
          <StatusPill tone={recording ? 'ok' : 'neutral'}>
            {recording ? `Запись: ${recording.filename}` : 'Запись не загружена'}
          </StatusPill>
          <StatusPill tone={result ? 'accent' : 'neutral'}>
            {result ? `Строк: ${rows.length}` : 'Результата нет'}
          </StatusPill>
          {result && stale ? (
            <StatusPill tone="warn">Параметры расчёта изменены — нужен пересчёт</StatusPill>
          ) : null}
        </div>
        {result ? (
          <ul className="space-y-1 text-sm text-fg-2">
            <li>{`Метод: ${result.method}, сетка ${result.grid_mm} мм`}</li>
            <li>{`Эпох в расчёте: ${result.n_epochs_used} из ${result.n_epochs_total}`}</li>
            <li>{`Порог reject: ${result.reject_threshold_uv} мкВ`}</li>
            <li>
              {result.filter_band_hz
                ? `Полоса: ${result.filter_band_hz[0]}–${result.filter_band_hz[1]} Гц`
                : 'Полоса: без фильтра'}
            </li>
            <li>{`Время расчёта: ${result.duration_sec_calc.toFixed(1)} с`}</li>
          </ul>
        ) : (
          <p className="text-sm text-fg-2">
            Результат появится после расчёта в разделе «Диполи»: таблица не запускает задачи сама.
          </p>
        )}
      </Panel>
    </>
  )
}