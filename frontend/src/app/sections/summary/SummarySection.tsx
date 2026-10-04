/**
 * Раздел «Итоги»: сквозной автоотчёт пайплайна записи.
 *
 * Раздел — **зритель** задачи, а не вычислитель: он показывает состояние
 * (`summaryReport`) и сам документ. Отчёт — самодостаточный HTML
 * `mne.Report` (часть 1: качество сырого файла и препроцессинг теми же
 * числами, что EDF; часть 2: пакетный расчёт диполей по полосам с динамикой
 * структур/BA), поэтому показ — это iframe по `html_url` с `?v=` (версия
 * ассета), а не пересборка секций в React: документ кочует и в новую вкладку,
 * и в печать без нас.
 *
 * Что решает состояние двух сторов:
 *
 * * `edfRecording` — загружена ли запись (без неё отчёта не бывает);
 * * `summaryReport` — результат/задача/ошибка; результат принадлежит записи:
 *   при закрытии или смене записи он сбрасывается (сравнение `recording_id`),
 *   а `reset()` глушит устаревший поллинг.
 */
import { useEffect, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useSummaryReport } from '@/shared/state/summaryReport'
import { Placeholder } from '@/shared/ui/Placeholder'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { StatusPill } from '@/shared/ui/StatusPill'
import { SummaryDynamics } from './SummaryDynamics'
import { SummaryRoi } from './SummaryRoi'

/** Человеческие подписи QC-вердикта (те же слова, что в отчёте) */
const QC_LABELS: Record<string, string> = { ok: 'QC: ок', warn: 'QC: внимание', bad: 'QC: плохо' }

/** Тон пилюли по вердикту светофора */
const QC_TONES: Record<string, 'ok' | 'warn' | 'danger'> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'danger',
}

/** Три источника отчёта раздела «Итоги» (переключатель — в шапке рабочей области) */
const KIND_OPTIONS = [
  {
    value: 'record' as const,
    label: 'Запись',
    title: 'Сквозной автоотчёт открытой записи (части 1–2)',
  },
  {
    value: 'compare' as const,
    label: 'Сравнение (Тип 1)',
    title: 'Отчёт по результату сравнения двух записей (B9)',
  },
  {
    value: 'group' as const,
    label: 'Группа (Тип 2)',
    title: 'Отчёт по прогону группового анализа N>2',
  },
]

/** Переключатель вида отчёта: чистая отрисовка, запросов не шлёт. */
function KindSwitch() {
  const kind = useSummaryReport((state) => state.kind)
  const setKind = useSummaryReport((state) => state.setKind)
  return (
    <div className="flex flex-wrap items-center" data-testid="summary-kind">
      <SegmentedControl
        layout="inline"
        label="Отчёт"
        value={kind}
        options={KIND_OPTIONS}
        onChange={setKind}
      />
    </div>
  )
}

/**
 * Вид отчёта группового анализа (Тип 1/Тип 2): документ собирается только
 * кнопкой «Собрать отчёт» в шапке (`buildCompareReport`/`buildGroupReport`),
 * здесь — ожидание, ошибка и iframe по `html_url` с `?v=` (версия ассета).
 */
