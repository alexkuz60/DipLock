/**
 * Тулс-хедер раздела «Диполи» (срез 3.4; воспроизведение — срез 3.7): запуск
 * расчёта, кадр траектории, порог «КД ≥ X нАм» и выдвижные панели спектра.
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
 *   записи на сервере, а не по демо-сигналу;
 * * воспроизведение траектории (`PlaybackControls`) — тоже **команды**: play/pause,
 *   покадрово и скорость (выпадающим списком — экономия места в хедере) меняют
 *   состояние раздела, а сам кадр ведут часы в рабочей области
 *   (`PlaybackFrame.tsx`). Здесь же видно, какой кадр показан, и что
 *   интерполяция между эпохами — отображение, а не измерение.
 *
 * Справа, у края полосы, живёт кнопка «Справка»: пояснения к проекциям, слоям,
 * расчёту и воспроизведению читают один-два раза за сеанс, поэтому они открываются
 * диалогом (`DipolesHelpDialog`), а не занимают рабочую область абзацем.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChartColumn,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Gauge,
  Glasses,
  Grid2x2,
  Loader2,
  Pause,
  Play,
  Share2,
  Square,
} from 'lucide-react'
import {
  calcJobSummary,
  epochIndexOfPointId,
  refineCostHint,
  refineHalfwinLabel,
  refinedSummary,
} from '@/shared/lib/dipoleCalcModel'
import { api } from '@/shared/api/client'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { canPlayback, playbackSummary, PLAYBACK_SPEEDS } from '@/shared/lib/playback'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { CancelJobButton } from '@/shared/ui/CancelJobButton'
import { IconButton } from '@/shared/ui/IconButton'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Tooltip } from '@/shared/ui/Tooltip'
import { cx } from '@/shared/ui/cx'
import { DipolesHelpDialog } from './DipolesHelpDialog'

/** Пояснение к выключенной кнопке, когда записи ещё нет */
const NO_RECORDING_HINT =
  'Сначала загрузите EDF в разделе EDF: расчёт диполей идёт по файлу записи на сервере.'

/** Пояснение к выключенным кнопкам кадра, когда расчёта ещё нет */
const NO_RESULT_HINT =
  'Воспроизведение идёт по точкам результата: сначала нажмите «Рассчитать диполи».'

/** Подсказка кнопки play: что именно происходит и как это считать */
const PLAY_TOOLTIP =
  'Воспроизведение траектории: кадр идёт по сетке эпох результата, позиция и вектор ' +
  'интерполируются между соседними эпохами (отображение, а не измерение). ' +
  '×1 — реальное время записи. Клавиша Space.'

/** Прогресс задачи расчёта: полоса + подпись «этап · эпохи · проценты» + отмена (3.2). */
export function CalcProgress({ className }: { className?: string }) {
  const job = useDipoleCalc((state) => state.job)
  const cancelCalculation = useDipoleCalc((state) => state.cancelCalculation)
  if (job === null || job.status !== 'running') return null

  return (
    <div className={cx('flex items-center gap-1', className)}>
      <Tooltip label={calcJobSummary(job)}>
        <div className="flex items-center gap-2">
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
            {job.epochsTotal > 0
              ? `эпох ${job.epochsDone}/${job.epochsTotal}`
              : `${Math.round(job.progress * 100)} %`}
          </span>
        </div>
      </Tooltip>
      <CancelJobButton onCancel={cancelCalculation} />
    </div>
  )
}

/**
 * Кластер воспроизведения траектории (срез 3.7): play/pause, покадрово, скорость
 * ×0.25/×0.5/×1/×2/×4 **выпадающим списком**, снятие кадра и подпись текущей эпохи.
 *
 * Скорость — список, а не ряд кнопок (поправка ручной проверки, 18.09.2026): пять
 * кнопок занимали в хедере больше места, чем весь остальной кластер, а выбирают
 * скорость редко и одним значением. Список — нативный `<select>` того же вида, что
 * «Канал» в ЭЭГ и «Масштаб» во вьюере, поэтому клавиатура и прокрутка системные.
 *
 * Здесь только **команды**: всё уходит в состояние раздела, а кадр ведут часы
 * рабочей области (`PlaybackFrame.tsx`) — прямых «ручек» у проекций нет.
 */
