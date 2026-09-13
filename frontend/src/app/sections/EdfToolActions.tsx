/**
 * Тулс-хедер раздела EDF: загрузка записи, перерасчёт по стадиям, паспорт сессии.
 *
 * Кнопки — иконки с тултипами (`IconButton`); все действия идут строго по нажатию:
 * тулс-хедер не делает ни одного запроса сам, он только ставит состояние, которое
 * подхватывает рабочая область (диалог выбора EDF) или панель (паспорт).
 */
import { IdCard, Upload } from 'lucide-react'
import { useState } from 'react'
import { EdfRecalcButtons } from './EdfRecalcButtons'
import { SessionPassportDialog } from './SessionPassportDialog'
import { useEdfNeedsRecalc, useEdfRecalcStatus } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { IconButton } from '@/shared/ui/IconButton'
import { cx } from '@/shared/ui/cx'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Tooltip } from '@/shared/ui/Tooltip'

/** Прогресс готовности перерасчётов: сегменты по стадиям + короткая подпись. */
export function RecalcProgress({
  className,
  label = 'Готовность перерасчётов',
}: {
  className?: string
  /** Доступное имя прогресс-бара (в панели и шапке они разные) */
  label?: string
}) {
  const status = useEdfRecalcStatus()
  const ready = `${status.ready} из ${status.total}`

  return (
    <div className={cx('flex items-center gap-2', className)}>
      <Tooltip label={status.text}>
        <div
          className="flex h-2 w-28 shrink-0 gap-0.5"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={status.total}
          aria-valuenow={status.ready}
        >
          {(['filter', 'artifacts', 'epochs'] as const).map((stage) => (
            <span
              key={stage}
              data-stage={stage}
              data-state={status.states[stage]}
              className={cx(
                'h-full flex-1 rounded-full',
                status.states[stage] === 'ready'
                  ? 'bg-ok'
                  : status.states[stage] === 'stale'
                    ? 'bg-warn'
                    : 'bg-bg-3',
              )}
            />
          ))}
        </div>
      </Tooltip>
      <span className="tnum hidden text-sm xl:inline">
        <StatusPill tone={status.tone}>
          {status.ready === status.total ? `Перерасчётов: ${ready}` : `Готовность: ${ready}`}
        </StatusPill>
      </span>
    </div>
  )
}

export function EdfToolHeaderActions() {
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const uploadProgress = useEdfRecording((state) => state.uploadProgress)
  const requestFileDialog = useEdfRecording((state) => state.requestFileDialog)
  const needsRecalc = useEdfNeedsRecalc()
  const [passportOpen, setPassportOpen] = useState(false)

  // Источник сигнала: загруженная запись или демо-сигнал для отладки вьюера
  const hasSource = recording !== null || demo !== null

  return (
    <>
      <IconButton
        tooltip={
          recording
            ? 'Загрузить другую запись — EDF, 200 МБ'
            : 'Загрузить EDF: файл загружается как есть, без обработки (200 МБ)'
        }
        label="Загрузить EDF"
        active={recording !== null}
        disabled={uploadProgress !== null}
        onClick={requestFileDialog}
        icon={<Upload className="size-5" />}
      />

      <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />

      <EdfRecalcButtons />

      {hasSource ? (
        <>
          <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />
          <RecalcProgress />
        </>
      ) : null}

      <div className="flex-1" />

      <IconButton
        tooltip={
          needsRecalc
            ? 'Паспорт сессии: метаданные для БД (файл не меняется). Есть стадии без перерасчёта'
            : 'Паспорт сессии: просмотр и правка метаданных для БД (файл не меняется)'
        }
        label="Паспорт сессии"
        disabled={recording === null}
        onClick={() => setPassportOpen(true)}
        icon={<IdCard className="size-5" />}
      />

      <SessionPassportDialog open={passportOpen} onClose={() => setPassportOpen(false)} />
    </>
  )
}
