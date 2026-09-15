/**
 * Тулс-хедер раздела «Диполи» (срез 3.4): запуск расчёта, порог «КД ≥ X нАм» и
 * выдвижные панели спектра.
 *
 * Правила, заложенные в разметке:
 *
 * * расчёт стартует **только кнопкой** — правка порога или параметров ничего не
 *   запускает (как в EDF, `docs/ui.md`);
 * * порог «КД» — параметр **отображения**, а не расчёта: он скрывает слабые
 *   диполи на проекциях, но не меняет результат задачи, поэтому рядом стоит
 *   подпись со счётчиком скрытых точек;
 * * пока идёт задача, кнопка показывает прогресс по этапам и эпохам
 *   (`epochs_done`/`epochs_total`), а не «крутилку» без чисел: расчёт по эпохам
 *   может идти десятки секунд, и видно, сколько осталось;
 * * без загруженной записи кнопка выключена с объяснением: расчёт идёт по файлу
 *   записи на сервере, а не по демо-сигналу.
 */
import { ChartColumn, Grid2x2, Loader2, Play } from 'lucide-react'
import { calcJobSummary, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { IconButton } from '@/shared/ui/IconButton'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Tooltip } from '@/shared/ui/Tooltip'
import { cx } from '@/shared/ui/cx'

/** Пояснение к выключенной кнопке, когда записи ещё нет */
const NO_RECORDING_HINT =
  'Сначала загрузите EDF в разделе EDF: расчёт диполей идёт по файлу записи на сервере.'

/** Прогресс задачи расчёта: полоса + подпись «этап · эпохи · проценты». */
export function CalcProgress({ className }: { className?: string }) {
  const job = useDipoleCalc((state) => state.job)
  if (job === null || job.status !== 'running') return null

  return (
    <Tooltip label={calcJobSummary(job)}>
      <div className={cx('flex items-center gap-2', className)}>
        <div
          role="progressbar"
          aria-label="Прогресс расчёта диполей"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(job.progress * 100)}
          className="h-2 w-28 overflow-hidden rounded-full bg-bg-3"
        >
          <span
            data-testid="calc-progress-fill"
            className="block h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.round(job.progress * 100)}%` }}
          />
        </div>
        <span className="tnum hidden text-sm text-fg-2 xl:inline">
          {job.epochsTotal > 0 ? `эпох ${job.epochsDone}/${job.epochsTotal}` : `${Math.round(job.progress * 100)} %`}
        </span>
      </div>
    </Tooltip>
  )
}

export function DipolesToolHeaderActions() {
  const recording = useEdfRecording((state) => state.recording)
  const job = useDipoleCalc((state) => state.job)
  const result = useDipoleCalc((state) => state.result)
  const view = useDipoleCalc((state) => state.view)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const setAmplitudeThreshold = useDipoleCalc((state) => state.setAmplitudeThreshold)
  const toggleView = useDipoleCalc((state) => state.toggleView)
  const runCalculation = useDipoleCalc((state) => state.runCalculation)

  const running = job?.status === 'running'
  const canRun = recording !== null && !running

  const runTooltip = running
    ? `Расчёт идёт: ${calcJobSummary(job)}`
    : job?.status === 'failed'
      ? `Рассчитать заново — прошлый запуск завершился ошибкой: ${job.error}`
      : recording === null
        ? NO_RECORDING_HINT
        : result
          ? `Пересчитать диполи: точек ${result.points.length}, сетка ${result.grid_mm} мм`
          : 'Рассчитать диполи быстро: одна точка на эпоху в пике GFP, перебор сетки узлов'

  return (
    <>
      <Button
        variant={canRun ? 'primary' : 'secondary'}
        disabled={!canRun}
        title={runTooltip}
        onClick={() => void runCalculation(recording?.recording_id ?? null)}
        icon={running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
      >
        {running ? 'Расчёт…' : result ? 'Пересчитать диполи' : 'Рассчитать диполи'}
      </Button>

      <CalcProgress />

      <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />

      <label className="flex items-center gap-2 text-sm text-fg-2">
        <span className="shrink-0">КД ≥</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step={5}
          value={threshold}
          aria-label="Порог момента диполя, нАм"
          title="Порог отображения: диполи со слабее этого момента на проекциях не рисуются (расчёт не меняется)"
          onChange={(event) => setAmplitudeThreshold(Number(event.target.value))}
          className="tnum w-20 rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-right text-sm text-fg-0"
        />
        <span className="shrink-0">нАм</span>
      </label>

      <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />

      <IconButton
        icon={<Grid2x2 className="size-5" />}
        label="Топокарты ритмов"
        tooltip="Выдвижная панель: топокарты ритмов δ…γ (спектр считается по кнопке в панели)"
        active={view === 'topomap'}
        onClick={() => toggleView('topomap')}
      />
      <IconButton
        icon={<ChartColumn className="size-5" />}
        label="FFT-гистограмма"
        tooltip="Выдвижная панель: средняя мощность ритмов и PSD по частотам"
        active={view === 'fft'}
        onClick={() => toggleView('fft')}
      />

      {result ? (
        <StatusPill tone="ok" title={`Метод: ${result.method}, сетка ${result.grid_mm} мм`}>
          {`Быстрый режим: ${result.points.length} точек`}
        </StatusPill>
      ) : null}
    </>
  )
}
