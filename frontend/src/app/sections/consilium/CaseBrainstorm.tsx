/**
 * Мозговой штурм (срез 0012): идеи и резюме по снимку досье.
 *
 * Запуск — только кнопкой; растущий текст идёт стримом (механизм 0011),
 * готовый результат читается поллингом из БД. Резюме раскрывается кнопкой
 * в досье; идеи — карточки шага §7 с внесением в библиотеку исследования.
 * Правка и раскрытие ничего не запускают (`docs/rules/frontend-state.md`).
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type {
  ConsiliumBrainstorm,
  ConsiliumBrainstormIdea,
  ConsiliumCase,
  ConsiliumProposalCreate,
} from '@/shared/api/types'
import {
  applyStreamEvent,
  emptyLiveRound,
  subscribeBrainstormStream,
  type LiveRound,
} from '@/shared/lib/roundStream'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { StatusPill } from '@/shared/ui/StatusPill'
import { QueryState } from './common'
import { useCaseAction } from './useCaseAction'

const KIND_LABELS: Record<string, string> = {
  ask_volunteer: 'спросить добровольца',
  clarify_observation: 'уточнить наблюдение',
  run_probe: 'провести пробу',
  run_calculation: 'выполнить расчёт',
}

/** Карточка идеи штурма: вид шага §7, основание и способ проверки. */
function IdeaCard({
  idea,
  onImport,
  importing,
}: {
  idea: ConsiliumBrainstormIdea
  onImport: (idea: ConsiliumBrainstormIdea) => void
  importing: boolean
}) {
  return (
    <article className="space-y-1 rounded-lg border border-border p-3" data-testid="brainstorm-idea">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">{idea.title}</span>
        <StatusPill tone="accent">{KIND_LABELS[idea.kind] ?? idea.kind}</StatusPill>
      </header>
      {idea.rationale && <p className="text-sm text-fg-1">Основание: {idea.rationale}</p>}
      {idea.hypothesis && <p className="text-sm text-fg-1">Гипотеза: {idea.hypothesis}</p>}
      {idea.risks && <p className="text-sm text-fg-2">Риски: {idea.risks}</p>}
      {idea.check_method && <p className="text-sm text-fg-2">Проверка: {idea.check_method}</p>}
      <Button disabled={importing} onClick={() => onImport(idea)}>
        Внести в библиотеку
      </Button>
    </article>
  )
}

/** Карточка запуска штурма: резюме, идеи и честный сырой текст ответа. */
function BrainstormCard({
  run,
  liveText,
  onImport,
  importing,
}: {
  run: ConsiliumBrainstorm
  liveText: string
  onImport: (idea: ConsiliumBrainstormIdea) => void
  importing: boolean
}) {
  const running = run.status === 'running'
  const draft = run.draft ?? (running ? liveText : '')
  const ideas = run.ideas ?? []
  return (
    <article className="space-y-2 rounded-lg border border-border p-3" data-testid="brainstorm-card">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">Мозговой штурм</span>
        <span className="text-fg-2">{run.model ?? 'модель неизвестна'}</span>
        <span className="text-fg-2">{new Date(run.created_at).toLocaleString('ru')}</span>
        {running && (
          <span role="status" className="text-fg-2">
            Модель отвечает…
          </span>
        )}
      </header>
      {run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted' ? (
        <p role="alert" className="text-sm text-danger">
          {run.error ?? 'Запуск не завершён'}
        </p>
      ) : null}
      {draft && (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-bg-2 p-2 text-sm text-fg-1">
          {draft}
        </pre>
      )}
      {run.summary && (
        <details open data-testid="brainstorm-summary">
          <summary className="cursor-pointer text-accent">Резюме досье</summary>
          <p className="whitespace-pre-wrap text-fg-1">{run.summary}</p>
        </details>
      )}
      {ideas.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Идеи ({ideas.length})</h4>
          {ideas.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} onImport={onImport} importing={importing} />
          ))}
        </div>
      )}
      {(run.warnings ?? []).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-fg-2">
          {(run.warnings ?? []).map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </article>
  )
}

