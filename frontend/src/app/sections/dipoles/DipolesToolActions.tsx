/**
 * Тулс-хедер раздела «Диполи» (срез 3.4; воспроизведение — срез 3.7): запуск
 * **расчёта пакета** (все полосы каталога; одиночный расчёт по всему спектру
 * убран), кадр траектории, пороги отображения («GOF ≥ X %» и «Момент ≥ X нАм»)
 * и выдвижные панели спектра.
 *
 * Правила, заложенные в разметке:
 *
 * * расчёт стартует **только кнопкой** — правка порога или параметров ничего не
 *   запускает (как в EDF, `docs/ui.md`); «Рассчитать пакет» шлёт прогон по всем
 *   полосам `freq_bands`/`functional_bands` из `/meta`;
 * * пороги отображения (GOF % — основной, момент нА·м — дополнительный) —
 *   параметры **отображения**, а не расчёта: они скрывают слабые
 *   диполи на проекциях, но не меняют результат задачи, поэтому рядом стоит
 *   подпись со счётчиком скрытых точек;
 * * пока идёт задача, прогресс показывает **индикатор эпох** (второй ряд шапки:
 *   предзаливка по `epochs_done`/`epochs_total`, прежняя раскраска стёрта);
 *   полоса прогресса в шапке убрана (правка 19.10.2026) — она дублировала
 *   индикатор, рядом с кнопкой остаётся только «Отменить»;
 * * без загруженной записи кнопка выключена с объяснением: расчёт идёт по файлу
 *   записи на сервере, а не по демо-сигналу;
 * * воспроизведение траектории (`PlaybackControls`) — тоже **команды**: play/pause
 *   и скорость (выпадающим списком — экономия места в хедере) меняют состояние
 *   раздела, а сам кадр ведут часы в рабочей области (`PlaybackFrame.tsx`).
 *   Покадровые кнопки «<»/«>» убраны: кадр перематывается кликом по ячейке
 *   индикатора эпох (второй ряд шапки, `EpochDipoleStrip`) — там же видно, какой
 *   кадр показан и что интерполяция между эпохами — отображение, а не измерение.
 *   Подпись «Кадр: эпоха … из …» и пилюля «Быстрый режим: N точек» убраны
 *   (правка 19.10.2026): они дублировали индикатор эпох; метка метода живёт в
 *   панели расчёта и таблице локализации («Быстрый режим, сетка N мм»).
 *
 * Справа, у края полосы, живёт кнопка «Справка»: пояснения к проекциям, слоям,
 * расчёту и воспроизведению читают один-два раза за сеанс, поэтому они открываются
 * диалогом (`DipolesHelpDialog`), а не занимают рабочую область абзацем.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChartColumn,
  CircleHelp,
  Crosshair,
  Gauge,
  Glasses,
  Grid2x2,
  Loader2,
  Pause,
  Play,
  Share2,
  Square,
  Table2,
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
import { useDipoleParams } from '@/shared/state/dipoleParams'
import { canPlayback, PLAYBACK_SPEEDS } from '@/shared/lib/playback'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { CancelJobButton } from '@/shared/ui/CancelJobButton'
import { IconButton } from '@/shared/ui/IconButton'
import { cx } from '@/shared/ui/cx'
import { DipolesHelpDialog } from './DipolesHelpDialog'

/** Пояснение к выключенной кнопке, когда записи ещё нет */
const NO_RECORDING_HINT =
  'Сначала загрузите EDF в разделе EDF: расчёт диполей идёт по файлу записи на сервере.'

/** Пояснение к выключенным кнопкам кадра, когда расчёта ещё нет */
const NO_RESULT_HINT =
  'Воспроизведение идёт по точкам результата: сначала нажмите «Рассчитать пакет».'

/** Подсказка кнопки play: что именно происходит и как это считать */
const PLAY_TOOLTIP =
  'Воспроизведение траектории: кадр идёт по сетке эпох результата, позиция и вектор ' +
  'интерполируются между соседними эпохами (отображение, а не измерение). ' +
  '×1 — реальное время записи. Клавиша Space.'

/**
 * Кластер воспроизведения траектории (срез 3.7): play/pause, скорость
 * ×0.25/×0.5/×1/×2/×4 **выпадающим списком** и снятие кадра.
 *
 * Скорость — список, а не ряд кнопок (поправка ручной проверки, 18.09.2026): пять
 * кнопок занимали в хедере больше места, чем весь остальной кластер, а выбирают
 * скорость редко и одним значением. Список — нативный `<select>` того же вида, что
 * «Канал» в ЭЭГ и «Масштаб» во вьюере, поэтому клавиатура и прокрутка системные.
 *
 * Покадровые кнопки «<»/«>» убраны: кадр перематывается кликом по ячейке
 * индикатора эпох (`EpochDipoleStrip`, второй ряд шапки). Здесь только
 * **команды**: всё уходит в состояние раздела, а кадр ведут часы рабочей области
 * (`PlaybackFrame.tsx`) — прямых «ручек» у проекций нет. Подпись «Кадр: эпоха …
 * из …» убрана (правка 19.10.2026): позицию кадра показывает белая рамка
 * индикатора эпох, она же — выбор эпохи.
 */
