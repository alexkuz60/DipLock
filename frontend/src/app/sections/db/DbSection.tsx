/**
 * Раздел «БД — записи и результаты»: таблица всех записей со степенью
 * готовности записанных в БД результатов расчётов.
 *
 * Раздел — визуальный контроль обработанных ЭЭГ-записей: по каждой записи
 * видно, какие стадии посчитаны и **с какими параметрами** (чистка, нарезка
 * эпох, полосы, диполи, отчёт), — и ничего не пересчитывает: единственные
 * запросы — чтение `GET /recordings/readiness` (страница) и
 * `GET /recordings/{id}/readiness` (карточка по раскрытию строки). Правило
 * «UI не запускает обработку» соблюдается по определению.
 *
 * Что важно в выдаче:
 *
 * * группировка по испытуемому (`patient_alias`): у одного человека в работе
 *   обычно 5–10 файлов — они читаются одной группой с кнопкой «выбрать группу»;
 * * мультивыбор строк — вход выборки для пары/группы раздела «Групповой
 *   анализ» (кнопки тулс-хедера «В пару (A/B)» / «В группу (N>2)»);
 * * «степень готовности» — «k из N» стадий: `None` контракта показывается
 *   прочерком «—» («не измерено», а не 0) — инвариант read-API.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Database, Download, ExternalLink } from 'lucide-react'
import { api } from '@/shared/api/client'
import type { ReadinessStage, RecordingReadiness } from '@/shared/api/types'
import {
  dash,
  formatDate,
  groupByPatient,
  readinessText,
  stageLabel,
  stageSummary,
} from '@/shared/lib/dbTable'
import { dbSelectionCsv, dbSelectionFilename, dbSelectionJson, dbSelectionJsonFilename, dbSelectionReport, dbSelectionReportFilename } from '@/shared/lib/dbExport'
import { downloadText } from '@/shared/lib/download'
import { useDbView } from '@/shared/state/dbView'
import { openRecordingById } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { Placeholder } from '@/shared/ui/Placeholder'
import { StatusPill } from '@/shared/ui/StatusPill'
import { cx } from '@/shared/ui/cx'
import { DbReadinessDetail } from './DbReadinessDetail'

/** Пауза перед запросом поиска: строка идёт на сервер, а не фильтрует страницу. */
const SEARCH_DEBOUNCE_MS = 300

/** Пилюля одной стадии в строке: ✔ готово / — нет, дата — в тултипе. */
function StageMark({ stage }: { stage: ReadinessStage }) {
  return (
    <span
      title={`${stageLabel(stage.stage)}: ${
        stage.state === 'ready'
          ? `готово, прогонов ${stage.n_runs}${stage.last_run_at ? `, последний ${formatDate(stage.last_run_at)}` : ''}`
          : 'результатов в БД нет'
      }`}
      className={cx(
        'inline-flex items-center rounded border px-1.5 text-xs whitespace-nowrap',
        stage.state === 'ready'
          ? 'border-ok/40 bg-ok/10 text-ok'
          : 'border-border bg-bg-2 text-fg-2',
      )}
    >
      {`${stageLabel(stage.stage)} ${stage.state === 'ready' ? '✔' : '—'}`}
    </span>
  )
}

function PassportCell({ row }: { row: RecordingReadiness }) {
  return (
    <span className="tnum text-sm text-fg-1">
      {`${dash(row.n_channels)} кан. · ${dash(row.sfreq)} Гц · ${dash(
        row.duration_sec !== null && row.duration_sec !== undefined
          ? Math.round(row.duration_sec)
          : null,
      )} с`}
    </span>
  )
}

