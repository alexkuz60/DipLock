/** Раунд советников: карточки ролей, попытки, раскрытия и действия ответа. */
import { useMemo, useState } from 'react'
import { apiErrorText } from '@/shared/api/client'
import type { ConsiliumAnswer, ConsiliumRound } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { StatusPill, type StatusPillTone } from '@/shared/ui/StatusPill'
import { WarnList } from '@/shared/ui/WarnList'
import { advisorRoles, roundKinds, roundStatuses } from './options'

/** Разделы формата советника: заголовки заданы инструкцией (rounds.ANSWER_FORMAT). */
import type { ConsiliumCase } from '@/shared/api/types'
import { AnswerJevMarks } from './AnswerJevMarks'

const SECTION_TITLES: Record<string, 'explanations' | 'question' | 'next'> = {
  'Возможные объяснения': 'explanations',
  'Вопрос добровольцу': 'question',
  'Следующий шаг': 'next',
}

type Section = { title: string; body: string }

function parseSections(text: string): Section[] {
  return text
    .split(/^##\s+/m)
    .slice(1)
    .map((part) => {
      const [title, ...rest] = part.split('\n')
      return { title: title.trim(), body: rest.join('\n').trim() }
    })
    .filter((section) => section.title.length > 0)
}

function roleLabel(role: string): string {
  return advisorRoles.find((item) => item.value === role)?.label ?? role
}

function kindLabel(kind: string): string {
  return roundKinds.find((item) => item.value === kind)?.label ?? kind
}

function statusOf(status: string): { label: string; tone: StatusPillTone } {
  const found = roundStatuses.find((item) => item.value === status)
  return { label: found?.label ?? status, tone: (found?.tone ?? 'neutral') as StatusPillTone }
}

function AnswerCard({
  current,
  answer,
  attempts,
  snapshotId,
  onRetry,
  retrying,
}: {
  current: ConsiliumCase
  answer: ConsiliumAnswer
  attempts: ConsiliumAnswer[]
  snapshotId: string
  onRetry?: (role: string) => void
  retrying: boolean
}) {
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const sections = useMemo(
    () => (answer.text ? parseSections(answer.text) : []),
    [answer.text],
  )
  const byTitle = useMemo(() => {
    const map = new Map<string, Section>()
    for (const section of sections) map.set(section.title, section)
    return map
  }, [sections])
  const recognized = sections.some((section) => section.title in SECTION_TITLES)
  const toggle = (key: string) => setRevealed((previous) => ({ ...previous, [key]: !previous[key] }))
  const action = (key: string, title: string, section?: Section) => (
    <Button
      variant="ghost"
      disabled={!section}
      title={section ? undefined : 'Раздел не выделен в ответе советника'}
      onClick={() => toggle(key)}
    >
      {title}
      {section ? (revealed[key] ? ' −' : ' +') : ''}
    </Button>
  )

  return (
    <article className="space-y-2 rounded-lg border border-border p-3">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">{roleLabel(answer.role)}</span>
        {answer.model && <span className="text-fg-2">модель: {answer.model}</span>}
        <span className="text-fg-2">инструкция v{answer.instruction_version}</span>
        <StatusPill tone={answer.status === 'ok' ? 'ok' : 'danger'}>
          {answer.status === 'ok' ? 'Ответ получен' : 'Ответ не получен'}
        </StatusPill>
      </header>
      {answer.status === 'failed' && (
        <>
          <p className="text-sm text-danger">Причина: {answer.error ?? 'неизвестная ошибка'}</p>
          {onRetry && (
            <Button variant="secondary" disabled={retrying} onClick={() => onRetry(answer.role)}>
              Повторить ответ
            </Button>
          )}
        </>
      )}
      {answer.text && (
        <div className="space-y-2 whitespace-pre-wrap text-fg-1">
          {recognized ? (
            <>
              {byTitle.get('Замечено') && <p>{byTitle.get('Замечено')?.body}</p>}
              {(['explanations', 'question', 'next'] as const).map((key) => {
                const title =
                  key === 'explanations'
                    ? 'Какие есть другие объяснения?'
                    : key === 'question'
                      ? 'Что спросить у добровольца?'
                      : 'Предложи следующий шаг'
                const section =
                  key === 'explanations'
                    ? byTitle.get('Возможные объяснения')
                    : key === 'question'
                      ? byTitle.get('Вопрос добровольцу')
                      : byTitle.get('Следующий шаг')
                return (
                  <div key={key}>
                    {action(key, title, section)}
                    {section && revealed[key] && (
                      <div className="mt-1 rounded border border-border bg-bg-2 p-2 text-sm">
                        <p className="font-medium text-fg-2">{section.title}</p>
                        <p>{section.body}</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          ) : (
            <p>{answer.text}</p>
          )}
        </div>
      )}
      {!recognized && answer.text && (
        <p className="text-sm text-fg-2">Разделы ответа не распознаны — показан полный текст.</p>
      )}
      <div>
        <Button variant="ghost" onClick={() => toggle('provenance')}>
          На чём основано?
          {revealed.provenance ? ' −' : ' +'}
        </Button>
        {revealed.provenance && (
          <div className="mt-1 space-y-1 rounded border border-border bg-bg-2 p-2 text-sm text-fg-2">
            <p>
              Основание: снимок досье {snapshotId.slice(0, 8)}… — зафиксированные материалы и
              контекст на момент запуска; новый расчёт прошлые ответы не меняет.
            </p>
            <p>
              Модель: {answer.model ?? 'нет данных'} · инструкция v{answer.instruction_version} ·
              задержка: {answer.latency_ms != null ? `${answer.latency_ms} мс` : '—'}.
            </p>
            <p>
              Попыток по роли: {attempts.length}
              {attempts.length > 1 ? ' (показана последняя)' : ''}.
            </p>
          </div>
        )}
      </div>
      {answer.status === 'ok' && <AnswerJevMarks current={current} answer={answer} />}
    </article>
  )
}

export function RoundCard({
  current,
  round,
  rolesFilter,
  canSummary,
  summaryPending,
  retryPending,
  error,
  onSummary,
  onRetry,
}: {
  current: ConsiliumCase
  round: ConsiliumRound
  rolesFilter: readonly string[]
  canSummary: boolean
  summaryPending: boolean
  retryPending: boolean
  error?: unknown
  onSummary?: () => void
  onRetry?: (role: string) => void
}) {
  const status = statusOf(round.status)
  const expected: string[] = (round.limits?.roles as string[] | undefined) ?? (
    round.kind === 'summary' ? ['summary'] : []
  )
  const attemptsByRole = new Map<string, ConsiliumAnswer[]>()
  for (const answer of round.answers ?? []) {
    const list = attemptsByRole.get(answer.role) ?? []
    list.push(answer)
    attemptsByRole.set(answer.role, list)
  }
  const visibleRoles = expected.filter((role) => rolesFilter.includes(role))

  return (
    <section className="space-y-3 rounded-lg border border-border bg-bg-1 p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-fg-0">{kindLabel(round.kind)}</h3>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        <span className="text-sm text-fg-2">
          снимок {round.snapshot_id.slice(0, 8)}… · {new Date(round.created_at).toLocaleString('ru')}
        </span>
        {round.model && <span className="text-sm text-fg-2">маршрут: {round.model}</span>}
        {canSummary && onSummary && (
          <Button variant="primary" disabled={summaryPending} onClick={onSummary}>
            Составить итог
          </Button>
        )}
      </header>
      {round.error && <p className="text-sm text-danger">Ошибка раунда: {round.error}</p>}
      <WarnList items={round.warnings ?? []} />
      <div className="space-y-2">
        {visibleRoles.map((role) => {
          const attempts = attemptsByRole.get(role) ?? []
          const latest = attempts[attempts.length - 1]
          if (!latest) {
            return (
              <article
                key={role}
                className="animate-pulse space-y-2 rounded-lg border border-border p-3"
                data-testid="answer-skeleton"
              >
                <p className="text-sm text-fg-2">{roleLabel(role)} — ожидание ответа…</p>
                <div className="h-3 w-3/4 rounded bg-bg-3" />
                <div className="h-3 w-1/2 rounded bg-bg-3" />
              </article>
            )
          }
          return (
            <AnswerCard
              key={`${role}-${latest.id}`}
              current={current}
              answer={latest}
              attempts={attempts}
              snapshotId={round.snapshot_id}
              onRetry={onRetry}
              retrying={retryPending}
            />
          )
        })}
      </div>
      {error != null && <ErrorBlock message={apiErrorText(error)} />}
    </section>
  )
}