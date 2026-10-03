/**
 * Рабочая область «Группа (N>2)» (остаток 4.7, §3.5): агрегаты «BA × сессии».
 *
 * Числа приходят с сервера целиком (`GroupAggregateOut`) — клиент ничего не
 * пересчитывает: паспорт группы, тепловая карта (чистый SVG над серверными
 * долями), таблицы обоих словарей, экспорт сводки в CSV (клиентский, данные
 * уже в результате) и обязательные `notes`/`warnings` без редактирования.
 * Правка фильтров в панели результат не трогает — новые числа даёт только
 * кнопка «Считать» (правило раздела).
 */
import { useMemo, useState } from 'react'
import { Download, GitBranch } from 'lucide-react'
import type { GroupAggregateOut, GroupRow } from '@/shared/api/types'
import { groupCsv, groupCsvFilename } from '@/shared/lib/groupExport'
import { bandLabel } from '@/shared/lib/spectrum'
import { useGroupRun } from '@/shared/state/groupRun'
import { Button } from '@/shared/ui/Button'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { WarnList } from '@/shared/ui/WarnList'
import { GroupHeatmap } from './GroupHeatmap'

/** Скачивание CSV из готового результата (без запросов — §3.5 «экспорт сводки»). */
function downloadCsv(result: GroupAggregateOut) {
  const blob = new Blob([groupCsv(result)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = groupCsvFilename(result.filters.band_key)
  anchor.click()
  URL.revokeObjectURL(url)
}

/** Паспорт: что считалось (эхо фильтров) и из чего (участники). */
function GroupPassport({ result }: { result: GroupAggregateOut }) {
  const filters = result.filters
  return (
    <Panel
      title="Группа и фильтры"
      hint="Агрегаты осмысленны только при одинаковой обработке участников. GOF и амплитуды — внутри своей полосы (принцип 3)."
    >
      <ul className="space-y-1 text-sm text-fg-2" data-testid="group-passport">
        <li>
          {`Полоса: ${bandLabel(filters.band_key)} ${filters.band_hz?.[0]}–${filters.band_hz?.[1]} Гц`}
        </li>
        <li>
          {`Отбор точек: ${filters.gof_min === null ? 'без отбора (все точки полосы)' : `GOF ≥ ${filters.gof_min}`}`}
        </li>
        <li>
          {`Длина эпохи: ${filters.epoch_length_ms ?? 'любая'} · строки: ${filters.names?.length ? filters.names.join(', ') : 'все'} · максимум строк: ${filters.top_n}`}
        </li>
        <li className="tnum">
          {`Точек в выборке: ${result.n_points_total} · структур: ${result.n_structure_names} · полей БА: ${result.n_brodmann_names}`}
        </li>
      </ul>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm" data-testid="group-participants">
          <thead>
            <tr className="border-b border-border text-left text-fg-2">
              <th className="py-1.5 pr-3 font-normal">Запись</th>
              <th className="py-1.5 pr-3 font-normal">Файл</th>
              <th className="py-1.5 pr-3 font-normal">Прогон</th>
              <th className="py-1.5 pr-3 text-right font-normal">Точек</th>
            </tr>
          </thead>
          <tbody>
            {result.participants.map((participant) => (
              <tr
                key={participant.recording_id}
                className="border-b border-border/50 text-fg-1"
              >
                <td className="tnum py-1.5 pr-3">{participant.recording_id}</td>
                <td className="py-1.5 pr-3" title={participant.filename ?? ''}>
                  {participant.filename ?? '— запись удалена —'}
                </td>
                <td className="tnum py-1.5 pr-3 text-fg-2">
                  {participant.analysis_id === null
                    ? 'нет прогона'
                    : `${participant.analysis_kind ?? ''} №${participant.analysis_id}`}
                </td>
                <td className="tnum py-1.5 pr-3 text-right">{participant.n_points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/** Таблица одного словаря: агрегаты группы (ячейки по записям — на карте). */
function AggregatesTable({
  title,
  rows,
  testId,
}: {
  title: string
  rows: GroupRow[]
  testId: string
}) {
  const fmt = (value: number | null | undefined, digits: number) =>
    value === null || value === undefined ? '—' : value.toFixed(digits)
  return (
    <Panel title={title} hint="GOF и амплитуды — внутри полосы; доля — от всех точек выборки.">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid={testId}>
          <thead>
            <tr className="border-b border-border text-left text-fg-2">
              <th className="py-1.5 pr-3 font-normal">Строка</th>
              <th className="py-1.5 pr-3 font-normal">Полушарие</th>
              <th className="py-1.5 pr-3 text-right font-normal">Точек</th>
              <th className="py-1.5 pr-3 text-right font-normal">Доля</th>
              <th className="py-1.5 pr-3 text-right font-normal">Средний GOF</th>
              <th className="py-1.5 pr-3 text-right font-normal">Медиана GOF</th>
              <th className="py-1.5 pr-3 text-right font-normal">СТОД GOF</th>
              <th className="py-1.5 pr-3 text-right font-normal">Средняя ампл, нАм</th>
              <th className="py-1.5 pr-3 text-right font-normal">СТОД ампл</th>
              <th className="py-1.5 text-right font-normal">Записей</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.name}
                className="border-b border-border/50 text-fg-1"
                data-testid={`group-row-${row.name}`}
              >
                <td className="py-1.5 pr-3" title={row.name}>
                  {row.name}
                </td>
                <td className="py-1.5 pr-3 text-fg-2">{row.hemisphere}</td>
                <td className="tnum py-1.5 pr-3 text-right">{row.count}</td>
                <td className="tnum py-1.5 pr-3 text-right">
                  {`${(row.share * 100).toFixed(1)} %`}
                </td>
                <td className="tnum py-1.5 pr-3 text-right">{fmt(row.mean_gof, 3)}</td>
                <td className="tnum py-1.5 pr-3 text-right">{fmt(row.median_gof, 3)}</td>
                <td className="tnum py-1.5 pr-3 text-right">{fmt(row.std_gof, 3)}</td>
                <td className="tnum py-1.5 pr-3 text-right">
                  {fmt(row.mean_amplitude_nam, 1)}
                </td>
                <td className="tnum py-1.5 pr-3 text-right">
                  {fmt(row.std_amplitude_nam, 1)}
                </td>
                <td className="tnum py-1.5 text-right">{row.n_sessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-fg-2">Строк нет (фильтр строк пуст или точек нет).</p>
      ) : null}
    </Panel>
  )
}



export function GroupRunSection() {
  const aggregate = useGroupRun((state) => state.aggregate)
  const loading = useGroupRun((state) => state.loading)
  const error = useGroupRun((state) => state.error)
  const saved = useGroupRun((state) => state.saved)
  /** Какой словарь показывает тепловая карта: §3.5 — «BA × сессии». */
  const [heatKind, setHeatKind] = useState<'brodmann' | 'structure'>('brodmann')

  const heatRows = useMemo(() => {
    if (!aggregate) return []
    return heatKind === 'brodmann'
      ? (aggregate.brodmann ?? [])
      : (aggregate.structures ?? [])
  }, [aggregate, heatKind])

  if (!aggregate) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <GitBranch className="size-10 text-fg-2" aria-hidden />
        <h2 className="text-lg font-medium text-fg-0">Групповой анализ (N&gt;2)</h2>
        <p className="max-w-xl text-sm text-fg-2">
          {loading
            ? 'Считаем агрегаты…'
            : 'Выберите участников и полосу в панели справа и нажмите «Считать». Результат: агрегаты «BA × сессии», тепловая карта, экспорт сводки.'}
        </p>
        {error ? (
          <p className="max-w-xl text-sm text-warn" data-testid="group-run-error">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4" data-testid="group-run-result">
      {error ? (
        <p className="text-sm text-warn" data-testid="group-run-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-sm text-ok" data-testid="group-run-saved">
          {`Сохранено в историю: ${saved.name || `прогон №${saved.id}`} (открыт ниже свежий пересчёт)`}
        </p>
      ) : null}
      <GroupPassport result={aggregate} />

      <Panel
        title="Тепловая карта «BA × сессии»"
        hint="Ячейка — доля точек своей записи в строке: между записями сравнима только она (разное число эпох). Шкала линейная 0…max по всей карте."
      >
        <SegmentedControl
          label="Словарь"
          layout="inline"
          value={heatKind}
          options={[
            { value: 'brodmann', label: 'Поля Бродмана' },
            { value: 'structure', label: 'Структуры' },
          ]}
          onChange={setHeatKind}
        />
        <GroupHeatmap
          rows={heatRows}
          participants={aggregate.participants}
          caption={`${bandLabel(aggregate.filters.band_key)} ${aggregate.filters.band_hz?.[0]}–${aggregate.filters.band_hz?.[1]} Гц`}
        />
      </Panel>

      <div className="flex justify-end">
        <Button
          icon={<Download className="size-4" />}
          onClick={() => downloadCsv(aggregate)}
          data-testid="group-export-csv"
          title="Сводка агрегатов и ячеек в CSV (формат RFC 4180)"
        >
          Экспорт CSV
        </Button>
      </div>

      <AggregatesTable
        title="Поля Бродмана"
        rows={aggregate.brodmann ?? []}
        testId="group-table-brodmann"
      />
      <AggregatesTable
        title="Структуры"
        rows={aggregate.structures ?? []}
        testId="group-table-structures"
      />

      <Panel
        title="Правила чтения и предупреждения"
        hint="Каветы — часть контракта: показываются без редактирования (как у сравнения пары)."
      >
        <ul className="list-inside list-disc space-y-1 text-sm text-fg-2" data-testid="group-run-notes">
          {(aggregate.notes ?? []).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <WarnList items={aggregate.warnings ?? []} testId="group-run-warnings" />
      </Panel>
    </div>
  )
}

