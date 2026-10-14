/**
 * Дерево навигации по ленте раундов (срез 0015): узел — раунд, дети — ответы
 * советников. Клик прокручивает рабочую область к карточке (`onJump` — id
 * DOM-якоря карточки: `round-*`/`answer-*`); данные — общая лента `useCaseRounds`.
 */
import type { ConsiliumAnswer, ConsiliumRound } from '@/shared/api/types'
import { QueryState } from './common'
import { advisorRoleLabel, roundKinds, roundStatuses } from './options'
import { useCaseRounds } from './useCaseRounds'

function kindLabel(kind: string): string {
  return roundKinds.find((item) => item.value === kind)?.label ?? kind
}

function statusLabel(status: string): string {
  return roundStatuses.find((item) => item.value === status)?.label ?? status
}

/** Статусы ответов советника (AnswerStatus) — свои подписи, не статусы раунда. */
const ANSWER_LABELS: Record<string, string> = {
  running: 'отвечает',
  ok: 'готов',
  failed: 'ошибка',
}

function answerStatusLabel(status: string): string {
  return ANSWER_LABELS[status] ?? status
}

type RoleNode = { role: string; latest?: ConsiliumAnswer; attempts: number }

/** Роли раунда: ожидаемый состав (лимиты) + все попытки ответов по каждой. */
function rolesOf(round: ConsiliumRound): RoleNode[] {
  const expected =
    (round.limits?.roles as string[] | undefined) ??
    (round.kind === 'summary' ? ['summary'] : [])
  const byRole = new Map<string, ConsiliumAnswer[]>()
  for (const answer of round.answers ?? []) {
    const list = byRole.get(answer.role) ?? []
    list.push(answer)
    byRole.set(answer.role, list)
  }
  const roles = [...expected, ...[...byRole.keys()].filter((role) => !expected.includes(role))]
  return roles.map((role) => {
    const attempts = byRole.get(role) ?? []
    return { role, latest: attempts[attempts.length - 1], attempts: attempts.length }
  })
}

export function RoundsTree({
  caseId,
  onJump,
}: {
  caseId: string
  onJump: (target: string) => void
}) {
  const rounds = useCaseRounds(caseId)
  const items = rounds.data?.items ?? []

  return (
    <nav aria-label="Дерево раундов" className="space-y-2">
      <p className="text-sm text-fg-2">
        Лента обсуждения: раунды и ответы советников. Клик — прокрутка к карточке.
      </p>
      <QueryState
        loading={rounds.isPending}
        error={rounds.error}
        retryLabel="Обновить дерево"
        retry={() => {
          void rounds.refetch()
        }}
      />
      {rounds.data && items.length === 0 && (
        <p className="text-sm text-fg-2">Обсуждение ещё не запускалось.</p>
      )}
      <ul className="space-y-1 text-sm">
        {items.map((round) => (
          <li key={round.id}>
            <button
              type="button"
              className="w-full rounded px-1 py-0.5 text-left text-fg-0 hover:bg-bg-2"
              onClick={() => onJump(`round-${round.id}`)}
            >
              {kindLabel(round.kind)} · {statusLabel(round.status)}
            </button>
            <ul className="ml-2 space-y-0.5 border-l border-border pl-2">
              {rolesOf(round).map(({ role, latest, attempts }) => (
                <li key={role}>
                  <button
                    type="button"
                    className="w-full rounded px-1 py-0.5 text-left text-fg-1 hover:bg-bg-2"
                    onClick={() => onJump(latest ? `answer-${latest.id}` : `round-${round.id}`)}
                  >
                    {advisorRoleLabel(role)}
                    {latest ? ` · ${answerStatusLabel(latest.status)}` : ' · ожидание'}
                    {attempts > 1 ? ` · попыток ${attempts}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  )
}