export function PlaybackControls() {
  const result = useDipoleCalc((state) => state.result)
  const playback = useDipoleCalc((state) => state.playback)
  const togglePlayback = useDipoleCalc((state) => state.togglePlayback)
  const setPlaybackSpeed = useDipoleCalc((state) => state.setPlaybackSpeed)
  const clearPlaybackFrame = useDipoleCalc((state) => state.clearPlaybackFrame)

  const canPlay = canPlayback(result)

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
        <IconButton
          icon={<Square className="size-4" />}
          label="Снять кадр"
          tooltip="Убрать маркер кадра и выделение эпохи: облако диполей возвращается в обычный вид"
          onClick={clearPlaybackFrame}
        />
      ) : null}
    </>
  )
}

export function DipolesToolHeaderActions() {
  const recording = useEdfRecording((state) => state.recording)
  const batchJob = useDipoleCalc((state) => state.batchJob)
  const result = useDipoleCalc((state) => state.result)
  const view = useDipoleCalc((state) => state.view)
  // Вид рабочей области (срез 3.5): отрисовка, параметр вне STAGE_PARAM_KEYS
  const view3d = useDipoleParams((state) => state.params.view3d)
  const setView3d = useDipoleParams((state) => state.setView3d)
  const gofThresholdPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const setGofThreshold = useDipoleCalc((state) => state.setGofThreshold)
  const setAmplitudeThreshold = useDipoleCalc((state) => state.setAmplitudeThreshold)
  const toggleView = useDipoleCalc((state) => state.toggleView)
  const runBatch = useDipoleCalc((state) => state.runBatch)
  const cancelBatch = useDipoleCalc((state) => state.cancelBatch)
  const selectedPointId = useDipoleCalc((state) => state.selectedPointId)
  const refineJob = useDipoleCalc((state) => state.refineJob)
  const refiningEpoch = useDipoleCalc((state) => state.refiningEpoch)
  const refinedPoints = useDipoleCalc((state) => state.refinedPoints)
  const refineEpoch = useDipoleCalc((state) => state.refineEpoch)
  const refineHalfwinMs = useDipoleCalc((state) => state.refineHalfwinMs)
  const eloretaJob = useDipoleCalc((state) => state.eloretaJob)
  const eloretaEpochIndex = useDipoleCalc((state) => state.eloretaEpochIndex)
  const runEloreta = useDipoleCalc((state) => state.runEloreta)
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

  // Каталог полос пакета: прогон всегда идёт по всем ключам `freq_bands` +
  // `functional_bands` (выбор полос для прогона из UI убран, «Расчёт пакета»)
  const catalogBandKeys = [
    ...Object.keys(meta.data?.freq_bands ?? {}),
    ...Object.keys(meta.data?.functional_bands ?? {}),
  ]

  const running = batchJob?.status === 'running'
  const canRun = recording !== null && !running

  const selectedEpoch = epochIndexOfPointId(selectedPointId)
  const refinedSelected = selectedEpoch !== null ? refinedPoints[selectedEpoch] : undefined
  const refineRunning = refineJob?.status === 'running' && refiningEpoch !== null
  const eloretaRunning = eloretaJob?.status === 'running' && eloretaEpochIndex !== null
  const eloretaTooltipText =
    result === null
      ? 'eLORETA доступно после расчёта диполей'
      : selectedEpoch === null
        ? 'Выберите точку диполя — кнопка посчитает пик и ROI-доли eLORETA для её эпохи'
        : `eLORETA эпохи ${selectedEpoch + 1}: пик распределения и ROI-доли (не полные карты, dipoles.md п.5). Окно: ${refineHalfwinLabel(refineHalfwinMs)}`
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
    ? `Расчёт пакета идёт: ${calcJobSummary(batchJob)}`
    : batchJob?.status === 'failed'
      ? `Рассчитать заново — прошлый запуск завершился ошибкой: ${batchJob.error}`
      : recording === null
        ? NO_RECORDING_HINT
        : result
          ? `Пересчитать пакет диполей: полос ${catalogBandKeys.length}, сетка ${result.grid_mm} мм`
          : `Рассчитать пакет диполей по всем полосам каталога (${catalogBandKeys.length}): одна точка на эпоху в пике GFP на каждую полосу`

  return (
    <>
      {/* Иконка — связанные узлы сетки (Share2): расчёт — это перебор
          узлов; треугольник play уже занят кнопкой воспроизведения анимации
          (поправка ручной проверки, 19.09.2026) */}
      <IconButton
        icon={running ? <Loader2 className="size-5 animate-spin" /> : <Share2 className="size-5" />}
        label={running ? 'Расчёт…' : result ? 'Пересчитать пакет' : 'Рассчитать пакет'}
        tooltip={runTooltip}
        title={runTooltip}
        disabled={!canRun}
        onClick={() => void runBatch(recording?.recording_id ?? null, catalogBandKeys)}
      />

      {/* Прогресс расчёта показывает индикатор эпох (второй ряд шапки); прежняя
          полоса прогресса убрана (правка 19.10.2026) — от неё остаётся только
          кнопка отмены идущей задачи (3.2) */}
      {running ? <CancelJobButton onCancel={cancelBatch} /> : null}

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

      {/* eLORETA (остаток B9): пик/ROI той же эпохи — форма нарезки и окно
          общие с «Уточнить», но результат иной (распределение, не точечный фит)
          и не полные карты (dipoles.md п.5) */}
      <IconButton
        data-testid="eloreta-selected-button"
        icon={
          eloretaRunning && eloretaEpochIndex === selectedEpoch ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Crosshair className="size-5" />
          )
        }
        label={eloretaRunning ? 'eLORETA считается…' : 'eLORETA выбранной эпохи'}
        tooltip={eloretaTooltipText}
        disabled={result === null || selectedEpoch === null || eloretaRunning || refineRunning}
        onClick={() => {
          if (selectedEpoch !== null) {
            void runEloreta(recording?.recording_id ?? null, selectedEpoch)
          }
        }}
      />

      <PlaybackControls />

      <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />

      <label className="flex items-center gap-2 text-sm text-fg-2">
        <span className="shrink-0">GOF ≥</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step={1}
          value={gofThresholdPercent}
          aria-label="Порог GOF отображения, %"
          title="Основной порог отображения: диполи с GOF ниже на проекциях не рисуются (расчёт не меняется)"
          onChange={(event) => setGofThreshold(Number(event.target.value))}
          className="tnum w-20 rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-right text-sm text-fg-0"
        />
        <span className="shrink-0">%</span>
      </label>

      <label className="flex items-center gap-2 text-sm text-fg-2">
        <span className="shrink-0">Момент ≥</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step={5}
          value={threshold}
          aria-label="Порог момента диполя, нАм"
          title="Дополнительная фильтрация по моменту: диполи со слабее этого момента на проекциях не рисуются (расчёт не меняется)"
          onChange={(event) => setAmplitudeThreshold(Number(event.target.value))}
          className="tnum w-20 rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-right text-sm text-fg-0"
        />
        <span className="shrink-0">нАм</span>
      </label>

      <span aria-hidden className="mx-0.5 h-6 w-px bg-border" />

      {/*
        Переключатель «Проекции / 3D» (срез 3.5): `view3d` — параметр отрисовки
        раздела (в STAGE_PARAM_KEYS не входит — правка не запускает расчёт и не
        делает результат устаревшим). Сегмент вместо выпадающего списка: вид
        рабочей области должен читаться без клика.
      */}
      <div role="group" aria-label="Вид рабочей области" className="flex gap-1.5">
        <button
          type="button"
          data-testid="view-projections"
          aria-pressed={!view3d}
          title="Три SVG-проекции (аксиаль, сагитталь, коронар) со слоями"
          className={cx(
            'rounded-lg border px-2.5 py-1 text-sm transition-colors',
            !view3d
              ? 'border-accent/60 bg-accent-soft text-fg-0'
              : 'border-border bg-bg-2 text-fg-1 hover:bg-bg-3 hover:text-fg-0',
          )}
          onClick={() => setView3d(false)}
        >
          Проекции
        </button>
        <button
          type="button"
          data-testid="view-3d"
          aria-pressed={view3d}
          title="3D-вид Niivue: том T1 с диполями (узлами), мультисрез или 3D-рендер"
          className={cx(
            'rounded-lg border px-2.5 py-1 text-sm transition-colors',
            view3d
              ? 'border-accent/60 bg-accent-soft text-fg-0'
              : 'border-border bg-bg-2 text-fg-1 hover:bg-bg-3 hover:text-fg-0',
          )}
          onClick={() => setView3d(true)}
        >
          3D
        </button>
      </div>

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
      <IconButton
        icon={<Table2 className="size-5" />}
        label="Разведочный спектр"
        tooltip="Выдвижная панель: список отдельных частот — вход для выбора полос пакета (С3)"
        active={view === 'explore'}
        onClick={() => toggleView('explore')}
      />

      {/* Пилюля «Быстрый режим: N точек» убрана (правка 19.10.2026): она
          дублировала индикатор эпох; метка метода («Быстрый режим, сетка N мм»)
          живёт в панели расчёта и таблице локализации */}

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
