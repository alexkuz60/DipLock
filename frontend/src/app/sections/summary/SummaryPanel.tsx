/**
 * Панель опций раздела «Итоги»: набор полос пакета и шаг сетки поиска.
 *
 * Панель, как и в остальных разделах, **ничего не запускает** (правило
 * `docs/ui.md`): параметры складываются в стор, а расчёт стартует только
 * кнопкой «Собрать отчёт» в шапке. Фильтр/пороги/длина эпохи части 1 —
 * параметры формы раздела EDF: здесь они показаны только для сверки
 * («с чем именно совпадут числа отчёта»), правятся в EDF.
 *
 * Набор полос: `null` в сторе — «все полосы из /meta» (дефолт); первый клик
 * раскрывает его в явный список. Пустой список — состояние «ничего не
 * выбрано»: кнопка расчёта выключена, сервер такое не получит.
 */
import { useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { api } from '@/shared/api/client'
import { bandKeyOptions } from '@/shared/lib/bandOptions'
import { filterBandText, FUNCTIONAL_GROUP } from '@/shared/lib/calcFilter'
import { GRID_MM_RANGE } from '@/shared/lib/dipoleCalcModel'
import { useEdfParams } from '@/shared/state/edfParams'
import { filterBandOf } from '@/shared/state/edfRecording'
import { useSummaryReport } from '@/shared/state/summaryReport'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SelectField, type SelectOption } from '@/shared/ui/SelectField'
import { StatusPill } from '@/shared/ui/StatusPill'

/** Дата из ISO-строки задачи/прогона: короткая подпись для пункта списка. */
function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  return String(iso).slice(0, 16).replace('T', ' ')
}

/**
 * Панель отчётов группового анализа (Тип 1/Тип 2): выбор источника из
 * истории и справка о собранном документе. Панель, как и в остальных
 * состояниях раздела, **ничего не запускает** — сборка только кнопкой
 * «Собрать отчёт» в шапке (`docs/rules/frontend-state.md`).
 */
