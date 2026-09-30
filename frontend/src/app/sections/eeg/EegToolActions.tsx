/**
 * Тулс-хедер раздела «ЭЭГ»: канал/микс, запуск расчёта спектрограммы, прогресс.
 *
 * Правила те же, что в «Диполях» и EDF:
 * * расчёт стартует **только кнопкой** — правка параметров в панели ничего не
 *   запускает (`docs/ui.md`), а результат при этом помечается устаревшим;
 * * пока идёт задача, кнопка показывает прогресс по окнам STFT
 *   (`epochs_done`/`epochs_total` — сервер считает их по окнам);
 * * без записи кнопка выключена с объяснением: расчёт идёт по файлу на сервере,
 *   а не по демо-сигналу;
 * * «Рассчитать спектрограмму» — **кнопка-иконка** (просьба владельца 30.09.2026:
 *   экономия ширины шапки; единый стиль с «Диполями» — `AudioWaveform`/`Loader2`,
 *   текстовое имя кнопки для a11y и тестов остаётся);
 * * канал и микс — **два комбо-селектора**: виртуальный микс не ссылается на
 *   данные одного отвода препроцессинга EDF (это среднее группы), поэтому он
 *   вынесен из списка электродов в отдельный селектор (просьба владельца
 *   30.09.2026). Выбор в любом из двух переключает общий параметр `channel`.
 *
 * Справки в шапке больше нет: пояснения переехали в Wiki («Работа со страницей
 * ЭЭГ/Спектр») — читаются по запросу и не держат место над графиками.
 */
import { AudioWaveform, Loader2 } from 'lucide-react'
import { calcJobSummary } from '@/shared/lib/dipoleCalcModel'
import {
  channelLabel,
  electrodeOptions,
  isMixChannel,
  mixOptions,
  resolveChannel,
} from '@/shared/lib/eegChannels'
import {
  eegResultMatchesParams,
  eegSignature,
  useEegParams,
} from '@/shared/state/eegParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { CancelJobButton } from '@/shared/ui/CancelJobButton'
import { IconButton } from '@/shared/ui/IconButton'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Tooltip } from '@/shared/ui/Tooltip'

/** Пояснение к выключенной кнопке, когда записи ещё нет */
const NO_RECORDING_HINT =
  'Сначала загрузите EDF в разделе EDF: спектрограмма считается по файлу записи на сервере.'

/** Прогресс задачи расчёта: полоса + подпись «окон N из M» + кнопка отмены (3.2). */
export function EegCalcProgress() {
  const job = useEegParams((state) => state.job)
  const cancelSpectrogram = useEegParams((state) => state.cancelSpectrogram)
  if (job === null || job.status !== 'running') return null

  return (
    <div className="flex items-center gap-1">
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
      <CancelJobButton onCancel={cancelSpectrogram} />
    </div>
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

  const demoChannels = demo?.channels ?? []
  const electrodes = electrodeOptions(recording, demoChannels)
  const mixes = mixOptions(recording)
  const channel = resolveChannel(recording, demoChannels, params.channel)
  const mixSelected = isMixChannel(channel)
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
            ? `Пересчитать спектрограмму канала ${channelLabel(recording, channel)}: ${eegSignature({ ...params, channel })}`
            : mixSelected
              ? 'Рассчитать спектрограмму микса: сервер усреднит каналы группы и посчитает STFT'
              : 'Рассчитать спектрограмму: STFT по одному каналу, окно и перекрытие — из панели'

  const selectClass = 'rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg-0'

  return (
    <>
      {electrodes.length > 0 ? (
        <label className="flex items-center gap-2 text-sm text-fg-2">
          <span className="shrink-0">Канал</span>
          <select
            aria-label="Канал спектрограммы"
            title={
              mixSelected
                ? 'Сейчас показан микс — выберите электрод, чтобы вернуться к одному отводу'
                : 'Канал трека и спектрограммы: расчёт считается по одному каналу'
            }
            value={mixSelected ? '' : channel}
            onChange={(event) => {
              if (event.target.value) setChannel(event.target.value)
            }}
            className={selectClass}
          >
            {/* Микс активен: показываем «—», вернуться к электроду — выбором ниже */}
            {mixSelected ? <option value="" disabled>—</option> : null}
            {electrodes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {mixes.length > 0 ? (
        <label className="flex items-center gap-2 text-sm text-fg-2">
          <span className="shrink-0">Микс</span>
          <select
            aria-label="Виртуальный канал (микс)"
            title="Виртуальный канал: среднее сигналов группы. Своих данных отвода у него нет — поэтому он живёт отдельно от электродов; спектрограмма считается отдельной задачей"
            value={mixSelected ? channel : ''}
            onChange={(event) => {
              if (event.target.value) setChannel(event.target.value)
            }}
            className={selectClass}
          >
            {/* Электрод активен: показываем «—», выбрать микс — любым пунктом ниже */}
            {!mixSelected ? <option value="" disabled>—</option> : null}
            {mixes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <IconButton
        icon={
          running ? <Loader2 className="size-5 animate-spin" /> : <AudioWaveform className="size-5" />
        }
        label={result ? 'Пересчитать спектрограмму' : 'Рассчитать спектрограмму'}
        tooltip={runTooltip}
        title={runTooltip}
        disabled={!canRun}
        onClick={() => void runSpectrogram(recording?.recording_id ?? null, channel)}
      />

      <EegCalcProgress />

      {grid ? (
        <StatusPill tone="ok" title={`Сетка ${grid.nFreqs} × ${grid.nTimes}`}>
          {`${grid.nFreqs} × ${grid.nTimes}`}
        </StatusPill>
      ) : null}
      {stale ? <StatusPill tone="warn">параметры изменены</StatusPill> : null}
    </>
  )
}

