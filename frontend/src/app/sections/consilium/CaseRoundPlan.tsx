/**
 * «Быстрый раунд» (Jev, §5.3): advisory-подбор ролей и глубины по снимку.
 *
 * Запуск — только кнопкой; подсказка предзаполняет чекбоксы ролей, но запуск
 * раунда остаётся за человеком. Метки — не вердикты: уверенность калибрована,
 * но не гарантирует правильность (порог — настройки сервера).
 */
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type { ConsiliumCase, ConsiliumJevMark, ConsiliumJevMarkRoundPlanCreate } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { QueryState } from './common'
import { recommendedRoles, roleMarkLabel } from './jevRoles'
import { advisorRoles, roundDepths } from './options'
import { useCaseAction } from './useCaseAction'

/** Карточка подсказки: роли, глубина, вероятности и честная оговорка. */
function PlanCard({
  mark,
  onApply,
}: {
  mark: ConsiliumJevMark
  onApply?: (roles: string[]) => void
}) {
  const roles = recommendedRoles(mark)
  return (
    <article className="space-y-1 rounded-lg border border-border p-3" data-testid="round-plan-card">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">Подсказка состава раунда</span>
        <span className="text-fg-2">{mark.model ?? 'модель неизвестна'}</span>
        <span className="text-fg-2">{new Date(mark.created_at).toLocaleString('ru')}</span>
        {mark.latency_ms != null && (
          <span className="text-fg-2">{Math.round(mark.latency_ms)} мс</span>
        )}
      </header>
      {mark.status === 'failed' ? (
        <p role="alert" className="text-sm text-danger">
          Подсказка не получена: {mark.error ?? 'неизвестная ошибка'}
        </p>
      ) : (
        <div className="space-y-1 text-sm text-fg-1">
          <p>
            Рекомендованные роли:{' '}
            {roles.length > 0
              ? roles
                  .map((role) => advisorRoles.find((item) => item.value === role)?.label ?? role)
                  .join(', ')
              : 'ни одна роль не набрала порог — выберите состав сами'}
          </p>
          {mark.choice && (
            <p>
              Глубина обсуждения:{' '}
              {roundDepths.find((item) => item.value === mark.choice)?.label ?? mark.choice}
              {mark.choice_confidence != null && (
                <span className="text-fg-2">
                  {' '}
                  (уверенность {Math.round(mark.choice_confidence * 100)}%)
                </span>
              )}
            </p>
          )}
          <ul className="list-disc space-y-0.5 pl-5 text-fg-2">
            {Object.entries(mark.probs ?? {}).map(([name, prob]) => (
              <li key={name}>
                {roleMarkLabel(name)
                  ? (advisorRoles.find((item) => item.value === roleMarkLabel(name))?.label ?? name)
                  : name}
                : {Math.round(prob * 100)}%
              </li>
            ))}
          </ul>
          <p className="text-fg-2">
            Подсказка решающего классификатора, не вердикт: уверенность калибрована, но не
            гарантирует правильность; состав раунда выбирает человек.
          </p>
          {onApply && roles.length > 0 && (
            <Button variant="ghost" onClick={() => onApply(roles)}>
              Применить к выбору ролей
            </Button>
          )}
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

export function CaseRoundPlan({
  current,
  snapshotId,
  onApply,
}: {
  current: ConsiliumCase
  snapshotId: string
  onApply?: (roles: string[]) => void
}) {
  const readOnly = current.status !== 'open'
  const marks = useQuery({
    queryKey: ['consilium', current.id, 'jev-marks', 'round_plan'],
    queryFn: ({ signal }) =>
      consiliumApi.jevMarks(current.id, 'round_plan', undefined, signal),
    gcTime: 0,
  })
  const run = useCaseAction<string>(current.id, (snapshot) => {
    const payload: ConsiliumJevMarkRoundPlanCreate = {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      snapshot_id: snapshot,
    }
    return consiliumApi.runRoundPlan(current.id, payload)
  })

  const items = marks.data?.items ?? []
  const latest = snapshotId
    ? (items.find((item) => item.subject_id === snapshotId) ?? null)
    : null

  return (
    <section className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="font-semibold">Состав раунда (Jev)</h3>
      <p className="text-sm text-fg-2">
        Быстрый подбор ролей и глубины обсуждения решающим классификатором по снимку досье —
        экономия LLM-вызовов. Подсказка предзаполняет чекбоксы ролей, но не запускает раунд.
        Запуск — только кнопкой; наружу уходит тот же сжатый дайджест, что и советникам.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={readOnly || run.isPending || !snapshotId}
          onClick={() => run.mutate(snapshotId)}
        >
          {run.isPending ? 'Подбор…' : 'Подобрать состав раунда'}
        </Button>
        {run.isPending ? (
          <span role="status" className="text-sm text-fg-2">
            Запрос к решающему классификатору…
          </span>
        ) : null}
      </div>
      {run.error != null && <ErrorBlock message={apiErrorText(run.error)} />}
      <QueryState
        loading={marks.isPending}
        error={marks.error}
        retry={() => {
          void marks.refetch()
        }}
      />
      {latest ? (
        <PlanCard mark={latest} onApply={onApply} />
      ) : (
        marks.data && (
          <p className="text-sm text-fg-2">
            Подсказка для этого снимка ещё не запрашивалась — подберите состав до запуска раунда.
          </p>
        )
      )}
    </section>
  )
}