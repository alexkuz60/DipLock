/**
 * Раздел «Таблица локализации» (срез 4): все точки расчёта диполей текущей записи.
 *
 * Раздел — представление результата: сам он ничего не считает, а единственный
 * запрос идёт по **явной кнопке** строки — «Уточнить…» (F19: точный BEM-фитинг
 * одной эпохи, параметры нарезки берутся из результата, а не из формы панели).
 * Что показать, решает состояние двух срезов:
 *
 * * `edfRecording` — загружена ли запись (без неё результата быть не может);
 * * `dipoleCalc` — результат задачи расчёта, её прогресс/ошибка и **правки
 *   параметров**: если параметры изменили после расчёта, таблица об этом
 *   предупреждает (отпечаток `resultMatchesParams`), а не выдаёт старые числа за
 *   посчитанные на новых настройках.
 *
 * Что важно в самой выдаче:
 *
 * * строки — **все точки результата** (включая те, что без MNI, — координаты у
 *   них «—»), сортировка — по номеру эпохи (параметр панели);
 * * порог «КД ≥ X нАм» из раздела «Диполи» — параметр **отображения проекций**:
 *   в таблице он ничего не скрывает, и это сказано подписью, иначе «в таблице
 *   4 точки, на проекциях 2» выглядело бы ошибкой;
 * * результат принадлежит записи: при загрузке новой или закрытии записи он
 *   сбрасывается вместе с расчётом (`edfRecording` → `dipoleCalc.reset()`).
 */
import { useCallback, useMemo } from 'react'
import { Table2 } from 'lucide-react'
import {
  hiddenColumnCount,
  missingMniCount,
  sortDirectionLabel,
  tableRows,
  visibleColumns,
} from '@/shared/lib/tableRows'
import { calcJobSummary, refinedSummary, refineTooltip, resultMatchesParams } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useTableParams } from '@/shared/state/tableParams'
import { filterBandText } from '@/shared/lib/calcFilter'
import { Placeholder } from '@/shared/ui/Placeholder'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Button } from '@/shared/ui/Button'
import { LocalizationTable } from './LocalizationTable'

