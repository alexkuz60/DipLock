/**
 * Панель «Опции» раздела «БД»: фильтры, группировка/сортировка, выборка.
 *
 * Панель, как и в остальных разделах, **ничего не запускает**: правка фильтра
 * лишь перечитывает страницу `GET /recordings/readiness` (чтение БД, не
 * расчёт). Фильтр «только обработанные» идёт на сервер (шаблон D
 * `docs/rules/results-db.md`), поиск — мгновенный, на клиенте; выборка
 * записей передаётся в пару/группу кнопками тулс-хедера.
 */
import { DB_SORT_LABELS, type DbSortKey } from '@/shared/lib/dbTable'
import { useDbView } from '@/shared/state/dbView'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'

/** Размеры страницы таблицы (серверная пагинация `GET /recordings/readiness`). */
export const DB_PAGE_SIZES = [50, 100, 200, 500] as const

export function DbPanel() {
  const onlyProcessed = useDbView((state) => state.onlyProcessed)
  const setOnlyProcessed = useDbView((state) => state.setOnlyProcessed)
  const search = useDbView((state) => state.search)
  const setSearch = useDbView((state) => state.setSearch)
  const groupByPatient = useDbView((state) => state.groupByPatient)
  const setGroupByPatient = useDbView((state) => state.setGroupByPatient)
  const sortKey = useDbView((state) => state.sortKey)
  const setSortKey = useDbView((state) => state.setSortKey)
  const pageLimit = useDbView((state) => state.pageLimit)
  const setPageLimit = useDbView((state) => state.setPageLimit)
  const selectedIds = useDbView((state) => state.selectedIds)
  const clearSelection = useDbView((state) => state.clearSelection)

  return (
    <>
      <Panel
        title="Фильтры"
        hint="«Только обработанные» — записи, у которых в БД есть хотя бы один результат (препроцессинг, диполи, пакет, отчёт). Поиск идёт на сервер по файлу и псевдониму (с задержкой 300 мс)."
      >
        <CheckboxRow
          label="Только обработанные"
          checked={onlyProcessed}
          onChange={setOnlyProcessed}
        />
        <TextField
          label="Поиск"
          value={search}
          onChange={setSearch}
          placeholder="файл, псевдоним"
        />
      </Panel>

      <Panel
        title="Группировка, сортировка, страница"
        hint="Группировка по испытуемому (patient_alias): у одного человека в работе обычно 5–10 файлов — они читаются одной группой с кнопкой «Выбрать группу». Сортировка и пагинация — серверные: смена фильтра/порядка возвращает на первую страницу."
      >
        <SegmentedControl
          label="Группировка"
          value={groupByPatient ? 'patient' : 'flat'}
          options={[
            { value: 'patient', label: 'По испытуемому' },
            { value: 'flat', label: 'Плоский список' },
          ]}
          onChange={(value) => setGroupByPatient(value === 'patient')}
        />
        <SelectField
          label="Сортировка"
          value={sortKey}
          options={(Object.keys(DB_SORT_LABELS) as DbSortKey[]).map((key) => ({
            value: key,
            label: DB_SORT_LABELS[key],
          }))}
          onChange={setSortKey}
        />
        <SelectField
          label="Записей на странице"
          value={String(pageLimit)}
          options={DB_PAGE_SIZES.map((size) => ({
            value: String(size),
            label: String(size),
          }))}
          onChange={(value) => setPageLimit(Number(value))}
        />
      </Panel>

      <Panel
        title="Выборка"
        hint="Выбранные записи (чекбоксы строк) передаются в раздел «Групповой анализ»: кнопки «В пару (A/B)» и «В группу (N>2)» — в тулс-хедере."
      >
        <p className="text-sm text-fg-1">{`Выбрано записей: ${selectedIds.length}`}</p>
        <Button disabled={selectedIds.length === 0} onClick={clearSelection}>
          Снять выделение
        </Button>
      </Panel>

      <Panel title="Справка" hint="Что показывает раздел и как читать готовность.">
        <p className="text-sm text-fg-2">
          Готовность — «k из N» стадий с записанными в БД результатами: препроцессинг/эпохи,
          диполи, полосы пакета, отчёт, спектрограмма. Параметры — последнего прогона каждой
          стадии (история — в карточке строки). «—» — «не измерено», а не 0. Раздел ничего не
          пересчитывает: пересчёт — кнопками разделов EDF/«Диполи»/«Итоги».
        </p>
      </Panel>
    </>
  )
}