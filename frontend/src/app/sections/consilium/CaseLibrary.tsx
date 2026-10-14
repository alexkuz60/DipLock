/**
 * Библиотека исследования (Т5, срез 0013): карточки исследовательских предложений.
 *
 * Жизненный цикл (§7 `docs/rules/consilium.md`): предложение → решение человека
 * («принято»/«отклонено», append-only) → ручное исполнение и результат. Правка
 * карточки даёт новую версию — старые решения остаются и адресуют свою версию.
 * Запусков расчётов здесь нет: исполнение — вручную в существующих разделах.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type {
  ConsiliumBrainstormKind,
  ConsiliumCase,
  ConsiliumProposal,
} from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { FieldRow } from '@/shared/ui/FieldRow'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { StatusPill } from '@/shared/ui/StatusPill'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { PageButtons, QueryState, TextArea } from './common'
import { useCaseAction } from './useCaseAction'

const KIND_OPTIONS: { value: ConsiliumBrainstormKind; label: string }[] = [
  { value: 'ask_volunteer', label: 'спросить добровольца' },
  { value: 'clarify_observation', label: 'уточнить наблюдение' },
  { value: 'run_probe', label: 'провести пробу' },
  { value: 'run_calculation', label: 'выполнить расчёт' },
]

const SOURCE_LABELS: Record<string, string> = {
  brainstorm: 'из мозгового штурма',
  advisor: 'из ответа советника',
  manual: 'внесено вручную',
}

type ProposalDraft = {
  kind: ConsiliumBrainstormKind
  title: string
  hypothesis: string
  rationale: string
  risks: string
  checkMethod: string
}

const EMPTY_DRAFT: ProposalDraft = {
  kind: 'run_probe',
  title: '',
  hypothesis: '',
  rationale: '',
  risks: '',
  checkMethod: '',
}

/** Форма карточки (создание и правка): вид шага §7 и поля основания/проверки. */
function ProposalForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: ProposalDraft
  submitLabel: string
  pending: boolean
  onSubmit: (draft: ProposalDraft) => void
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState<ProposalDraft>(initial)
  const patch = (changes: Partial<ProposalDraft>) => setDraft({ ...draft, ...changes })
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <SegmentedControl
        label="Вид шага"
        value={draft.kind}
        onChange={(kind) => patch({ kind })}
        options={KIND_OPTIONS}
        disabled={pending}
      />
      <FieldRow label="Название" htmlFor="proposal-title">
        <input
          id="proposal-title"
          value={draft.title}
          disabled={pending}
          maxLength={300}
          onChange={(event) => patch({ title: event.target.value })}
          className="w-full rounded-lg border border-border bg-bg-2 p-2 text-fg-0 disabled:opacity-40"
        />
      </FieldRow>
      <TextArea
        label="Основание"
        value={draft.rationale}
        disabled={pending}
        onChange={(text) => patch({ rationale: text })}
      />
      <TextArea
        label="Гипотеза"
        value={draft.hypothesis}
        disabled={pending}
        onChange={(text) => patch({ hypothesis: text })}
      />
      <TextArea
        label="Риски и ограничения"
        value={draft.risks}
        disabled={pending}
        onChange={(text) => patch({ risks: text })}
      />
      <TextArea
        label="Способ проверки"
        value={draft.checkMethod}
        disabled={pending}
        onChange={(text) => patch({ checkMethod: text })}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={pending || !draft.title.trim()}
          onClick={() => onSubmit(draft)}
        >
          {submitLabel}
        </Button>
        {onCancel && (
          <Button disabled={pending} onClick={onCancel}>
            Отмена
          </Button>
        )}
      </div>
    </div>
  )
}

