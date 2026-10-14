/**
 * Обсуждение (Т3): коллективный чат советников поверх снимков досье.
 *
 * Запуск — только кнопками; состояние раунда живёт на сервере (поллинг при
 * «running»), фиктивных ответов ИИ нет: без маршрута роутера — честный отказ.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type { ConsiliumCase, ConsiliumRoundCreate } from '@/shared/api/types'
import {
  applyStreamEvent,
  emptyLiveRound,
  subscribeRoundStream,
  type LiveRound,
} from '@/shared/lib/roundStream'
import { useConsiliumOptions } from '@/shared/state/consiliumOptions'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { QueryState } from './common'
import { advisorRoleLabel } from './options'
import { CaseTriage } from './CaseTriage'
import { CaseRoundPlan } from './CaseRoundPlan'
import { RoundCard } from './RoundCard'
import { useCaseAction } from './useCaseAction'

export function CaseDiscussion({ current }: { current: ConsiliumCase }) {
  const [snapshotId, setSnapshotId] = useState('')
  // Разовые настройки (роли раунда, фильтр советников) живут в панели «Опции»
  // (`consiliumOptions`): правка там ничего не запускает, старт — только кнопками.
  const roles = useConsiliumOptions((state) => state.options.roles)
  const setRoles = useConsiliumOptions((state) => state.setRoles)
  const filter = useConsiliumOptions((state) => state.options.roleFilter)
  const readOnly = current.status !== 'open'

  const snapshots = useQuery({
    queryKey: ['consilium', current.id, 'snapshots'],
    queryFn: ({ signal }) => consiliumApi.snapshots(current.id, 0, signal),
    gcTime: 0,
  })
  const rounds = useQuery({
    queryKey: ['consilium', current.id, 'rounds'],
    queryFn: ({ signal }) => consiliumApi.rounds(current.id, 0, signal),
    gcTime: 0,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'running') ? 2000 : false,
  })
  const start = useCaseAction<ConsiliumRoundCreate>(current.id, (payload) =>
    consiliumApi.startRound(current.id, payload),
  )
  const summary = useCaseAction<string>(current.id, (roundId) =>
    consiliumApi.runSummary(current.id, roundId, {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
    }),
  )
  const retry = useCaseAction<{ roundId: string; role: string }>(current.id, (value) =>
    consiliumApi.retryAnswer(current.id, value.roundId, {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      role: value.role as 'psychological',
    }),
  )

  const items = rounds.data?.items ?? []
  const running = items.some((item) => item.status === 'running')
  const selected = snapshotId || snapshots.data?.items[0]?.id || ''
  const snapshotOptions = (snapshots.data?.items ?? []).map((item) => ({
    value: item.id,
    label: `Снимок от ${new Date(item.created_at).toLocaleString('ru')}`,
  }))
  const initialForSnapshot = items.find(
    (item) => item.kind === 'initial' && item.snapshot_id === selected,
  )
  const remarksSource = items.find(
    (item) =>
      item.kind === 'initial' &&
      (item.status === 'done' || item.status === 'partial') &&
      !items.some((other) => other.kind === 'remarks' && other.source_round_id === item.id),
  )
  const summaries = new Set(
    items.filter((item) => item.kind === 'summary').map((item) => item.snapshot_id),
  )
  const busy = running || start.isPending || summary.isPending || retry.isPending

  // Живой стрим (срез 0011): частичные тексты идущего запуска видны сразу;
  // готовые ответы всё равно приходят поллингом из БД (стрим — только удобство)
  const runningRoundId = items.find((item) => item.status === 'running')?.id ?? ''
  const [live, setLive] = useState<LiveRound | null>(null)
  useEffect(() => {
    if (!runningRoundId) return
    setLive(emptyLiveRound(runningRoundId))
    return subscribeRoundStream(current.id, runningRoundId, (event) => {
      setLive((previous) => applyStreamEvent(previous, runningRoundId, event))
    })
  }, [current.id, runningRoundId])

  function startRound(kind: 'initial' | 'remarks', sourceRoundId?: string) {
    if (!selected) return
    start.mutate({
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      snapshot_id: selected,
      kind,
      source_round_id: sourceRoundId,
      roles: roles as 'psychological'[] as ConsiliumRoundCreate['roles'],
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-fg-2">
        Советники получают один и тот же опубликованный снимок досье. Первые ответы
        формируются независимо, затем идут замечания коллег и итог с сохранением
        разногласий. Запуск — только по кнопке; без настроенного модельного роутера
        ответы недоступны.
      </p>
      <section className="space-y-2 rounded-lg border border-border p-3">
        <h3 className="font-semibold">Запуск обсуждения</h3>
        <QueryState
          loading={snapshots.isPending}
          error={snapshots.error}
          retry={() => {
            void snapshots.refetch()
          }}
        />
        {snapshots.data && snapshotOptions.length === 0 && (
          <p className="text-sm text-fg-2">
            Нет опубликованных снимков — опубликуйте досье на вкладке «Материалы и досье».
          </p>
        )}
        {snapshotOptions.length > 0 && (
          <SelectField
            label="Снимок досье"
            value={selected}
            options={snapshotOptions}
            onChange={setSnapshotId}
          />
        )}
        <p className="text-sm text-fg-2">
          Роли раунда:{' '}
          {roles.length > 0 ? roles.map(advisorRoleLabel).join(', ') : 'не выбраны'} — состав
          задаётся в панели «Опции» справа или подсказкой Jev.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={readOnly || busy || !selected || roles.length === 0 || !!initialForSnapshot}
            onClick={() => startRound('initial')}
          >
            Ответы советников
          </Button>
          <Button
            disabled={readOnly || busy || !remarksSource}
            onClick={() => remarksSource && startRound('remarks', remarksSource.id)}
          >
            Замечания коллег
          </Button>
        </div>
        {start.error != null && <ErrorBlock message={apiErrorText(start.error)} />}
        {summary.error != null && <ErrorBlock message={apiErrorText(summary.error)} />}
        {retry.error != null && <ErrorBlock message={apiErrorText(retry.error)} />}
      </section>

      <CaseTriage current={current} snapshotId={selected} />

      <CaseRoundPlan
        current={current}
        snapshotId={selected}
        onApply={(recommended) => setRoles(recommended)}
      />

      <QueryState
        loading={rounds.isPending}
        error={rounds.error}
        retry={() => {
          void rounds.refetch()
        }}
      />
      {rounds.isPending && !rounds.data && <LoadingBlock label="Загрузка обсуждения…" />}
      {items.length === 0 && rounds.data && (
        <p className="text-fg-2">Обсуждение ещё не запускалось.</p>
      )}
      <div className="space-y-3">
        {items.map((round) => (
          <RoundCard
            key={round.id}
            current={current}
            round={round}
            live={live?.roundId === round.id ? live : null}
            rolesFilter={filter}
            canSummary={
              !readOnly &&
              !busy &&
              (round.kind === 'initial' || round.kind === 'remarks') &&
              (round.status === 'done' || round.status === 'partial') &&
              !summaries.has(round.snapshot_id)
            }
            summaryPending={summary.isPending}
            retryPending={retry.isPending}
            onSummary={() => summary.mutate(round.id)}
            onRetry={(role) => retry.mutate({ roundId: round.id, role })}
          />
        ))}
      </div>
    </div>
  )
}