function GroupReportBody({ source }: { source: 'compare' | 'group' }) {
  const compareReport = useSummaryReport((state) => state.compareReport)
  const compareBuilding = useSummaryReport((state) => state.compareBuilding)
  const compareError = useSummaryReport((state) => state.compareError)
  const compareJobId = useSummaryReport((state) => state.compareJobId)
  const groupReport = useSummaryReport((state) => state.groupReport)
  const groupBuilding = useSummaryReport((state) => state.groupBuilding)
  const groupError = useSummaryReport((state) => state.groupError)
  const groupRunId = useSummaryReport((state) => state.groupRunId)

  const isCompare = source === 'compare'
  const report = isCompare ? compareReport : groupReport
  const building = isCompare ? compareBuilding : groupBuilding
  const error = isCompare ? compareError : groupError
  const selected = isCompare ? compareJobId : groupRunId
  const sourceLabel = isCompare ? 'сравнение из истории задач' : 'прогон из истории группового анализа'

  if (building) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
        <ClipboardList className="size-12 text-accent" aria-hidden />
        <p className="text-lg text-fg-1" data-testid="summary-building">
          Собираем отчёт…
        </p>
        <p className="max-w-xl text-sm text-fg-2">
          Документ собирается из готовых чисел источника: самодостаточный MNE.Report в той же
          теме, что автоотчёт записи.
        </p>
      </div>
    )
  }

  if (report) {
    const warnings = report.warnings ?? []
    return (
      <>
        <div className="flex flex-wrap items-center gap-2" data-testid="summary-strip">
          <StatusPill tone="accent">{report.title}</StatusPill>
          <StatusPill tone="neutral">Отчёт собран</StatusPill>
          {warnings.length > 0 ? (
            <StatusPill tone="warn" title={warnings.join(' · ')}>
              {`Предупреждений: ${warnings.length}`}
            </StatusPill>
          ) : null}
        </div>
        <iframe
          title={`Отчёт «${report.title}» (MNE.Report)`}
          src={`${report.html_url}?v=${report.report_version}`}
          data-testid="summary-frame"
          className="min-h-0 w-full flex-1 rounded-lg border border-border bg-white"
        />
      </>
    )
  }

  return (
    <Placeholder
      icon={<ClipboardList className="size-12" />}
      title={error ? 'Отчёт не собран' : 'Отчёт ещё не собран'}
      description={
        error
          ? 'Сборка завершилась ошибкой — текст ниже; повторите кнопкой «Собрать отчёт».'
          : selected
            ? 'Нажмите «Собрать отчёт» в шапке: выбор источника сам по себе ничего не считает.'
            : `Выберите ${sourceLabel} в панели справа — после выбора включится кнопка «Собрать отчёт».`
      }
    >
      {error ? (
        <p
          className="rounded-lg border border-danger/40 bg-bg-2 px-3 py-1.5 text-left text-sm text-fg-1"
          data-testid="summary-error"
        >
          {error}
        </p>
      ) : (
        <ul className="space-y-1 text-left text-sm text-fg-2">
          <li>• Документ — самодостаточный MNE.Report: печать и открытие в новой вкладке</li>
          <li>• Числа — те же, что в разделе «Групповой анализ» (сборка ничего не считает)</li>
        </ul>
      )}
    </Placeholder>
  )
}