export function CaseBrainstorm({ current }: { current: ConsiliumCase }) {
  const readOnly = current.status !== 'open'
  const brainstorms = useQuery({
    queryKey: ['consilium', current.id, 'brainstorms'],
    queryFn: ({ signal }) => consiliumApi.brainstorms(current.id, 0, signal),
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'running') ? 2000 : false,
  })
  const snapshots = useQuery({
    queryKey: ['consilium', current.id, 'snapshots'],
    queryFn: ({ signal }) => consiliumApi.snapshots(current.id, 0, signal),
    gcTime: 0,
  })
  const run = useCaseAction<string>(current.id, (snapshotId) =>
    consiliumApi.runBrainstorm(current.id, {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      snapshot_id: snapshotId,
    }),
  )
  const importIdea = useCaseAction<ConsiliumProposalCreate>(current.id, (payload) =>
    consiliumApi.addProposal(current.id, payload),
  )

  const items = brainstorms.data?.items ?? []
  const snapshotId = snapshots.data?.items[0]?.id || ''
  const runningId = items.find((item) => item.status === 'running')?.id ?? ''
  const [live, setLive] = useState<LiveRound | null>(null)
  // Живой стрим (механизм 0011): растущий текст виден сразу; готовый результат
  // всё равно приходит поллингом из БД (стрим — только удобство)
  useEffect(() => {
    if (!runningId) return
    setLive(emptyLiveRound(runningId))
    return subscribeBrainstormStream(current.id, runningId, (event) => {
      setLive((previous) => applyStreamEvent(previous, runningId, event))
    })
  }, [current.id, runningId])

  function importToLibrary(idea: ConsiliumBrainstormIdea) {
    importIdea.mutate({
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      source: 'brainstorm',
      source_id: idea.id,
      kind: idea.kind,
      title: idea.title,
      hypothesis: idea.hypothesis ?? undefined,
      rationale: idea.rationale ?? undefined,
      risks: idea.risks ?? undefined,
      check_method: idea.check_method ?? undefined,
    })
  }

  const liveText = runningId ? (live?.roles.brainstorm?.text ?? '') : ''

  return (
    <section className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="font-semibold">Мозговой штурм</h3>
      <p className="text-sm text-fg-2">
        Идеи шагов и резюме по опубликованному снимку досье: что спросить у добровольца,
        что уточнить, какие пробы и расчёты провести. Запуск — только кнопкой; наружу уходит
        тот же сжатый дайджест, что и советникам. Идеи — подсказки, а не назначения:
        в библиотеку их вносит исследователь.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={readOnly || run.isPending || !snapshotId}
          onClick={() => run.mutate(snapshotId)}
        >
          {run.isPending ? 'Запуск…' : 'Запустить мозговой штурм'}
        </Button>
        {!snapshotId && snapshots.data && (
          <span className="text-sm text-fg-2">Сначала опубликуйте снимок досье</span>
        )}
      </div>
      {run.error != null && <ErrorBlock message={apiErrorText(run.error)} />}
      {importIdea.error != null && <ErrorBlock message={apiErrorText(importIdea.error)} />}
      {importIdea.isSuccess && (
        <p role="status" className="text-sm text-fg-2">
          Идея внесена в библиотеку исследования
        </p>
      )}
      <QueryState
        loading={brainstorms.isPending}
        error={brainstorms.error}
        retry={() => {
          void brainstorms.refetch()
        }}
      />
      {items.length === 0 && brainstorms.data && (
        <p className="text-sm text-fg-2">Штурм ещё не запускался.</p>
      )}
      {items.slice(0, 1).map((item) => (
        <BrainstormCard
          key={item.id}
          run={item}
          liveText={liveText}
          onImport={importToLibrary}
          importing={importIdea.isPending}
        />
      ))}
      {items.length > 1 && (
        <details>
          <summary className="cursor-pointer text-accent">Раньше ({items.length - 1})</summary>
          <div className="space-y-2 pt-2">
            {items.slice(1).map((item) => (
              <BrainstormCard
                key={item.id}
                run={item}
                liveText=""
                onImport={importToLibrary}
                importing={importIdea.isPending}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  )
}