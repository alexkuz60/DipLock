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

  // Метаданные — только для подсказки (список полос рисует панель)
  useQuery({ queryKey: ['meta'], queryFn: () => api.meta() })

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
