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
  filtersActive,
  filtersSummary,
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
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { StatusPill } from '@/shared/ui/StatusPill'

export function LocalizationTablePanel() {
  const sortDirection = useTableParams((state) => state.params.sortDirection)
  const columnVisibility = useTableParams((state) => state.params.columnVisibility)
  const setSortDirection = useTableParams((state) => state.setSortDirection)
  const setColumnVisible = useTableParams((state) => state.setColumnVisible)
  const showAllColumns = useTableParams((state) => state.showAllColumns)
  const filters = useTableParams((state) => state.params.filters)
  const setMinGofPct = useTableParams((state) => state.setMinGofPct)
  const setMaxRivPct = useTableParams((state) => state.setMaxRivPct)

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
        hint="Единственный ключ — номер эпохи (требование задачи): строки идут по порядку нарезки, направление переключается здесь."
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
        title="Фильтр доверия (GOF/RIV)"
        hint="Пороги скрывают строки, но не удаляют их из результата. GOF между полосами не сравним (узкая полоса завышает R²) — кросс-полосной фильтр доверия это RIV (2.6/N23)."
      >
        <CheckboxRow
          label="Фильтровать по GOF снизу"
          hint="Показать только строки с GOF не ниже порога"
          checked={filters.minGofPct !== null}
          onChange={(checked) => setMinGofPct(checked ? (filters.minGofPct ?? 80) : null)}
        />
        <NumberField
          label="Минимальный GOF"
          value={filters.minGofPct ?? 80}
          onChange={setMinGofPct}
          min={0}
          max={100}
          step={1}
          unit="%"
          disabled={filters.minGofPct === null}
          hint="Нижний порог GOF, %"
        />
        <CheckboxRow
          label="Фильтровать по RIV сверху"
          hint="Показать только строки с RIV не выше порога (сравним между полосами)"
          checked={filters.maxRivPct !== null}
          onChange={(checked) => setMaxRivPct(checked ? (filters.maxRivPct ?? 10) : null)}
        />
        <NumberField
          label="Максимальный RIV"
          value={filters.maxRivPct ?? 10}
          onChange={setMaxRivPct}
          min={0}
          max={100}
          step={1}
          unit="%"
          disabled={filters.maxRivPct === null}
          hint="Верхний порог RIV, %: меньше — лучше"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusPill tone={filtersActive(filters) ? 'accent' : 'neutral'}>
            {filtersSummary(filters)}
          </StatusPill>
          <Button
            icon={<RotateCcw className="size-4" />}
            disabled={!filtersActive(filters)}
            onClick={() => {
              setMinGofPct(null)
              setMaxRivPct(null)
            }}
            title="Снять оба порога: показать все строки результата"
          >
            Снять пороги
          </Button>
        </div>
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
        hint="Таблица читает результат задачи раздела «Диполи» — здесь он показан справкой. Фильтры по амплитуде/BA, экспорт выборки и сохранение в БД — следующий срез."
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