export function LocalizationTableSection() {
  const recording = useEdfRecording((state) => state.recording)

  const result = useDipoleCalc((state) => state.result)
  const job = useDipoleCalc((state) => state.job)
  const error = useDipoleCalc((state) => state.error)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const calcParams = useDipoleCalc((state) => state.params)
  const refineJob = useDipoleCalc((state) => state.refineJob)
  const refiningEpoch = useDipoleCalc((state) => state.refiningEpoch)
  const refinedPoints = useDipoleCalc((state) => state.refinedPoints)
  const refineError = useDipoleCalc((state) => state.refineError)
  const refineEpoch = useDipoleCalc((state) => state.refineEpoch)
  const selectedPointId = useDipoleCalc((state) => state.selectedPointId)
  const toggleSelectedPoint = useDipoleCalc((state) => state.toggleSelectedPoint)

  const sortDirection = useTableParams((state) => state.params.sortDirection)
  const columnVisibility = useTableParams((state) => state.params.columnVisibility)

  // Строки — чистая функция от результата и настроек таблицы: ни запросов, ни
  // мутаций состояния, правка сортировки/колонок просто перерисовывает таблицу.
  const rows = useMemo(
    () => (result ? tableRows(result, sortDirection) : []),
    [result, sortDirection],
  )
  const columns = useMemo(() => visibleColumns(columnVisibility), [columnVisibility])
  const missingMni = missingMniCount(rows)
  const hiddenColumns = hiddenColumnCount(columnVisibility)
  const stale = result !== null && !resultMatchesParams(result, calcParams)

  // Ячейка «Уточнение»: «Уточнить…» → «Уточняю…» → «стало» (BEM GOF + сдвиг).
  // Строка результата не переписывается: уточнение — добавка, а не подмена чисел.
  const renderRowAction = useCallback(
    (row: (typeof rows)[number]) => {
      const refined = refinedPoints[row.epochIndex]
      if (refined) {
        return (
          <span
            className="tnum text-accent"
            title={refineTooltip(refined)}
            data-testid={`refined-${row.epochIndex}`}
          >
            {refinedSummary(refined)}
          </span>
        )
      }
      if (refiningEpoch === row.epochIndex && refineJob?.status === 'running') {
        return <span className="text-fg-2">Уточняю…</span>
      }
      return (
        <Button
          variant="ghost"
          disabled={refineJob?.status === 'running'}
          title={
            'Точный фитинг этой эпохи на BEM fsaverage (окно пика GFP, ~десятки секунд). ' +
            'Нарезка повторяет быстрый расчёт; строка результата не переписывается'
          }
          onClick={() => void refineEpoch(recording?.recording_id ?? null, row.epochIndex)}
        >
          Уточнить…
        </Button>
      )
    },
    [refinedPoints, refiningEpoch, refineJob, refineEpoch, recording],
  )

  if (recording === null) {
    return (
      <Placeholder
        icon={<Table2 className="size-12" />}
        title="Таблица локализации"
        description="Таблица показывает точки расчёта текущей записи: номер эпохи, время пика GFP, координаты MNI, амплитуду момента, GOF и поле Бродмана. Запись ещё не загружена."
      >
        <StatusPill tone="neutral">
          Загрузите EDF в разделе «EDF» (2) и запустите расчёт в разделе «Диполи» (3)
        </StatusPill>
        {error ? <StatusPill tone="danger">{`Ошибка расчёта: ${error}`}</StatusPill> : null}
      </Placeholder>
    )
  }

  if (result === null) {
    return (
      <Placeholder
        icon={<Table2 className="size-12" />}
        title="Расчёт диполей не выполнен"
        description={`Запись «${recording.filename}» загружена, но результата задачи нет: таблица строится только из результата расчёта и сама его не запускает.`}
      >
        {job?.status === 'running' ? (
          <StatusPill tone="accent">{`Расчёт выполняется: ${calcJobSummary(job)}`}</StatusPill>
        ) : null}
        {error ? <StatusPill tone="danger">{`Ошибка расчёта: ${error}`}</StatusPill> : null}
        <StatusPill tone="neutral">
          Кнопка «Рассчитать диполи» — в шапке раздела «Диполи» (3)
        </StatusPill>
      </Placeholder>
    )
  }

  if (rows.length === 0) {
    return (
      <Placeholder
        icon={<Table2 className="size-12" />}
        title="В результате расчёта нет точек"
        description={`Эпох прошло reject-фильтр: ${result.n_epochs_used} из ${result.n_epochs_total} при пороге ${result.reject_threshold_uv} мкВ. Таблица пуста, потому что расчёт не дал ни одной точки, а не потому что результат потерян.`}
      >
        <StatusPill tone="warn">
          Смягчите порог reject в панели раздела «Диполи» и пересчитайте
        </StatusPill>
        {result.warnings.map((warning) => (
          <StatusPill key={warning} tone="warn">
            {warning}
          </StatusPill>
        ))}
      </Placeholder>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={stale ? 'warn' : 'ok'}>
          {stale
            ? 'Параметры расчёта изменены — результат не пересчитан'
            : `Строк: ${rows.length} · расчёт актуален`}
        </StatusPill>
        <StatusPill tone="accent" title={`Метод расчёта: ${result.method}`}>
          {`Быстрый режим, сетка ${result.grid_mm} мм`}
        </StatusPill>
        <StatusPill tone="neutral">{`Сортировка: ${sortDirectionLabel(sortDirection)}`}</StatusPill>
        <StatusPill tone="neutral">
          {`Эпох в расчёте: ${result.n_epochs_used} из ${result.n_epochs_total} · reject ${result.reject_threshold_uv} мкВ`}
        </StatusPill>
        <StatusPill tone="neutral">
          {`Полоса: ${filterBandText(result.filter_band_hz)}${result.notch_hz ? ` · notch ${result.notch_hz} Гц` : ''}`}
        </StatusPill>
        {hiddenColumns > 0 ? (
          <StatusPill tone="neutral">{`Скрыто колонок: ${hiddenColumns}`}</StatusPill>
        ) : null}
        {missingMni > 0 ? (
          <StatusPill tone="warn">
            {`Точек без MNI: ${missingMni} — координаты «—» (на проекции не наводятся)`}
          </StatusPill>
        ) : null}
        {threshold > 0 ? (
          <StatusPill tone="neutral">
            {`Порог «КД ≥ ${threshold} нАм» — только на проекциях: в таблице все точки`}
          </StatusPill>
        ) : null}
      </div>

      {refineError ? (
        <StatusPill tone="danger">{`Ошибка уточнения: ${refineError}`}</StatusPill>
      ) : null}
      <LocalizationTable
        rows={rows}
        columns={columns}
        renderRowAction={renderRowAction}
        selectedRowId={selectedPointId}
        onRowClick={(row) => toggleSelectedPoint(row.id)}
      />

      <p className="text-sm text-fg-2">
        Таблица читает результат задачи раздела «Диполи» и ничего не запрашивает: расчёт запускается
        только кнопкой в шапке того раздела. Порядок строк задаёт панель справа (пока единственный
        ключ — номер эпохи). Фильтры, переход к диполю по клику и сохранение выборки в БД —
        следующий срез: сейчас показаны все точки результата, включая те, что без MNI.
      </p>

      {result.warnings.length ? (
        <ul className="list-inside list-disc text-sm text-warn">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