export function PlaybackControls() {
  const result = useDipoleCalc((state) => state.result)
  const playback = useDipoleCalc((state) => state.playback)
  const togglePlayback = useDipoleCalc((state) => state.togglePlayback)
  const stepPlaybackEpoch = useDipoleCalc((state) => state.stepPlaybackEpoch)
  const setPlaybackSpeed = useDipoleCalc((state) => state.setPlaybackSpeed)
  const clearPlaybackFrame = useDipoleCalc((state) => state.clearPlaybackFrame)

  const canPlay = canPlayback(result)
  const epochLengthMs = result?.epoch_length_ms ?? 0
  const frame = playbackSummary(
    playback.epochIndex,
    result?.n_epochs_total ?? 0,
    (playback.epochIndex * epochLengthMs) / 1000,
    playback.speed,
  )

  return (
    <>
      <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />

      <IconButton
        icon={playback.playing ? <Pause className="size-5" /> : <Play className="size-5" />}
        label={playback.playing ? 'Пауза воспроизведения' : 'Воспроизведение траектории'}
        tooltip={canPlay ? PLAY_TOOLTIP : NO_RESULT_HINT}
        active={playback.playing}
        disabled={!canPlay}
        onClick={togglePlayback}
      />
      <IconButton
        icon={<ChevronLeft className="size-5" />}
        label="Предыдущая эпоха"
        tooltip="Покадрово назад: кадр встаёт на предыдущую эпоху и воспроизведение ставится на паузу"
        disabled={!canPlay}
        onClick={() => stepPlaybackEpoch(-1)}
      />
      <IconButton
        icon={<ChevronRight className="size-5" />}
        label="Следующая эпоха"
        tooltip="Покадрово вперёд: кадр встаёт на следующую эпоху и воспроизведение ставится на паузу"
        disabled={!canPlay}
        onClick={() => stepPlaybackEpoch(1)}
      />

      {/*
        Скорость — выпадающий список: 0.25 и 0.5 — замедление (успеть прочитать
        подписи кадра), 1 — реальное время записи, 2 и 4 — ускорение (требование
        среза + ручная проверка). Вид — как у «Канала» в ЭЭГ: иконка + нативный
        `<select>`, чтобы хедер не разрастался рядом одинаковых кнопок.
      */}
      <label className="flex items-center gap-2 text-sm text-fg-2">
        <Gauge className="size-4 shrink-0" aria-hidden />
        <select
          aria-label="Скорость воспроизведения"
          title="Скорость кадра: ×0.25 и ×0.5 — замедление, ×1 — реальное время записи, ×2 и ×4 — ускорение"
          value={String(playback.speed)}
          onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
          className="tnum rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg-0"
        >
          {PLAYBACK_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {`×${speed}`}
            </option>
          ))}
        </select>
      </label>

      {playback.active ? (
        <>
          <IconButton
            icon={<Square className="size-4" />}
            label="Снять кадр"
            tooltip="Убрать маркер кадра: облако диполей возвращается в обычный вид"
            onClick={clearPlaybackFrame}
          />
          <StatusPill tone={playback.playing ? 'accent' : 'neutral'} title={PLAY_TOOLTIP}>
            {frame}
          </StatusPill>
        </>
      ) : null}
    </>
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
  const selectedPointId = useDipoleCalc((state) => state.selectedPointId)
  const refineJob = useDipoleCalc((state) => state.refineJob)
  const refiningEpoch = useDipoleCalc((state) => state.refiningEpoch)
  const refinedPoints = useDipoleCalc((state) => state.refinedPoints)
  const refineEpoch = useDipoleCalc((state) => state.refineEpoch)
  const refineHalfwinMs = useDipoleCalc((state) => state.refineHalfwinMs)
  // Оценка времени уточнения берётся из чисел `/meta` (замер сервера): кнопка
  // обещает «≈N с», а не «десятки секунд» наугад (шаг 1.5). Тот же запрос уже
  // делает панель раздела — кэш react-query общий.
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const [helpOpen, setHelpOpen] = useState(false)

  const running = job?.status === 'running'
  const canRun = recording !== null && !running

  const selectedEpoch = epochIndexOfPointId(selectedPointId)
  const refinedSelected = selectedEpoch !== null ? refinedPoints[selectedEpoch] : undefined
  const refineRunning = refineJob?.status === 'running' && refiningEpoch !== null
  const refineCost = refineCostHint(meta.data, result?.sfreq ?? null, refineHalfwinMs)
  const refineTooltipText =
    result === null
      ? 'Точное уточнение (BEM) доступно после расчёта диполей'
      : selectedEpoch === null
        ? 'Выберите точку диполя на любой из трёх проекций (или строку в таблице локализации) — тогда кнопка уточнит её эпоху точным фитингом на BEM'
        : refinedSelected
          ? `${refinedSummary(refinedSelected)} — нажмите, чтобы повторить уточнение эпохи ${selectedEpoch + 1}`
          : `Уточнить эпоху ${selectedEpoch + 1}: точный фитинг на BEM fsaverage, окно ${refineHalfwinLabel(refineHalfwinMs)}. ${refineCost}`

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
      {/* Иконка — связанные узлы сетки (Share2): быстрый расчёт — это перебор
          узлов; треугольник play уже занят кнопкой воспроизведения анимации
          (поправка ручной проверки, 19.09.2026) */}
      <IconButton
        icon={running ? <Loader2 className="size-5 animate-spin" /> : <Share2 className="size-5" />}
        label={running ? 'Расчёт…' : result ? 'Пересчитать диполи' : 'Рассчитать диполи'}
        tooltip={runTooltip}
        title={runTooltip}
        disabled={!canRun}
        onClick={() => void runCalculation(recording?.recording_id ?? null)}
      />

      <CalcProgress />

      {/* «Уточнить» (F19): активна при выбранной на проекциях точке; на время
          BEM-фитинга внутри кнопки крутится спиннер */}
      <IconButton
        data-testid="refine-selected-button"
        icon={
          refineRunning && refiningEpoch === selectedEpoch ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Glasses className="size-5" />
          )
        }
        label={
          refinedSelected
            ? `Эпоха ${(selectedEpoch ?? 0) + 1} уточнена точным профилем`
            : 'Уточнить выбранный диполь'
        }
        tooltip={refineTooltipText}
        active={refinedSelected !== undefined}
        disabled={result === null || selectedEpoch === null || refineRunning}
        onClick={() => {
          if (selectedEpoch !== null) {
            void refineEpoch(recording?.recording_id ?? null, selectedEpoch)
          }
        }}
      />

      <PlaybackControls />

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

      {/* Распорка: «Справка» прижата к правому краю полосы действий */}
      <div className="flex-1" />

      <IconButton
        icon={<CircleHelp className="size-5" />}
        label="Справка"
        tooltip="Справка раздела: клик и срезы, слои и анатомия, расчёт и воспроизведение"
        active={helpOpen}
        onClick={() => setHelpOpen(true)}
      />

      <DipolesHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  )
}
