/**
 * Тулс-хедер раздела «ЭЭГ»: канал, запуск расчёта спектрограммы, прогресс, справка.
 *
 * Правила те же, что в «Диполях» и EDF:
 * * расчёт стартует **только кнопкой** — правка параметров в панели ничего не
 *   запускает (`docs/ui.md`), а результат при этом помечается устаревшим;
 * * пока идёт задача, кнопка показывает прогресс по окнам STFT
 *   (`epochs_done`/`epochs_total` — сервер считает их по окнам);
 * * без записи кнопка выключена с объяснением: расчёт идёт по файлу на сервере,
 *   а не по демо-сигналу;
 * * канал выбирается здесь же: переключение канала — тоже правка параметра, и
 *   спектрограмма другого канала считается отдельной задачей.
 *
 * Справа — кнопка «Справка»: пояснения к картинке читают по запросу, а не
 * держат абзацем над графиками (как в разделе «Диполи»).
 */
import { useState } from 'react'
import { CircleHelp, Loader2, Play } from 'lucide-react'
import { calcJobSummary } from '@/shared/state/dipoleCalc'
import {
  eegResultMatchesParams,
  eegSignature,
  useEegParams,
  type EegParams,
} from '@/shared/state/eegParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { IconButton } from '@/shared/ui/IconButton'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Tooltip } from '@/shared/ui/Tooltip'
import { EegHelpDialog } from './EegHelpDialog'

/** Пояснение к выключенной кнопке, когда записи ещё нет */
const NO_RECORDING_HINT =
  'Сначала загрузите EDF в разделе EDF: спектрограмма считается по файлу записи на сервере.'

/** Канал, который реально пойдёт в расчёт: выбранный или первый из записи */
function channelOf(params: EegParams, channels: string[]): string {
  return params.channel ?? channels[0] ?? ''
}

/** Прогресс задачи расчёта: полоса + подпись «окон N из M». */
export function EegCalcProgress() {
  const job = useEegParams((state) => state.job)
  if (job === null || job.status !== 'running') return null

  return (
    <Tooltip label={calcJobSummary(job)}>
      <div className="flex items-center gap-2">
        <div
          role="progressbar"
          aria-label="Прогресс расчёта спектрограммы"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(job.progress * 100)}
          className="h-2 w-28 overflow-hidden rounded-full bg-bg-3"
        >
          <span
            data-testid="eeg-progress-fill"
            className="block h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.round(job.progress * 100)}%` }}
          />
        </div>
        <span className="tnum hidden text-sm text-fg-2 xl:inline">
          {job.epochsTotal > 0
            ? `окон ${job.epochsDone}/${job.epochsTotal}`
            : `${Math.round(job.progress * 100)} %`}
        </span>
      </div>
    </Tooltip>
  )
}

export function EegToolHeaderActions() {
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const params = useEegParams((state) => state.params)
  const job = useEegParams((state) => state.job)
  const result = useEegParams((state) => state.result)
  const grid = useEegParams((state) => state.grid)
  const runSpectrogram = useEegParams((state) => state.runSpectrogram)
  const setChannel = useEegParams((state) => state.setChannel)
  const [helpOpen, setHelpOpen] = useState(false)

  const channels = recording?.channels ?? demo?.channels ?? []
  const channel = channelOf(params, channels)
  const running = job?.status === 'running'
  const canRun = recording !== null && channel !== '' && !running
  const stale = result !== null && !eegResultMatchesParams(result, params)

  const runTooltip = running
    ? `Расчёт идёт: ${calcJobSummary(job)}`
    : job?.status === 'failed'
      ? `Рассчитать заново — прошлый запуск завершился ошибкой: ${job.error}`
      : recording === null
        ? NO_RECORDING_HINT
        : stale
          ? 'Параметры расчёта изменились — пересчитайте спектрограмму по текущим настройкам'
          : result
            ? `Пересчитать спектрограмму канала ${channel}: ${eegSignature({ ...params, channel })}`
            : 'Рассчитать спектрограмму: STFT по одному каналу, окно и перекрытие — из панели'

  return (
    <>
      {channels.length > 1 ? (
        <label className="flex items-center gap-2 text-sm text-fg-2">
          <span className="shrink-0">Канал</span>
          <select
            aria-label="Канал спектрограммы"
            title="Канал трека и спектрограммы: расчёт считается по одному каналу"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            className="rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg-0"
          >
            {channels.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <Button
        variant={canRun ? 'primary' : 'secondary'}
        disabled={!canRun}
        title={runTooltip}
        onClick={() => void runSpectrogram(recording?.recording_id ?? null, channel)}
        icon={running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
      >
        {running ? 'Расчёт…' : result ? 'Пересчитать спектрограмму' : 'Рассчитать спектрограмму'}
      </Button>

      <EegCalcProgress />

      {grid ? (
        <StatusPill tone="ok" title={`Сетка ${grid.nFreqs} × ${grid.nTimes}`}>
          {`${grid.nFreqs} × ${grid.nTimes}`}
        </StatusPill>
      ) : null}
      {stale ? <StatusPill tone="warn">параметры изменены</StatusPill> : null}

      {/* Распорка: «Справка» прижата к правому краю полосы действий */}
      <div className="flex-1" />

      <IconButton
        icon={<CircleHelp className="size-5" />}
        label="Справка"
        tooltip="Справка раздела: половины и курсор, линейки, расчёт спектрограммы, палитра и фильтр"
        active={helpOpen}
        onClick={() => setHelpOpen(true)}
      />

      <EegHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  )
}