function GroupReportPanel({ source }: { source: 'compare' | 'group' }) {
  const isCompare = source === 'compare'
  const jobsQuery = useQuery({
    queryKey: ['summary-compare-jobs'],
    queryFn: () => api.jobs(50),
    enabled: isCompare,
  })
  const runsQuery = useQuery({
    queryKey: ['summary-group-runs'],
    queryFn: () => api.group.runs({ limit: 50 }),
    enabled: !isCompare,
  })

  const compareJobId = useSummaryReport((state) => state.compareJobId)
  const setCompareJobId = useSummaryReport((state) => state.setCompareJobId)
  const compareReport = useSummaryReport((state) => state.compareReport)
  const compareError = useSummaryReport((state) => state.compareError)
  const groupRunId = useSummaryReport((state) => state.groupRunId)
  const setGroupRunId = useSummaryReport((state) => state.setGroupRunId)
  const groupReport = useSummaryReport((state) => state.groupReport)
  const groupError = useSummaryReport((state) => state.groupError)

  const compareJobs = (jobsQuery.data ?? []).filter(
    (job) => job.kind === 'compare' && job.status === 'succeeded',
  )
  const runs = runsQuery.data?.items ?? []
  const report = isCompare ? compareReport : groupReport
  const error = isCompare ? compareError : groupError

  const jobOptions: SelectOption<string>[] = [
    {
      value: '',
      label: compareJobs.length ? '— выберите сравнение —' : 'Нет завершённых сравнений',
    },
    ...compareJobs.map((job) => ({
      value: job.job_id,
      label: `${job.filename ?? job.job_id}${job.created_at ? ` · ${fmtWhen(job.created_at)}` : ''}`,
    })),
  ]
  const runOptions: SelectOption<string>[] = [
    { value: '', label: runs.length ? '— выберите прогон —' : 'Нет сохранённых прогонов' },
    ...runs.map((run) => ({
      value: String(run.id),
      label: `${run.name ?? `Прогон №${run.id}`} · ${run.band_key ?? '—'}${
        run.created_at ? ` · ${fmtWhen(run.created_at)}` : ''
      }`,
    })),
  ]

  return (
    <>
      <Panel
        title="Источник отчёта"
        hint={
          isCompare
            ? 'Отчёт собирается по результату задачи «Сравнение» (история задач). Задача без сохранённого результата сюда не попадает; список — только чтение.'
            : 'Отчёт собирается по сохранённому прогону группового анализа: числа пересчитываются по живой БД в момент сборки (история хранит определение, §8.4.2).'
        }
      >
        {isCompare ? (
          <SelectField
            label="Сравнение"
            value={compareJobId ?? ''}
            options={jobOptions}
            onChange={(value) => setCompareJobId(value || null)}
            hint="Завершённые задачи «Сравнение» двух записей"
            disabled={jobsQuery.isFetching}
          />
        ) : (
          <SelectField
            label="Прогон"
            value={groupRunId === null ? '' : String(groupRunId)}
            options={runOptions}
            onChange={(value) => setGroupRunId(value ? Number(value) : null)}
            hint="Сохранённые прогоны («Сохранить прогон» в разделе «Групповой анализ»)"
            disabled={runsQuery.isFetching}
          />
        )}
        {(isCompare ? jobsQuery.isError : runsQuery.isError) ? (
          <p className="mt-2 text-sm text-warn" data-testid="summary-source-error">
            Не удалось загрузить список источников — обновите страницу.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Результат"
        hint="Справка о собранном отчёте: сам документ — в рабочей области (HTML MNE.Report, iframe)."
      >
        <div className="mb-2 flex flex-wrap gap-2">
          <StatusPill tone={report ? 'ok' : 'neutral'}>
            {report ? 'Отчёт собран' : 'Отчёта нет'}
          </StatusPill>
          {report ? <StatusPill tone="neutral">Отпечаток: {report.html_sig}</StatusPill> : null}
        </div>
        {report ? (
          <ul className="space-y-1 text-sm text-fg-2">
            <li>{`Документ: ${report.title}`}</li>
            <li>{`Предупреждений источника: ${(report.warnings ?? []).length}`}</li>
            <li>{`Версия ассета: ${report.report_version}`}</li>
          </ul>
        ) : (
          <p className="text-sm text-fg-2">
            {error
              ? `Последняя попытка: ${error}`
              : 'Результат появится после сборки отчёта кнопкой в шапке.'}
          </p>
        )}
      </Panel>
    </>
  )
}

export function SummaryPanel() {
  const kind = useSummaryReport((state) => state.kind)
  if (kind === 'compare' || kind === 'group') {
    return <GroupReportPanel source={kind} />
  }
  return <RecordPanel />
}

function RecordPanel() {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.meta() })
  const options = bandKeyOptions(meta.data ?? null)
  const allKeys = options.map((option) => option.value)

  const bandKeys = useSummaryReport((state) => state.bandKeys)
  const toggleBand = useSummaryReport((state) => state.toggleBand)
  const setBandKeys = useSummaryReport((state) => state.setBandKeys)
  const gridMm = useSummaryReport((state) => state.gridMm)
  const setGridMm = useSummaryReport((state) => state.setGridMm)
  const result = useSummaryReport((state) => state.result)
  const error = useSummaryReport((state) => state.error)

  const edfParams = useEdfParams((state) => state.params)
  const active = bandKeys ?? allKeys
  const eventsMode = edfParams.epochMode === 'events'

  return (
    <>
      <Panel
        title="Полосы пакета"
        hint="Часть 2 считает диполи отдельно по каждой выбранной полосе. GOF между полосами не сравним (узкая полоса завышает R²) — сравнивать можно доли эпох и RIV (docs/rules/dipoles.md)."
      >
        {options.length === 0 ? (
          <p className="text-sm text-fg-2">Список полос придёт из /meta.</p>
        ) : (
          <>
            {options.map((option) => (
              <CheckboxRow
                key={option.value}
                label={option.label}
                hint={
                  option.group === FUNCTIONAL_GROUP
                    ? `Функциональный ритм (${option.group}) — пресеты фильтра`
                    : `Октавная полоса «${option.value}»`
                }
                checked={active.includes(option.value)}
                onChange={() => toggleBand(option.value, allKeys)}
              />
            ))}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                icon={<RotateCcw className="size-4" />}
                disabled={bandKeys === null}
                onClick={() => setBandKeys(null)}
                title="Считать все полосы из /meta (набор пакета по умолчанию)"
              >
                Все полосы
              </Button>
              <StatusPill tone={bandKeys === null ? 'accent' : 'neutral'}>
                {bandKeys === null ? 'Все полосы' : `Выбрано: ${bandKeys.length}`}
              </StatusPill>
            </div>
            {bandKeys !== null && bandKeys.length === 0 ? (
              <p className="mt-2 text-sm text-warn" data-testid="summary-no-bands">
                Не выбрана ни одна полоса — сборка отчёта недоступна.
              </p>
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        title="Расчёт"
        hint="Шаг сетки — параметр пакета (быстрый перебор узлов, как в «Диполях»). Остальные параметры части 1 — форма раздела EDF: отчёт обязан совпасть с ней числами."
      >
        <NumberField
          label="Шаг сетки"
          value={gridMm}
          onChange={setGridMm}
          min={GRID_MM_RANGE[0]}
          max={GRID_MM_RANGE[1]}
          step={1}
          unit="мм"
          hint="Мельче — точнее и дольше: число узлов растёт как шаг⁻³"
        />
        <ul className="mt-3 space-y-1 text-sm text-fg-2">
          <li>{`Длина эпохи: ${edfParams.epochLengthMs} мс (форма EDF)`}</li>
          <li>{`Фильтр: ${filterBandText(filterBandOf(edfParams))}`}</li>
          <li>{`Notch: ${edfParams.notchHz ? `${edfParams.notchHz} Гц` : 'выключен'}`}</li>
          <li>{`Референс: ${edfParams.reference}`}</li>
        </ul>
        {eventsMode ? (
          <p className="mt-2 text-sm text-fg-2" data-testid="summary-events-note">
            {`Событийная нарезка («${edfParams.eventId || 'событие не выбрано'}») — в части 1 отчёта, как в EDF. Пакет диполей (часть 2) считается на фиксированной нарезке${edfParams.epochLengthMs} мс — это подписано в самом HTML (events.md, п.8).`}
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Результат"
        hint="Справка о собранном отчёте: числа приходят из задачи, сам документ — в рабочей области (HTML MNE.Report)."
      >
        <div className="mb-2 flex flex-wrap gap-2">
          <StatusPill tone={result ? 'ok' : 'neutral'}>
            {result ? 'Отчёт собран' : 'Отчёта нет'}
          </StatusPill>
          {result ? (
            <StatusPill tone="neutral">{`Полос: ${result.bands?.length ?? 0}`}</StatusPill>
          ) : null}
        </div>
        {result ? (
          <ul className="space-y-1 text-sm text-fg-2">
            <li>{`Файл: ${result.filename}`}</li>
            <li>
              {`QC: ${result.qc.status}${(result.qc.reasons ?? []).length ? ` (${(result.qc.reasons ?? []).join(', ')})` : ''}`}
            </li>
            <li>{`Эпох: ${result.n_epochs_used} из ${result.n_epochs_total}, отклонено ${result.rejected_epochs}`}</li>
            <li>{`Время расчёта: ${result.duration_sec_calc.toFixed(1)} с`}</li>
          </ul>
        ) : (
          <p className="text-sm text-fg-2">
            {error ? `Последняя попытка: ${error}` : 'Результат появится после сборки отчёта.'}
          </p>
        )}
      </Panel>
    </>
  )
}
