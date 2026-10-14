/**
 * Разметка ответа советника (Jev, §5.3): карточка предложения и источники.
 *
 * Запуск — только кнопками; метки — advisory-подсказки с явным порогом, не
 * вердикты и не оценки ответа. Три источника утверждений не смешиваются.
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type { ConsiliumAnswer, ConsiliumCase, ConsiliumJevMark } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { QueryState } from './common'
import { claimSources, proposalFields, proposalStepKinds } from './options'
import { useCaseAction } from './useCaseAction'

/** Одна строка метки: подпись, вероятность и серверный вердикт порога. */
function MarkRow({
  name,
  prob,
  present,
  labels,
}: {
  name: string
  prob: number
  present: boolean
  labels: readonly { value: string; label: string }[]
}) {
  return (
    <li>
      {labels.find((item) => item.value === name)?.label ?? name}:{' '}
      {present ? '✓' : '—'} ({Math.round(prob * 100)}%)
    </li>
  )
}

/** Общая карточка метки: заголовок, статус и честная оговорка. */
function MarkCard({ mark, title, children }: { mark: ConsiliumJevMark; title: string; children?: ReactNode }) {
  return (
    <article className="space-y-1 rounded-lg border border-border p-2" data-testid={`jev-mark-${mark.kind}`}>
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">{title}</span>
        <span className="text-fg-2">{mark.model ?? 'модель неизвестна'}</span>
        {mark.latency_ms != null && (
          <span className="text-fg-2">{Math.round(mark.latency_ms)} мс</span>
        )}
      </header>
      {mark.status === 'failed' ? (
        <p role="alert" className="text-sm text-danger">
          Метки не получены: {mark.error ?? 'неизвестная ошибка'}
        </p>
      ) : (
        <div className="space-y-1 text-sm text-fg-1">
          {children}
          <p className="text-fg-2">
            Подсказка решающего классификатора, не вердикт и не оценка ответа.
          </p>
        </div>
      )}
      {(mark.warnings ?? []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-2">
          {(mark.warnings ?? []).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </article>
  )
}

export function AnswerJevMarks({
  current,
  answer,
}: {
  current: ConsiliumCase
  answer: ConsiliumAnswer
}) {
  const readOnly = current.status !== 'open'
  const marks = useQuery({
    queryKey: ['consilium', current.id, 'jev-marks', answer.id],
    queryFn: ({ signal }) => consiliumApi.jevMarks(current.id, undefined, answer.id, signal),
    gcTime: 0,
  })
  const proposal = useCaseAction<string>(current.id, (answerId) =>
    consiliumApi.runProposalMark(current.id, {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      answer_id: answerId,
    }),
  )
  const sources = useCaseAction<string>(current.id, (answerId) =>
    consiliumApi.runSourceMarks(current.id, {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      answer_id: answerId,
    }),
  )

  const items = marks.data?.items ?? []
  const proposalMark = items.find((item) => item.kind === 'proposal') ?? null
  const sourcesMark = items.find((item) => item.kind === 'source_marks') ?? null
  const busy = proposal.isPending || sources.isPending

  return (
    <section className="space-y-2 rounded-lg border border-border p-2">
      <h4 className="text-sm font-medium">Разметка ответа (Jev)</h4>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          disabled={readOnly || busy || answer.status !== 'ok'}
          onClick={() => proposal.mutate(answer.id)}
        >
          {proposal.isPending ? 'Разметка…' : 'Карточка предложения'}
        </Button>
        <Button
          variant="ghost"
          disabled={readOnly || busy || answer.status !== 'ok'}
          onClick={() => sources.mutate(answer.id)}
        >
          {sources.isPending ? 'Разметка…' : 'Источники утверждений'}
        </Button>
      </div>
      {proposal.error != null && <ErrorBlock message={apiErrorText(proposal.error)} />}
      {sources.error != null && <ErrorBlock message={apiErrorText(sources.error)} />}
      <QueryState
        loading={marks.isPending}
        error={marks.error}
        retry={() => {
          void marks.refetch()
        }}
      />
      {proposalMark && (
        <MarkCard mark={proposalMark} title="Карточка предложения">
          <p>
            Вид шага:{' '}
            {proposalStepKinds.find((item) => item.value === proposalMark.choice)?.label ??
              proposalMark.choice ??
              'не разобран'}
          </p>
          <ul className="list-disc space-y-0.5 pl-5">
            {Object.entries(proposalMark.probs ?? {}).map(([name, prob]) => (
              <MarkRow
                key={name}
                name={name}
                prob={prob}
                present={(proposalMark.present ?? []).includes(name)}
                labels={proposalFields}
              />
            ))}
          </ul>
        </MarkCard>
      )}
      {sourcesMark && (
        <MarkCard mark={sourcesMark} title="Источники утверждений">
          <ul className="list-disc space-y-0.5 pl-5">
            {Object.entries(sourcesMark.probs ?? {}).map(([name, prob]) => (
              <MarkRow
                key={name}
                name={name}
                prob={prob}
                present={(sourcesMark.present ?? []).includes(name)}
                labels={claimSources}
              />
            ))}
          </ul>
          <p className="text-fg-2">Три источника не смешиваются: каждая строка — отдельный вопрос.</p>
        </MarkCard>
      )}
    </section>
  )
}