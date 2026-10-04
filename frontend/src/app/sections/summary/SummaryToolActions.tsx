/**
 * Тулс-хедер раздела «Итоги»: сборка отчёта по кнопке, прогресс задачи,
 * отмена (3.2) и открытие готового HTML в новой вкладке.
 *
 * Правила как в «Диполях»: расчёт стартует **только кнопкой** (правка полосы
 * или сетки ничего не запускает), пока идёт задача — полоса прогресса с
 * сообщением этапа (части 1 и 2, номер полосы пакета видны в сообщении), а
 * без записи кнопка выключена с объяснением: отчёт собирается по файлу на
 * сервере. Ссылка на HTML доступна только с результатом и несёт `?v=` —
 * версию ассета, чтобы браузер не держал прошлый отчёт.
 */
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, FileText } from 'lucide-react'
import { api } from '@/shared/api/client'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useSummaryReport } from '@/shared/state/summaryReport'
import { Button } from '@/shared/ui/Button'
import { CancelJobButton } from '@/shared/ui/CancelJobButton'
import { cx } from '@/shared/ui/cx'

/** Пояснение к выключенной кнопке, когда записи ещё нет */
const NO_RECORDING_HINT =
  'Сначала загрузите EDF в разделе EDF: отчёт собирается по файлу записи на сервере.'

export function SummaryToolActions() {
  const recording = useEdfRecording((state) => state.recording)
  const job = useSummaryReport((state) => state.job)
  const result = useSummaryReport((state) => state.result)
  const bandKeys = useSummaryReport((state) => state.bandKeys)
  const run = useSummaryReport((state) => state.run)
  const cancel = useSummaryReport((state) => state.cancel)
  const kind = useSummaryReport((state) => state.kind)
  const compareJobId = useSummaryReport((state) => state.compareJobId)
  const compareReport = useSummaryReport((state) => state.compareReport)
  const compareBuilding = useSummaryReport((state) => state.compareBuilding)
  const buildCompareReport = useSummaryReport((state) => state.buildCompareReport)
  const groupRunId = useSummaryReport((state) => state.groupRunId)
  const groupReport = useSummaryReport((state) => state.groupReport)
  const groupBuilding = useSummaryReport((state) => state.groupBuilding)
  const buildGroupReport = useSummaryReport((state) => state.buildGroupReport)

  // Метаданные — только для подсказки (список полос рисует панель)
  useQuery({ queryKey: ['meta'], queryFn: () => api.meta() })

  // Отчёты группового анализа (Тип 1/Тип 2): сборка — ленивый GET готовых
  // чисел (без задачи и поллинга), поэтому вместо полосы прогресса — состояние
  // кнопки, а документ открывается той же ссылкой «Открыть отчёт».
  if (kind === 'compare' || kind === 'group') {
    const isCompare = kind === 'compare'
    const selected = isCompare ? compareJobId : groupRunId
    const building = isCompare ? compareBuilding : groupBuilding
    const report = isCompare ? compareReport : groupReport
    const typeLabel = isCompare ? 'Тип 1 (сравнение двух записей)' : 'Тип 2 (прогон группы)'
    return (
      <div className="flex items-center gap-2">
        <Button
          icon={<FileText className="size-4" />}
          disabled={!selected || building}
          title={
            !selected
              ? 'Сначала выберите источник отчёта в панели справа.'
              : building
                ? 'Идёт сборка документа…'
                : `Собрать самодостаточный HTML-отчёт: ${typeLabel}`
          }
          onClick={() => void (isCompare ? buildCompareReport() : buildGroupReport())}
          data-testid="summary-run"
        >
          {building ? 'Собираем…' : report ? 'Пересобрать отчёт' : 'Собрать отчёт'}
        </Button>
        {report ? (
          <a
            href={`${report.html_url}?v=${report.report_version}`}
            target="_blank"
            rel="noreferrer"
            title="Открыть самодостаточный HTML MNE.Report в новой вкладке"
            data-testid="summary-open"
            className={cx(
              'inline-flex items-center gap-2 rounded-lg border border-border bg-bg-2 px-3 py-1.5',
              'text-sm text-fg-1 transition-colors hover:border-accent hover:text-accent',
            )}
          >
            <ExternalLink className="size-4" aria-hidden />
            Открыть отчёт
          </a>
        ) : null}
      </div>
    )
  }

  const running = job?.status === 'running'
  const noBands = bandKeys !== null && bandKeys.length === 0
  const disabledHint = !recording
    ? NO_RECORDING_HINT
    : noBands
      ? 'В панели не выбрана ни одна полоса пакета: отчёт по пустому набору собирать нечего.'
      : ''

  return (
    <div className="flex items-center gap-2">
      {running ? (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <div
              role="progressbar"
              aria-label="Прогресс сборки автоотчёта"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(job.progress * 100)}
              className="h-2 w-28 overflow-hidden rounded-full bg-bg-3"
            >
              <span
                data-testid="summary-progress-fill"
                className="block h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.round(job.progress * 100)}%` }}
              />
            </div>
            <span className="tnum hidden text-sm text-fg-2 xl:inline">
              {`${Math.round(job.progress * 100)} %`}
            </span>
          </div>
          <span
            className="max-w-64 truncate text-sm text-fg-2"
            title={job.message}
            data-testid="summary-progress-message"
          >
            {job.message}
          </span>
          <CancelJobButton onCancel={cancel} />
        </div>
      ) : (
        <Button
          icon={<FileText className="size-4" />}
          disabled={!recording || noBands}
          title={
            disabledHint ||
            'Собрать сквозной отчёт: качество и препроцессинг (часть 1) + диполи по полосам (часть 2), MNE.Report'
          }
          onClick={() => void run(recording?.recording_id ?? null)}
          data-testid="summary-run"
        >
          {result ? 'Пересобрать отчёт' : 'Собрать отчёт'}
        </Button>
      )}

      {result ? (
        <a
          href={`${result.html_url}?v=${result.report_version}`}
          target="_blank"
          rel="noreferrer"
          title="Открыть самодостаточный HTML MNE.Report в новой вкладке"
          data-testid="summary-open"
          className={cx(
            'inline-flex items-center gap-2 rounded-lg border border-border bg-bg-2 px-3 py-1.5',
            'text-sm text-fg-1 transition-colors hover:border-accent hover:text-accent',
          )}
        >
          <ExternalLink className="size-4" aria-hidden />
          Открыть отчёт
        </a>
      ) : null}
    </div>
  )
}
