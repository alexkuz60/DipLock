/**
 * Раскрытая строка таблицы «БД»: карточка готовности одной записи — стадии с
 * полными параметрами и историей прогонов.
 *
 * Запрос идёт **лениво** — только по раскрытию строки (`GET
 * /recordings/{id}/readiness`); страница держит лишь сводки последних прогонов.
 * «—» в параметрах означает «не измерено» (инвариант read-API), поэтому в
 * карточке показываются заполненные строки: десятки прочерков читались бы как
 * ошибка, а не как «в этом прогоне этого не было».
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import {
  STAGE_ORDER,
  formatDate,
  stageLabel,
  stageParamLines,
} from '@/shared/lib/dbTable'
import { StatusPill } from '@/shared/ui/StatusPill'
import { cx } from '@/shared/ui/cx'

export function DbReadinessDetail({ recordingId }: { recordingId: string }) {
  const query = useQuery({
    queryKey: ['recording-readiness', recordingId],
    queryFn: ({ signal }) => api.recordingReadiness(recordingId, signal),
  })

  if (query.isPending) {
    return <p className="px-3 py-2 text-sm text-fg-2">Загрузка карточки готовности…</p>
  }
  if (query.isError || !query.data) {
    return (
      <StatusPill tone="danger">
        {`Не удалось прочитать карточку готовности: ${String(query.error)}`}
      </StatusPill>
    )
  }
  const detail = query.data
  const stages = STAGE_ORDER.map(
    (key) => (detail.stages ?? []).find((stage) => stage.stage === key) ?? null,
  ).filter((stage): stage is NonNullable<typeof stage> => stage !== null)

  return (
    <div className="space-y-4 px-3 py-3" data-testid={`db-detail-${recordingId}`}>
      {stages.map((stage) => {
        const runs = stage.runs ?? []
        const lines = stageParamLines(stage.params).filter((line) => line.value !== '—')
        return (
          <section key={stage.stage} data-testid={`db-detail-stage-${stage.stage}`}>
            <div className="flex items-center gap-2">
              <h4 className="text-base font-semibold text-fg-0">{stageLabel(stage.stage)}</h4>
              <StatusPill tone={stage.state === 'ready' ? 'ok' : 'neutral'}>
                {stage.state === 'ready' ? 'готово' : 'нет результатов'}
              </StatusPill>
              <StatusPill tone="neutral">
                {`прогонов: ${stage.n_runs}${stage.last_run_at ? ` · последний ${formatDate(stage.last_run_at)}` : ''}`}
              </StatusPill>
            </div>
            {lines.length > 0 ? (
              <dl className="mt-1 grid grid-cols-[minmax(160px,auto)_1fr] gap-x-4 gap-y-0.5 text-sm">
                {lines.map((line) => (
                  <div key={line.label} className="contents">
                    <dt className="text-fg-2">{line.label}</dt>
                    <dd className="tnum text-fg-1">{line.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-1 text-sm text-fg-2">Параметры прогона не записаны.</p>
            )}
            {runs.length > 0 ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-sm text-fg-2">
                  {`История прогонов (${runs.length})`}
                </summary>
                <ul className="mt-1 list-inside list-disc text-sm text-fg-1">
                  {runs.map((run, index) => (
                    <li
                      key={`${run.job_id ?? 'run'}-${run.created_at ?? index}`}
                      className={cx('tnum')}
                    >
                      {formatDate(run.created_at)}
                      {run.job_id ? ` · задача ${run.job_id}` : ''}
                      {run.params_sig ? ` · отпечаток ${run.params_sig}` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}