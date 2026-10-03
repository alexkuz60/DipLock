/**
 * Тулс-хедер раздела «Групповой анализ»: кнопка запуска текущего режима.
 *
 * Пара (B − A) — фоновая задача `kind=compare` (прогресс + отмена, 3.2);
 * группа (N>2) — синхронный JSON `POST /group/aggregate` (без MNE, без
 * задачи): индикатор загрузки, а при результате — вторая кнопка
 * «Сохранить прогон» (`POST /group/analyses`, снимок определения в
 * историю). Правка параметров в панели ничего не запускает — считает
 * только кнопка (правило раздела).
 */
import { GitCompareArrows, Layers, Save } from 'lucide-react'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { useGroupRun } from '@/shared/state/groupRun'
import { Button } from '@/shared/ui/Button'
import { CancelJobButton } from '@/shared/ui/CancelJobButton'

/** Кнопки режима «Пара (B − A)» — задача с прогрессом и отменой. */
function PairActions() {
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

/** Кнопки режима «Группа (N>2)» — синхронный агрегат + снимок в историю. */
function GroupActions() {
  const recordingIds = useGroupRun((state) => state.recordingIds)
  const bandKey = useGroupRun((state) => state.bandKey)
  const loading = useGroupRun((state) => state.loading)
  const aggregate = useGroupRun((state) => state.aggregate)
  const run = useGroupRun((state) => state.run)
  const saveRun = useGroupRun((state) => state.saveRun)

  const missing = recordingIds.length === 0 || !bandKey
  const disabledHint = missing
    ? 'Выберите участников и полосу в панели.'
    : ''

  return (
    <div className="flex items-center gap-2">
      <Button
        icon={<Layers className="size-4" />}
        disabled={missing || loading}
        title={disabledHint || 'Групповой агрегат: строки BA × колонки-записи по выбранной полосе'}
        onClick={() => void run()}
        data-testid="group-run-aggregate"
      >
        {loading ? 'Считаем…' : aggregate ? 'Считать заново' : 'Считать'}
      </Button>
      {aggregate ? (
        <Button
          icon={<Save className="size-4" />}
          disabled={loading}
          title="Сохранить определение (фильтры + состав) в историю прогонов — числа не замораживаются"
          onClick={() => void saveRun()}
          data-testid="group-save-run"
        >
          Сохранить прогон
        </Button>
      ) : null}
    </div>
  )
}

export function GroupToolActions() {
  const mode = useGroupRun((state) => state.mode)
  return mode === 'group' ? <GroupActions /> : <PairActions />
}