export function SummarySection() {
  const recording = useEdfRecording((state) => state.recording)
  const result = useSummaryReport((state) => state.result)
  const job = useSummaryReport((state) => state.job)
  const error = useSummaryReport((state) => state.error)
  const reset = useSummaryReport((state) => state.reset)
  const kind = useSummaryReport((state) => state.kind)

  // Результат принадлежит записи: закрытие/смена записи сбрасывает его и
  // глушит поллинг прежней задачи (ответ старой записи не должен мигнуть в UI)
  const recordingId = recording?.recording_id ?? null
  const resultId = result?.recording_id ?? null
  useEffect(() => {
    if (resultId !== null && resultId !== recordingId) reset()
  }, [recordingId, resultId, reset])

  // Вид результата: документ (iframe) или клиентская динамика структур (часть 3)
  const [view, setView] = useState<'html' | 'dynamics' | 'roi'>('html')

  // Отчёты группового анализа (Тип 1/Тип 2): живут без открытой записи —
  // источник результат уже готов, документ собирается кнопкой в шапке
  if (kind === 'compare' || kind === 'group') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <KindSwitch />
        <GroupReportBody source={kind === 'compare' ? 'compare' : 'group'} />
      </div>
    )
  }

  if (recording === null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <KindSwitch />
        <div className="min-h-0 flex-1">
          <Placeholder
            icon={<ClipboardList className="size-12" />}
            title="Итоги — автоотчёт пайплайна"
            description="Отчёт собирается по файлу записи на сервере."
          >
            <p className="rounded-lg border border-border bg-bg-2 px-3 py-1.5 text-sm text-fg-2">
              Загрузите EDF в разделе «EDF» — запись должна быть в реестре просмотра.
            </p>
          </Placeholder>
        </div>
      </div>
    )
  }

  const running = job?.status === 'running' && result === null
  if (running && job) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <KindSwitch />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <ClipboardList className="size-12 text-accent" aria-hidden />
          <p className="text-lg text-fg-1" data-testid="summary-running">
            Собираем автоотчёт…
          </p>
          <p className="max-w-xl text-sm text-fg-2">{job.message}</p>
          <div
            role="progressbar"
            aria-label="Прогресс сборки автоотчёта"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(job.progress * 100)}
            className="h-2 w-72 overflow-hidden rounded-full bg-bg-3"
          >
            <span
              className="block h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${Math.round(job.progress * 100)}%` }}
            />
          </div>
          <p className="max-w-xl text-sm text-fg-2">
            Две части: качество и препроцессинг → пакет диполей по полосам → сборка MNE.Report.
            Отменить можно в шапке раздела.
          </p>
        </div>
      </div>
    )
  }

  if (result === null) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <KindSwitch />
        <div className="min-h-0 flex-1">
          <Placeholder
            icon={<ClipboardList className="size-12" />}
            title={error ? 'Отчёт не собран' : 'Отчёт ещё не собран'}
            description={
              error
                ? 'Задача завершилась ошибкой — текст ниже; параметры правятся в панели справа.'
                : 'Соберите отчёт кнопкой в шапке: правки параметров сами по себе ничего не считают.'
            }
          >
            {error ? (
              <p
                className="rounded-lg border border-danger/40 bg-bg-2 px-3 py-1.5 text-left text-sm text-fg-1"
                data-testid="summary-error"
              >
                {error}
              </p>
            ) : (
              <ul className="space-y-1 text-left text-sm text-fg-2">
                <li>• Часть 1 — светофор и числа QC, каналы, артефакты, фильтр, эпохи (как в EDF)</li>
                <li>• Часть 2 — быстрый расчёт диполей по каждой полосе пакета</li>
                <li>• Динамика структур и полей Бродмана по полосам (GOF между полосами не сравним)</li>
                <li>• Готовый документ — самодостаточный MNE.Report (HTML)</li>
              </ul>
            )}
          </Placeholder>
        </div>
      </div>
    )
  }

  const bands = result.bands ?? []
  const warnings = result.warnings ?? []
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <KindSwitch />
      <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" data-testid="summary-strip">
        <StatusPill tone={QC_TONES[result.qc.status] ?? 'neutral'}>
          {QC_LABELS[result.qc.status] ?? `QC: ${result.qc.status}`}
        </StatusPill>
        <StatusPill tone="neutral">
          {`Эпох: ${result.n_epochs_used} из ${result.n_epochs_total}`}
        </StatusPill>
        <StatusPill tone="neutral">{`Полос пакета: ${bands.length}`}</StatusPill>
        <StatusPill tone="neutral">{`Отклонено эпох: ${result.rejected_epochs}`}</StatusPill>
        <StatusPill tone="accent">
          {`Чистые данные: ${result.qc.good_data_percent.toFixed(1)} %`}
        </StatusPill>
        {warnings.length > 0 ? (
          <StatusPill tone="warn" title={warnings.join(' · ')}>
            {`Предупреждений: ${warnings.length}`}
          </StatusPill>
        ) : null}
        <span className="tnum ml-auto text-sm text-fg-2">
          {`расчёт: ${result.duration_sec_calc.toFixed(1)} с`}
        </span>
      </div>
      {/* Часть 3 (§3.9.6): документ MNE.Report и клиентская динамика структур —
          два вида одного результата; переключение только рисует, ничего не считает */}
      <div className="flex gap-1" role="tablist" aria-label="Вид результата отчёта">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'html'}
          onClick={() => setView('html')}
          data-testid="summary-view-html"
          className={
            view === 'html'
              ? 'rounded-t-lg border border-border bg-bg-2 px-3 py-1 text-sm text-fg-1'
              : 'rounded-t-lg border border-transparent px-3 py-1 text-sm text-fg-2 hover:text-fg-1'
          }
        >
          Документ
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'dynamics'}
          onClick={() => setView('dynamics')}
          data-testid="summary-view-dynamics"
          className={
            view === 'dynamics'
              ? 'rounded-t-lg border border-border bg-bg-2 px-3 py-1 text-sm text-fg-1'
              : 'rounded-t-lg border border-transparent px-3 py-1 text-sm text-fg-2 hover:text-fg-1'
          }
        >
          Динамика структур
        </button>
        {/* ROI (4.5): агрегат тех же точек пакета — вид одного результата,
            переключение вкладки только рисует (запросов не делает) */}
        <button
          type="button"
          role="tab"
          aria-selected={view === 'roi'}
          onClick={() => setView('roi')}
          data-testid="summary-view-roi"
          className={
            view === 'roi'
              ? 'rounded-t-lg border border-border bg-bg-2 px-3 py-1 text-sm text-fg-1'
              : 'rounded-t-lg border border-transparent px-3 py-1 text-sm text-fg-2 hover:text-fg-1'
          }
        >
          ROI
        </button>
      </div>
      {view === 'html' ? (
        <iframe
          title="Автоотчёт DipLock (MNE.Report)"
          src={`${result.html_url}?v=${result.report_version}`}
          data-testid="summary-frame"
          className="min-h-0 w-full flex-1 rounded-lg border border-border bg-white"
        />
      ) : view === 'roi' ? (
        <SummaryRoi roi={result.roi ?? null} />
      ) : (
        <SummaryDynamics bands={bands} />
      )}
      </div>
    </div>
  )
}
