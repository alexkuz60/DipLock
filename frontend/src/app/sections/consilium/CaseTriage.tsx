/**
 * Триаж готовности досье (Jev, §5.2): быстрые типизированные решения до раунда.
 *
 * Запуск — только кнопкой; уверенность калибрована, но не гарантирует
 * правильность — карточка честно подписывает вероятность и порог настроек.
 */
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type { ConsiliumCase, ConsiliumTriage, ConsiliumTriageCreate } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { QueryState } from './common'
import { useCaseAction } from './useCaseAction'

const DEFICIT_LABELS: Record<string, string> = {
  no_measurements: 'нет измерений и расчётов (спектр, диполи и т.п.)',
  no_volunteer_report: 'нет рассказа добровольца о переживании',
  no_observations: 'нет наблюдений исследователя об условиях',
  incompatible_parameters: 'материалы несопоставимы или не отвечают на вопрос',
  no_deficit: 'заметного дефицита нет',
}

/** Карточка результата триажа: решения, честные подписи и предупреждения досье. */
function TriageCard({ triage }: { triage: ConsiliumTriage }) {
  return (
    <article className="space-y-1 rounded-lg border border-border p-3" data-testid="triage-card">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">Триаж досье</span>
        <span className="text-fg-2">{triage.model ?? 'модель неизвестна'}</span>
        <span className="text-fg-2">{new Date(triage.created_at).toLocaleString('ru')}</span>
        {triage.latency_ms != null && (
          <span className="text-fg-2">{Math.round(triage.latency_ms)} мс</span>
        )}
      </header>
      {triage.status === 'failed' ? (
        <p role="alert" className="text-sm text-danger">
          Решения не получены: {triage.error ?? 'неизвестная ошибка'}
        </p>
      ) : (
        <div className="space-y-1 text-sm text-fg-1">
          <p>
            {triage.sufficient === true
              ? '✓ Материалов достаточно для осмысленного обсуждения'
              : triage.sufficient === false
                ? '⚠ Досье неполно — советники могут честно ответить «данных недостаточно»'
                : 'Вердикт не вынесен: ответ классификатора не разобран'}
            {triage.sufficient_prob != null && (
              <span className="text-fg-2">
                {' '}
                (калиброванная вероятность {Math.round(triage.sufficient_prob * 100)}%)
              </span>
            )}
          </p>
          {triage.deficit && (
            <p>
              Основной дефицит: {DEFICIT_LABELS[triage.deficit] ?? triage.deficit}
              {triage.deficit_confidence != null && (
                <span className="text-fg-2">
                  {' '}
                  (уверенность {Math.round(triage.deficit_confidence * 100)}%)
                </span>
              )}
            </p>
          )}
          {triage.completeness_score != null && (
            <p>Полнота досье: {triage.completeness_score} из 3</p>
          )}
          <p className="text-fg-2">
            Уверенность калибрована, но не гарантирует правильность; вердикт вынесен по порогу
            настроек сервера.
          </p>
        </div>
      )}
      {(triage.warnings ?? []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-2">
          {(triage.warnings ?? []).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </article>
  )
}

export function CaseTriage({
  current,
  snapshotId,
}: {
  current: ConsiliumCase
  snapshotId: string
}) {
  const readOnly = current.status !== 'open'
  const triage = useQuery({
    queryKey: ['consilium', current.id, 'triage'],
    queryFn: ({ signal }) => consiliumApi.triage(current.id, 0, signal),
    gcTime: 0,
  })
  const run = useCaseAction<string>(current.id, (snapshot) => {
    const payload: ConsiliumTriageCreate = {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      snapshot_id: snapshot,
    }
    return consiliumApi.runTriage(current.id, payload)
  })

  const items = triage.data?.items ?? []
  const latest = snapshotId ? (items.find((item) => item.snapshot_id === snapshotId) ?? null) : null

  return (
    <section className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="font-semibold">Готовность досье (Jev)</h3>
      <p className="text-sm text-fg-2">
        Быстрая проверка материалов решающим классификатором: достаточно ли их для осмысленного
        ответа советников и чего не хватает. Запуск — только кнопкой; наружу уходит тот же
        сжатый дайджест, что и советникам (контекст без разрешения не передаётся).
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={readOnly || run.isPending || !snapshotId}
          onClick={() => run.mutate(snapshotId)}
        >
          {run.isPending ? 'Проверка…' : 'Проверить готовность досье'}
        </Button>
        {run.isPending ? (
          <span role="status" className="text-sm text-fg-2">
            Запрос к решающему классификатору…
          </span>
        ) : null}
      </div>
      {run.error != null && <ErrorBlock message={apiErrorText(run.error)} />}
      <QueryState
        loading={triage.isPending}
        error={triage.error}
        retry={() => {
          void triage.refetch()
        }}
      />
      {latest ? (
        <TriageCard triage={latest} />
      ) : (
        triage.data && (
          <p className="text-sm text-fg-2">
            Триаж этого снимка ещё не запускался — проверьте досье до обсуждения.
          </p>
        )
      )}
    </section>
  )
}