/** Карточка предложения: поля §7, решения и исполнения — append-only история. */
function ProposalCard({
  proposal,
  caseVersion,
  readOnly,
}: {
  proposal: ConsiliumProposal
  caseVersion: number
  readOnly: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [comment, setComment] = useState('')
  const [note, setNote] = useState('')
  const [result, setResult] = useState('')
  const decide = useCaseAction<{ decision: 'accepted' | 'rejected' }>(proposal.case_id, (value) =>
    consiliumApi.decideProposal(proposal.case_id, proposal.id, {
      request_id: crypto.randomUUID(),
      expected_version: caseVersion,
      decision: value.decision,
      comment: comment.trim() || undefined,
    }),
  )
  const execute = useCaseAction(proposal.case_id, () =>
    consiliumApi.executeProposal(proposal.case_id, proposal.id, {
      request_id: crypto.randomUUID(),
      expected_version: caseVersion,
      note: note.trim(),
      result: result.trim() || undefined,
    }),
  )
  const update = useCaseAction<ProposalDraft>(proposal.case_id, (draft) =>
    consiliumApi.updateProposal(proposal.case_id, proposal.id, {
      request_id: crypto.randomUUID(),
      expected_version: caseVersion,
      kind: draft.kind,
      title: draft.title,
      hypothesis: draft.hypothesis.trim() || undefined,
      rationale: draft.rationale.trim() || undefined,
      risks: draft.risks.trim() || undefined,
      check_method: draft.checkMethod.trim() || undefined,
    }),
  )
  const decisions = proposal.decisions ?? []
  const executions = proposal.executions ?? []
  const latest = decisions[0]
  return (
    <article className="space-y-2 rounded-lg border border-border p-3" data-testid="proposal-card">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">{proposal.title}</span>
        <StatusPill tone="accent">
          {KIND_OPTIONS.find((item) => item.value === proposal.kind)?.label ?? proposal.kind}
        </StatusPill>
        <StatusPill tone={latest?.decision === 'accepted' ? 'ok' : latest ? 'warn' : 'neutral'}>
          {latest?.decision === 'accepted'
            ? 'принято'
            : latest?.decision === 'rejected'
              ? 'отклонено'
              : 'без решения'}
        </StatusPill>
        <span className="text-fg-2">
          версия {proposal.version} · {SOURCE_LABELS[proposal.source] ?? proposal.source}
        </span>
      </header>
      {proposal.rationale && <p className="text-sm text-fg-1">Основание: {proposal.rationale}</p>}
      {proposal.hypothesis && <p className="text-sm text-fg-1">Гипотеза: {proposal.hypothesis}</p>}
      {proposal.risks && <p className="text-sm text-fg-2">Риски: {proposal.risks}</p>}
      {proposal.check_method && (
        <p className="text-sm text-fg-2">Проверка: {proposal.check_method}</p>
      )}
      {editing ? (
        <ProposalForm
          initial={{
            kind: proposal.kind,
            title: proposal.title,
            hypothesis: proposal.hypothesis ?? '',
            rationale: proposal.rationale ?? '',
            risks: proposal.risks ?? '',
            checkMethod: proposal.check_method ?? '',
          }}
          submitLabel="Сохранить новую версию"
          pending={update.isPending}
          onSubmit={(draft) => {
            update.mutate(draft, { onSuccess: () => setEditing(false) })
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        !readOnly && (
          <Button
            onClick={() => {
              setEditing(true)
              decide.reset()
              execute.reset()
              update.reset()
            }}
          >
            Исправить карточку
          </Button>
        )
      )}
      {(decide.error ?? execute.error ?? update.error) != null && (
        <ErrorBlock message={apiErrorText(decide.error ?? execute.error ?? update.error)} />
      )}
      {decisions.length > 0 && (
        <details>
          <summary className="cursor-pointer text-accent">
            Решения ({decisions.length})
          </summary>
          <ul className="space-y-1 pt-1 text-sm">
            {decisions.map((item) => (
              <li key={item.id}>
                {item.decision === 'accepted' ? 'Принято' : 'Отклонено'} · версия карточки{' '}
                {item.proposal_version} · {new Date(item.created_at).toLocaleString('ru')}
                {item.comment ? ` · ${item.comment}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!readOnly && !editing && (
        <div className="space-y-2">
          <TextArea
            label="Комментарий к решению"
            value={comment}
            onChange={setComment}
            disabled={decide.isPending}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: 'accepted' })}
            >
              Принять
            </Button>
            <Button
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: 'rejected' })}
            >
              Отклонить
            </Button>
          </div>
        </div>
      )}
      {executions.length > 0 && (
        <details>
          <summary className="cursor-pointer text-accent">
            Исполнения ({executions.length})
          </summary>
          <ul className="space-y-1 pt-1 text-sm">
            {executions.map((item) => (
              <li key={item.id}>
                {item.note}
                {item.result ? ` → ${item.result}` : ''} ·{' '}
                {new Date(item.created_at).toLocaleString('ru')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!readOnly && !editing && (
        <div className="space-y-2">
          <TextArea
            label="Что сделано вручную"
            value={note}
            onChange={setNote}
            disabled={execute.isPending}
          />
          <TextArea
            label="Результат (что получено)"
            value={result}
            onChange={setResult}
            disabled={execute.isPending}
          />
          <Button
            disabled={execute.isPending || !note.trim()}
            onClick={() => execute.mutate(undefined)}
          >
            Добавить исполнение
          </Button>
        </div>
      )}
    </article>
  )
}

export function CaseLibrary({ current }: { current: ConsiliumCase }) {
  const readOnly = current.status !== 'open'
  const [offset, setOffset] = useState(0)
  const [adding, setAdding] = useState(false)
  const proposals = useQuery({
    queryKey: ['consilium', current.id, 'proposals', offset],
    queryFn: ({ signal }) => consiliumApi.proposals(current.id, offset, signal),
    gcTime: 0,
  })
  const add = useCaseAction<ProposalDraft>(current.id, (draft) =>
    consiliumApi.addProposal(current.id, {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      source: 'manual',
      kind: draft.kind,
      title: draft.title,
      hypothesis: draft.hypothesis.trim() || undefined,
      rationale: draft.rationale.trim() || undefined,
      risks: draft.risks.trim() || undefined,
      check_method: draft.checkMethod.trim() || undefined,
    }),
  )

  return (
    <section className="space-y-4">
      <p className="text-fg-2">
        Исследовательские предложения: карточка шага (основание, гипотеза, риски, способ
        проверки), решение человека и ручное исполнение с результатом. История решений не
        правится: правка карточки даёт новую версию, и старое решение остаётся прошлым.
        Сами расчёты библиотека не запускает — исполните шаг вручную в существующих
        разделах и внесите результат.
      </p>
      {readOnly ? (
        <p className="text-sm text-fg-2">Исследование в архиве — библиотека только для чтения.</p>
      ) : (
        <Button onClick={() => setAdding(!adding)}>
          {adding ? 'Скрыть форму' : 'Новое предложение'}
        </Button>
      )}
      {adding && !readOnly && (
        <ProposalForm
          initial={EMPTY_DRAFT}
          submitLabel="Добавить в библиотеку"
          pending={add.isPending}
          onSubmit={(draft) => {
            add.mutate(draft, { onSuccess: () => setAdding(false) })
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {add.error != null && <ErrorBlock message={apiErrorText(add.error)} />}
      <QueryState
        loading={proposals.isPending}
        error={proposals.error}
        retry={() => {
          void proposals.refetch()
        }}
      />
      {proposals.data && proposals.data.items.length === 0 && (
        <p className="text-sm text-fg-2">В библиотеке пока нет предложений.</p>
      )}
      {(proposals.data?.items ?? []).map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          caseVersion={current.version}
          readOnly={readOnly}
        />
      ))}
      <PageButtons offset={offset} total={proposals.data?.total ?? 0} onChange={setOffset} />
    </section>
  )
}