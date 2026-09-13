/**
 * Кнопки перерасчёта тулс-хедера EDF: по одной на каждую стадию предподготовки.
 *
 * Обработка запускается **только этой кнопкой** (правило `docs/ui.md`): правка
 * параметров в панели ничего не считает, а кнопка ставит задачу на сервере
 * (`POST /recordings/{id}/preprocess`) и показывает её прогресс. Иконка стадии
 * загорается, когда параметры этой стадии изменились или результат не получен;
 * у активной кнопки точка-индикатор, во время задачи — прогресс в тултипе.
 */
import { Filter, Loader2, ScanSearch, Scissors, type LucideIcon } from 'lucide-react'
import {
  RECALC_STAGE_LABELS,
  useEdfStageState,
  type RecalcStage,
} from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { IconButton } from '@/shared/ui/IconButton'
import { cx } from '@/shared/ui/cx'

const STAGE_ICONS: Record<RecalcStage, LucideIcon> = {
  filter: Filter,
  artifacts: ScanSearch,
  epochs: Scissors,
}

/** Пояснение к выключенной кнопке, когда запись ещё не загружена */
const NO_RECORDING_HINT =
  'Сначала загрузите EDF: предподготовка считается на сервере по файлу записи.'

export function EdfRecalcButton({ stage }: { stage: RecalcStage }) {
  const { state } = useEdfStageState(stage)
  const recording = useEdfRecording((store) => store.recording)
  const job = useEdfRecording((store) => store.stageJobs[stage])
  const runStage = useEdfRecording((store) => store.runStage)
  const Icon = STAGE_ICONS[stage]
  const label = RECALC_STAGE_LABELS[stage]
  const running = job?.status === 'running'

  const reason =
    state === 'stale'
      ? 'параметры изменены — нужно пересчитать'
      : state === 'not_run'
        ? 'результат ещё не получен'
        : 'результат актуален'
  const tooltip = running
    ? `Пересчёт: ${label} — идёт (${Math.round((job?.progress ?? 0) * 100)}%${
        job?.message ? `, ${job.message}` : ''
      })`
    : job?.status === 'failed'
      ? `Пересчитать: ${label} — прошлый запуск завершился ошибкой: ${job.error}. ${reason}`
      : recording === null
        ? `Пересчитать: ${label} — ${NO_RECORDING_HINT}`
        : `Пересчитать: ${label} — ${reason}`

  return (
    <span className="relative inline-flex">
      <IconButton
        disabled={recording === null || running}
        tooltip={tooltip}
        label={`Пересчитать: ${label}`}
        active={state === 'ready'}
        onClick={() => void runStage(stage)}
        icon={
          running ? (
            <Loader2 className="size-5 animate-spin" aria-hidden />
          ) : (
            <Icon className="size-5" aria-hidden />
          )
        }
      />
      {!running && state !== 'ready' ? (
        <span
          aria-hidden
          data-state={state}
          className={cx(
            'pointer-events-none absolute top-1.5 right-1.5 size-2 rounded-full',
            state === 'stale' ? 'bg-warn' : 'bg-fg-2',
          )}
        />
      ) : null}
      {!running && job?.status === 'failed' ? (
        <span
          aria-hidden
          data-testid={`stage-error-${stage}`}
          className="pointer-events-none absolute top-1.5 right-1.5 size-2 rounded-full bg-danger"
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