/** Строка записи: чекбокс, паспорт, готовность и сводки последних прогонов. */
function DbRow({
  row,
  expanded,
  onToggleExpanded,
  onToggleSelected,
  onOpen,
  selected,
}: {
  row: RecordingReadiness
  expanded: boolean
  onToggleExpanded: () => void
  onToggleSelected: () => void
  onOpen: () => void
  selected: boolean
}) {
  const readyStages = (row.stages ?? []).filter((stage) => stage.state === 'ready')
  return (
    <>
      <tr
        data-testid={`db-row-${row.recording_id}`}
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        className={cx(
          'cursor-pointer border-b border-border/60 hover:bg-bg-2',
          expanded && 'bg-accent/10 hover:bg-accent/10',
        )}
      >
        <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Выбрать запись ${row.filename ?? row.recording_id}`}
            checked={selected}
            onChange={onToggleSelected}
            className="h-4 w-4"
          />
        </td>
        <td className="px-3 py-1.5" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center gap-2">
            <div>
              <div className="font-medium text-fg-0">{row.filename ?? row.recording_id}</div>
              <div className="text-xs text-fg-2">{row.recording_id}</div>
            </div>
            <Button
              variant="ghost"
              icon={<ExternalLink className="h-4 w-4" />}
              title="Открыть запись в разделе «EDF» (ссылка ?rec= воспроизводима)"
              aria-label={`Открыть запись ${row.filename ?? row.recording_id} в EDF`}
              onClick={onOpen}
            >
              Открыть
            </Button>
          </div>
        </td>
        <td className="px-3 py-1.5 text-fg-1">{row.patient_alias ?? '—'}</td>
        <td className="px-3 py-1.5">
          <PassportCell row={row} />
          <div className="text-xs text-fg-2">{`от ${formatDate(row.created_at)}`}</div>
        </td>
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <StatusPill
              tone={
                row.readiness_ready >= row.readiness_total
                  ? 'ok'
                  : row.readiness_ready > 0
                    ? 'accent'
                    : 'warn'
              }
            >
              {readinessText(row)}
            </StatusPill>
            <span className="flex flex-wrap gap-1">
              {(row.stages ?? []).map((stage) => (
                <StageMark key={stage.stage} stage={stage} />
              ))}
            </span>
          </div>
        </td>
        <td className="px-3 py-1.5 text-sm text-fg-1">
          {readyStages.length > 0 ? (
            readyStages.map((stage) => (
              <div key={stage.stage}>
                <span className="text-fg-2">{`${stageLabel(stage.stage)}: `}</span>
                {stageSummary(stage)}
              </div>
            ))
          ) : (
            <span className="text-fg-2">Результаты в БД не записаны</span>
          )}
        </td>
      </tr>
      {expanded ? (
        <tr data-testid={`db-detail-row-${row.recording_id}`}>
          <td colSpan={6} className="border-b border-border bg-bg-1 p-0">
            <DbReadinessDetail recordingId={row.recording_id} />
          </td>
        </tr>
      ) : null}
    </>
  )
}

export function DbSection() {
  const navigate = useNavigate()
  const onlyProcessed = useDbView((state) => state.onlyProcessed)
  const search = useDbView((state) => state.search)
  const grouped = useDbView((state) => state.groupByPatient)
  const sortKey = useDbView((state) => state.sortKey)
  const pageLimit = useDbView((state) => state.pageLimit)
  const pageOffset = useDbView((state) => state.pageOffset)
  const setPageOffset = useDbView((state) => state.setPageOffset)
  const selectedIds = useDbView((state) => state.selectedIds)
  const expandedId = useDbView((state) => state.expandedId)
  const toggleSelected = useDbView((state) => state.toggleSelected)
  const selectMany = useDbView((state) => state.selectMany)
  const toggleExpanded = useDbView((state) => state.toggleExpanded)
  const setOnlyProcessed = useDbView((state) => state.setOnlyProcessed)
  const setSearch = useDbView((state) => state.setSearch)

  // Поиск идёт на сервер (шаблон E): debounce, чтобы не дёргать БД на символ
  const [debouncedSearch, setDebouncedSearch] = useState(search)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const query = useQuery({
    queryKey: [
      'recordings-readiness', onlyProcessed, debouncedSearch, sortKey, pageLimit, pageOffset,
    ],
    queryFn: ({ signal }) =>
      api.recordingsReadiness(
        {
          only_processed: onlyProcessed,
          search: debouncedSearch.trim() || undefined,
          sort: sortKey,
          limit: pageLimit,
          offset: pageOffset,
        },
        signal,
      ),
  })

  const rows = useMemo(() => query.data?.items ?? [], [query.data])
  const groups = useMemo(
    () => (grouped ? groupByPatient(rows) : [{ alias: null, label: '', rows }]),
    [rows, grouped],
  )
  const total = query.data?.total ?? 0
  const processedCount = rows.filter((row) => row.readiness_ready > 0).length
  const pageFrom = total === 0 ? 0 : pageOffset + 1
  const pageTo = pageOffset + rows.length

  /**
   * Строки выборки для выгрузки: текущая страница уже в памяти, выбранные с
   * других страниц дочитываются карточкой готовности (она несёт тот же паспорт
   * и стадии) — выборка не обрезается границей страницы.
   */
  const resolveSelection = async (): Promise<RecordingReadiness[]> => {
    const loaded = new Map(rows.map((row) => [row.recording_id, row]))
    // Добор карточек с других страниц — параллельно: последовательные RTT перед
    // выгрузкой не нужны (аудит 17.11.2026, Ф4); порядок выбора сохраняется.
    const fetched = await Promise.all(
      selectedIds.map(async (id) => {
        const row = loaded.get(id)
        if (row) return row
        try {
          return await api.recordingReadiness(id)
        } catch {
          // Запись могла быть удалена между выбором и выгрузкой — пропускаем
          return null
        }
      }),
    )
    return fetched.filter((row): row is RecordingReadiness => row !== null)
  }

  /** Выгрузка выборки одним из форматов: CSV, JSON или сводный HTML-отчёт. */
  const exportSelection = async (
    format: 'csv' | 'json' | 'report',
  ): Promise<void> => {
    const resolved = await resolveSelection()
    if (resolved.length === 0) return
    if (format === 'csv') {
      downloadText(dbSelectionFilename(), dbSelectionCsv(resolved))
    } else if (format === 'json') {
      downloadText(
        dbSelectionJsonFilename(),
        dbSelectionJson(resolved),
        'application/json;charset=utf-8',
      )
    } else {
      downloadText(
        dbSelectionReportFilename(),
        dbSelectionReport(resolved),
        'text/html;charset=utf-8',
      )
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone="neutral">{`Записей: ${rows.length}${total > rows.length ? ` из ${total}` : ''}`}</StatusPill>
        {total > pageLimit ? (
          <StatusPill tone="neutral">{`Страница: ${pageFrom}–${pageTo} из ${total}`}</StatusPill>
        ) : null}
        <StatusPill tone="neutral">{`С результатами: ${processedCount}`}</StatusPill>
        <StatusPill tone={selectedIds.length > 0 ? 'accent' : 'neutral'}>
          {`Выбрано: ${selectedIds.length}`}
        </StatusPill>
        {onlyProcessed ? (
          <StatusPill
            tone="accent"
            title="Фильтр «только обработанные» — снимается в панели «Опции»"
          >
            Только с результатами
          </StatusPill>
        ) : null}
        {search ? <StatusPill tone="accent">{`Поиск: «${search}»`}</StatusPill> : null}
        {query.isFetching ? <StatusPill tone="neutral">Обновление…</StatusPill> : null}
        <span className="ml-auto flex items-center gap-2">
          <Button
            icon={<Download className="h-4 w-4" />}
            disabled={selectedIds.length === 0}
            title={
              selectedIds.length > 0
                ? 'Выгрузить выбранные записи (готовность и параметры прогонов) в CSV'
                : 'Выберите записи чекбоксами — выгрузка идёт по выборке'
            }
            onClick={() => void exportSelection('csv')}
          >
            Экспорт CSV
          </Button>
          <Button
            icon={<Download className="h-4 w-4" />}
            disabled={selectedIds.length === 0}
            title="Выгрузить выборку в JSON (строки контракта без потерь)"
            onClick={() => void exportSelection('json')}
          >
            Экспорт JSON
          </Button>
          <Button
            icon={<Download className="h-4 w-4" />}
            disabled={selectedIds.length === 0}
            title="Сводный HTML-отчёт по выборке: паспорта, готовность, параметры прогонов"
            onClick={() => void exportSelection('report')}
          >
            Отчёт HTML
          </Button>
          <Button
            icon={<ChevronLeft className="h-4 w-4" />}
            disabled={pageOffset === 0}
            title="Предыдущая страница"
            onClick={() => setPageOffset(Math.max(0, pageOffset - pageLimit))}
          >
            Назад
          </Button>
          <Button
            icon={<ChevronRight className="h-4 w-4" />}
            disabled={pageOffset + rows.length >= total}
            title="Следующая страница"
            onClick={() => setPageOffset(pageOffset + pageLimit)}
          >
            Вперёд
          </Button>
        </span>
      </div>

      {query.isError ? (
        <Placeholder
          icon={<Database className="h-10 w-10" />}
          title="Не удалось прочитать записи БД"
          description={String(query.error)}
        >
          <Button onClick={() => query.refetch()}>Повторить</Button>
        </Placeholder>
      ) : rows.length === 0 ? (
        <Placeholder
          icon={<Database className="h-10 w-10" />}
          title={query.data ? 'Записей не найдено' : 'Загрузка записей…'}
          description={
            query.data
              ? 'Снимите фильтры «только обработанные»/поиск в панели «Опции» — или загрузите EDF в разделе «EDF».'
              : undefined
          }
        >
          {query.data ? (
            <Button
              onClick={() => {
                setOnlyProcessed(false)
                setSearch('')
              }}
            >
              Показать все записи
            </Button>
          ) : null}
        </Placeholder>
      ) : (
        <div className="scroll-y-always min-h-0 flex-1 overflow-x-auto rounded-lg border border-border bg-bg-1">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Записи ЭЭГ и степень готовности записанных в БД результатов расчётов: стадии
              (препроцессинг, диполи, полосы пакета, отчёт, спектрограмма) и параметры последних
              прогонов. Клик по строке раскрывает карточку готовности.
            </caption>
            <thead className="sticky top-0 z-10 bg-bg-2">
              <tr>
                <th scope="col" className="border-b border-border px-3 py-2 text-left font-semibold text-fg-2">
                  Выбор
                </th>
                <th scope="col" className="border-b border-border px-3 py-2 text-left font-semibold text-fg-2">
                  Запись
                </th>
                <th scope="col" className="border-b border-border px-3 py-2 text-left font-semibold text-fg-2">
                  Испытуемый
                </th>
                <th scope="col" className="border-b border-border px-3 py-2 text-left font-semibold text-fg-2">
                  Паспорт
                </th>
                <th scope="col" className="border-b border-border px-3 py-2 text-left font-semibold text-fg-2">
                  Готовность
                </th>
                <th scope="col" className="border-b border-border px-3 py-2 text-left font-semibold text-fg-2">
                  Параметры последних прогонов
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.alias ?? '__all__'}>
                {grouped ? (
                  <tr className="bg-bg-2/60">
                    <td colSpan={6} className="border-b border-border px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-fg-0">{group.label}</span>
                        <StatusPill tone="neutral">
                          {`записей: ${group.rows.length}, с результатами: ${
                            group.rows.filter((row) => row.readiness_ready > 0).length
                          }`}
                        </StatusPill>
                        <Button
                          variant="ghost"
                          onClick={() => selectMany(group.rows.map((row) => row.recording_id))}
                          title="Выбрать все записи этого испытуемого"
                        >
                          Выбрать группу
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {group.rows.map((row) => (
                  <DbRow
                    key={row.recording_id}
                    row={row}
                    selected={selectedIds.includes(row.recording_id)}
                    expanded={expandedId === row.recording_id}
                    onToggleExpanded={() => toggleExpanded(row.recording_id)}
                    onToggleSelected={() => toggleSelected(row.recording_id)}
                    onOpen={() => {
                      void openRecordingById(row.recording_id)
                      navigate('/edf')
                    }}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <p className="text-sm text-fg-2">
        Раздел только читает БД (записанные результаты и параметры прогонов) и ничего не
        пересчитывает: пересчёт стадий — кнопками разделов EDF/«Диполи»/«Итоги». Кнопка «Открыть»
        в строке переносит запись в раздел «EDF» (ссылка `?rec=` воспроизводима); выборка
        (чекбоксы) выгружается CSV/JSON и сводным HTML-отчётом, кнопками «В пару (A/B)» и
        «В группу (N&gt;2)» тулс-хедера передаётся в раздел «Групповой анализ». Поиск, сортировка
        и пагинация — серверные.
      </p>
    </div>
  )
}