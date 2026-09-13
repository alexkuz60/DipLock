/**
 * Кнопки перерасчёта тулс-хедера EDF: по одной на каждую стадию предподготовки.
 *
 * Иконка стадии загорается, когда параметры этой стадии изменились или результат
 * ещё не получен; у активной кнопки точка-индикатор. Пока задачи предподготовки
 * не подключены к серверу (срез 2.7), кнопки выключены и объясняют это в тултипе:
 * UI не имитирует обработку, но сразу показывает, **что именно** пересчиталось бы.
 */
import { Filter, ScanSearch, Scissors, type LucideIcon } from 'lucide-react'
import {
  RECALC_STAGE_LABELS,
  useEdfStageState,
  type RecalcStage,
} from '@/shared/state/edfParams'
import { IconButton } from '@/shared/ui/IconButton'
import { cx } from '@/shared/ui/cx'

const STAGE_ICONS: Record<RecalcStage, LucideIcon> = {
  filter: Filter,
  artifacts: ScanSearch,
  epochs: Scissors,
}

/** Пояснение к выключенной кнопке: обработка появится вместе с задачей (срез 2.7) */
const PENDING_HINT =
  'Задача предподготовки ещё не подключена к серверу (срез 2.7) — кнопка станет активной вместе с ней.'

export function EdfRecalcButton({ stage }: { stage: RecalcStage }) {
  const { state } = useEdfStageState(stage)
  const Icon = STAGE_ICONS[stage]
  const label = RECALC_STAGE_LABELS[stage]

  const reason =
    state === 'stale'
      ? 'параметры изменены — нужно пересчитать'
      : state === 'not_run'
        ? 'результат ещё не получен'
        : 'результат актуален'

  return (
    <span className="relative inline-flex">
      <IconButton
        disabled
        tooltip={`Пересчитать: ${label} — ${reason}. ${PENDING_HINT}`}
        label={`Пересчитать: ${label}`}
        icon={<Icon className="size-5" aria-hidden />}
      />
      {state !== 'ready' ? (
        <span
          aria-hidden
          data-state={state}
          className={cx(
            'pointer-events-none absolute top-1.5 right-1.5 size-2 rounded-full',
            state === 'stale' ? 'bg-warn' : 'bg-fg-2',
          )}
        />
      ) : null}
    </span>
  )
}

export function EdfRecalcButtons() {
  return (
    <div className="flex items-center gap-1" aria-label="Перерасчёт предподготовки">
      <EdfRecalcButton stage="filter" />
      <EdfRecalcButton stage="artifacts" />
      <EdfRecalcButton stage="epochs" />
    </div>
  )
}
