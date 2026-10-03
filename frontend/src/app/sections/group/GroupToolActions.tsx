/**
 * Тулс-хедер «Сравнения двух записей»: запуск по кнопке, прогресс задачи и
 * отмена (3.2) — тот же каркас, что в «Итогах» и «Диполях»: правка параметров
 * ничего не запускает, пока идёт задача — полоса прогресса с сообщением этапа
 * (этапы сравнения: чтение пары → PSD → кластерный тест → карты разности).
 */
import { GitCompareArrows } from 'lucide-react'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { Button } from '@/shared/ui/Button'
import { CancelJobButton } from '@/shared/ui/CancelJobButton'

export function GroupToolActions() {
  const recordingIdA = useGroupCompare((state) => state.recordingIdA)
  const recordingIdB = useGroupCompare((state) => state.recordingIdB)
  const job = useGroupCompare((state) => state.job)
  const result = useGroupCompare((state) => state.result)
  const run = useGroupCompare((state) => state.run)
  const cancel = useGroupCompare((state) => state.cancel)

  const running = job?.status === 'running'
  const missing = !recordingIdA || !recordingIdB
  const same = Boolean(recordingIdA && recordingIdA === recordingIdB)
  const disabledHint = missing
    ? 'Выберите обе записи пары (A и B) в панели.'
    : same
      ? 'Сравнивать нужно две разные записи.'
      : ''

  if (running) {
    return (
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label="Прогресс сравнения записей"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(job.progress * 100)}
          className="h-2 w-28 overflow-hidden rounded-full bg-bg-3"
        >
          <span
            data-testid="group-progress-fill"
            className="block h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.round(job.progress * 100)}%` }}
          />
        </div>
        <span className="tnum hidden text-sm text-fg-2 xl:inline">
          {`${Math.round(job.progress * 100)} %`}
        </span>
        <span
          className="max-w-64 truncate text-sm text-fg-2"
          title={job.message}
          data-testid="group-progress-message"
        >
          {job.message}
        </span>
        <CancelJobButton onCancel={cancel} />
      </div>
    )
  }

  return (
    <Button
      icon={<GitCompareArrows className="size-4" />}
      disabled={missing || same}
      title={disabledHint || 'Дифференциальный анализ пары: дельты по полосам, кластерный тест MNE, карты разности (B − A)'}
      onClick={() => void run()}
      data-testid="group-run"
    >
      {result ? 'Сравнить заново' : 'Сравнить'}
    </Button>
  )
}
