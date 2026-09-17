/**
 * Раздел «ЭЭГ»: один канал — сырой трек сверху, спектрограмма снизу.
 *
 * Раздел отвечает на вопрос «когда появился ритм»: вьюер EDF показывает много
 * каналов сразу (обзор), «Диполи» считают локализацию по эпохам, а здесь один
 * выбранный канал и его спектрограмма читаются вместе. Курсор и окно времени у
 * половин общие: клик по треку, по полосе времени или по спектрограмме ставит
 * вертикаль, которая видна на обеих половинах.
 *
 * Правила, заложенные в разметке:
 * * обработки в рабочей области нет: спектрограмма считается **кнопкой** в шапке
 *   (`POST /recordings/{id}/spectrogram`), а панель только правит параметры;
 * * зум, колесо, листание окна `<<`/`<`/`>`/`>>` и перетаскивание разделителя —
 *   параметры просмотра: расчёт от них не устаревает (правило `eegSignature`);
 * * окно времени живёт в состоянии раздела, а не в компоненте: половины должны
 *   показывать **один** отрезок, и команда листания приходит из шапки
 *   (`eegNav` с монотонным `seq` — как `navRequest` в EDF);
 * * **полоса времени одна** — под треком (см. `EegTimeline`): вторая полоса под
 *   спектрограммой дублировала ось и читалась как «вторые часы»;
 * * клик отвечает на два вопроса сразу: время уходит в **общий курсор** (вертикаль
 *   видна на обеих половинах), а «вторая координата» — в линию своей половины:
 *   у спектрограммы это частота (`freqMarkerHz`), у трека — уровень сигнала
 *   (`levelUv`). В режиме «обзор» точка клика может лежать вне окна трека — тогда
 *   окно трека подтягивается к ней, иначе курсор был бы виден только на
 *   спектрограмме;
 * * метки принадлежат **точке клика**: новый клик начинает с чистого листа, а
 *   двойной клик по любой половине снимает все метки (одна точка — одни метки);
 * * на треке видно, где ноль (нулевая линия) и каков уровень сигнала в точке
 *   клика (линия уровня с подписью у линейки мкВ); в «обзоре» окно трека обведено
 *   рамкой на спектрограмме — с общим курсором внутри.
 *
 * Трек берётся из пирамиды сигналов записи (`GET /recordings/{id}/signals`) —
 * тем же путём, что вьюер EDF (срез 2.5): раздел не читает EDF заново.
 */
import { useQuery } from '@tanstack/react-query'
import { Activity, FileUp } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/shared/api/client'
import type { RecordingMeta } from '@/shared/api/types'
import { demoSpectrogramGrid } from '@/shared/lib/eegSpectrogram'
import {
  clampEegCenter,
  dragAmplitudeUv,
  dragFreqWindow,
  eegWindow,
  formatHzTick,
  formatUvLevel,
  halfCanvasHeight,
  plotLeftPx,
  plotWidthPx,
  splitHeights,
  timeInWindow,
} from '@/shared/lib/eegView'
import { anchoredCenter, panByPixels, windowCenter } from '@/shared/lib/viewerMath'
import { resolveSignalLevel, selectFrame, type SignalFrame } from '@/shared/lib/signalFrame'
import { TIME_LEVELS, eegResultMatchesParams, useEegParams } from '@/shared/state/eegParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { Placeholder } from '@/shared/ui/Placeholder'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { StatusPill } from '@/shared/ui/StatusPill'
import { SpectrogramCanvas } from './SpectrogramCanvas'
import { EegTimeline } from './EegTimeline'
import { EegTrackView } from './EegTrackView'
import { SplitPane } from '../SplitPane'

export function EegSection() {
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const navigate = useNavigate()

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const levels = meta.data?.signal_levels?.length ? meta.data.signal_levels : [...TIME_LEVELS]

  if (demo) {
    // Демо-сигнал (синтетика) — отладка отрисовки: расчёта на сервере у него нет,
    // и раздел это честно показывает (в полосе состояния — «демо-сигнал»).
    return <EegWorkspace frame={demo} recording={null} demo />
  }
  if (!recording) {
    return (
      <Placeholder
        icon={<Activity className="size-12" />}
        title="Запись не открыта"
        description="Раздел «ЭЭГ» показывает выбранный канал записи и его спектрограмму. Загрузите EDF в разделе EDF — файл читается там же, повторно его открывать не нужно."
      >
        <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => navigate('/edf')}>
          Перейти в раздел EDF
        </Button>
      </Placeholder>
    )
  }

  return <EegRecording recording={recording} levels={levels} />
}

/** Запись раздела: догрузка уровня пирамиды сигналов и передача кадра рабочей области. */
function EegRecording({ recording, levels }: { recording: RecordingMeta; levels: number[] }) {
  const frames = useEdfRecording((state) => state.signalFrames)
  const pending = useEdfRecording((state) => state.signalsPending)
  const signalsError = useEdfRecording((state) => state.signalsError)
  const loadSignals = useEdfRecording((state) => state.loadSignals)
  const levelIndex = useEegParams((state) => state.params.timeLevel)
  const level = resolveSignalLevel(TIME_LEVELS[levelIndex] ?? 1, levels)
  const baseLevel = resolveSignalLevel(levels[0] ?? 1, levels)

  // Уровень ×1 — мгновенный вид «вся сессия»: грузим сразу, ещё до первого зума
  useEffect(() => {
    void loadSignals(baseLevel)
  }, [loadSignals, baseLevel, recording.recording_id])

  useEffect(() => {
    void loadSignals(level)
  }, [loadSignals, level, recording.recording_id])

  const frame = selectFrame(frames, level)
  if (signalsError && !frame) {
    return (
      <div className="p-3">
        <ErrorBlock
          title="Не удалось получить сигналы записи"
          message={signalsError}
          onRetry={() => void loadSignals(level)}
        />
      </div>
    )
  }
  if (!frame) {
    return (
      <div className="p-3">
        <LoadingBlock label={`Чтение сигналов записи (уровень ×${level})…`} />
      </div>
    )
  }

  return (
    <EegWorkspace
      frame={frame}
      recording={recording}
      demo={false}
      pendingLevel={pending > 0 && !frames[level] ? level : null}
    />
  )
}

/** Рабочая область: две половины, разделитель, полосы времени и общий курсор. */
function EegWorkspace({
  frame,
  recording,
  demo,
  pendingLevel = null,
}: {
  frame: SignalFrame
  recording: RecordingMeta | null
  demo: boolean
  pendingLevel?: number | null
}) {
  const params = useEegParams((state) => state.params)
  const result = useEegParams((state) => state.result)
  const grid = useEegParams((state) => state.grid)
  const gridError = useEegParams((state) => state.gridError)
  const error = useEegParams((state) => state.error)
  const eegNav = useEegParams((state) => state.eegNav)
  const setParams = useEegParams((state) => state.setParams)
  const setAmplitudeUv = useEegParams((state) => state.setAmplitudeUv)
  const setFreqWindow = useEegParams((state) => state.setFreqWindow)

  /** Курсор — состояние просмотра: не персистится и снимается при смене источника */
  const [cursorSec, setCursorSec] = useState<number | null>(null)
  /**
   * Частота маркера-горизонтали на спектрограмме (клик по картинке).
   *
   * Локальное состояние половины: у трека нет частот, а `eegParams` персистится —
   * «на какой частоте я смотрел» относится к просмотру текущей записи, как курсор.
   */
  const [freqMarkerHz, setFreqMarkerHz] = useState<number | null>(null)
  /**
   * Уровень сигнала в точке клика по треку, мкВ — линия уровня у линейки мкВ.
   *
   * Такая же метка точки клика, как линия частоты у спектрограммы: живёт в
   * локальном состоянии и не персистится («на каком уровне я смотрел» относится к
   * просмотру текущей записи).
   */
  const [levelUv, setLevelUv] = useState<number | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)

  const channel = params.channel ?? frame.channels[0] ?? ''
  const factor = TIME_LEVELS[params.timeLevel] ?? 1
  const window = eegWindow(frame.durationSec, factor, params.windowCenterSec)
  const plotWidth = plotWidthPx(size.width)
  const heights = splitHeights(size.height || 600, params.splitRatio)
  /**
   * Сетка для демо-режима: раздел не выдаёт её за результат расчёта (правило «UI
   * не имитирует обработку»), она подписана в полосе состояния как синтетика.
   */
  const demoGrid = useMemo(
    () => (demo && grid === null ? demoSpectrogramGrid(channel) : null),
    [demo, grid, channel],
  )
  const shownGrid = grid ?? demoGrid
  const stale = result !== null && !eegResultMatchesParams(result, params)

  // Новый источник сигнала — окно к «вся сессия» и без меток: курсор, частота и
  // уровень относятся к прежней записи, а не к новой
  useEffect(() => {
    setCursorSec(null)
    setFreqMarkerHz(null)
    setLevelUv(null)
  }, [frame.sourceId])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      setSize({ width: Math.max(0, rect?.width ?? 0), height: Math.max(0, rect?.height ?? 0) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /**
   * Команды листания из шапки: реагируем только на новую команду —
   * `handledNavSeqRef` инициализируется текущим `seq`, поэтому перемонтирование
   * раздела не проигрывает старую команду (как `navRequest` в EDF).
   */
  const handledNavSeqRef = useRef<number | null>(eegNav?.seq ?? null)
  useEffect(() => {
    if (!eegNav) return
    const { command, seq } = eegNav
    if (seq === handledNavSeqRef.current) return
    handledNavSeqRef.current = seq
    const state = useEegParams.getState()
    const widthSec = frame.durationSec / (TIME_LEVELS[state.params.timeLevel] ?? 1)
    const center = state.params.windowCenterSec
    // Листание окна — новая точка обзора: метки прежней точки клика снимаются
    setCursorSec(null)
    setFreqMarkerHz(null)
    setLevelUv(null)
    state.setParams({
      windowCenterSec: clampEegCenter(
        command === 'start'
          ? widthSec / 2
          : command === 'end'
            ? frame.durationSec - widthSec / 2
            : command === 'prev'
              ? center - widthSec
              : center + widthSec,
        widthSec,
        frame.durationSec,
      ),
    })
  }, [eegNav, frame.durationSec])

  // Колесо — дискретный зум с якорем в точке курсора (родной слушатель: React
  // вешает wheel как passive, а нужен preventDefault, чтобы не скроллить область)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const state = useEegParams.getState()
      const level = state.params.timeLevel
      const next = Math.min(Math.max(level + (event.deltaY < 0 ? 1 : -1), 0), TIME_LEVELS.length - 1)
      if (next === level) return
      const rect = el.getBoundingClientRect()
      const width = Math.max(1, plotWidthPx(rect.width))
      const xPx = Math.min(Math.max(event.clientX - rect.left - plotLeftPx(), 0), width)
      const oldWindow = eegWindow(
        frame.durationSec,
        TIME_LEVELS[level] ?? 1,
        state.params.windowCenterSec,
      )
      const fraction = xPx / width
      const cursorTime = oldWindow.t0 + fraction * (oldWindow.t1 - oldWindow.t0)
      state.setParams({
        timeLevel: next,
        windowCenterSec: anchoredCenter(
          cursorTime,
          fraction,
          frame.durationSec / (TIME_LEVELS[next] ?? 1),
          frame.durationSec,
        ),
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [frame.durationSec])

  /** Панорамирование окна: положительный сдвиг (тянем вправо) двигает окно в прошлое */
  function handlePan(dxPx: number) {
    setParams({
      windowCenterSec: panByPixels(
        windowCenter(window),
        dxPx,
        window,
        Math.max(1, plotWidth),
        frame.durationSec,
      ),
    })
  }

  /** Перетаскивание правой линейки трека: мкВ на деление (шкала «растягивается») */
  function handleAmplitudeDrag(dyPx: number) {
    setAmplitudeUv(dragAmplitudeUv(params.amplitudeUv, dyPx))
  }

  /** Перетаскивание правой линейки спектрограммы: окно частот (крупнее/мельче) */
  function handleFreqDrag(dyPx: number) {
    const fmax = shownGrid?.fmaxHz ?? params.spectrogram.fmaxHz
    const start: [number, number] = params.freqWindow ?? [0, fmax]
    setFreqWindow(dragFreqWindow(start, dyPx, fmax))
  }

  /**
   * Клик по спектрограмме: время — в общий курсор, частота — в маркер половины.
   *
   * В режиме «обзор» спектрограмма показывает всю запись, и точка клика может
   * лежать **вне** окна трека: тогда курсор был бы виден только на спектрограмме
   * (выглядело как «метка ставится локально»). Поэтому окно трека подтягивается к
   * точке клика — это просмотр, а не расчёт: ни одного запроса не уходит.
   */
  function handleSpectrogramPick(timeSec: number, freqHz: number | null) {
    setCursorSec(timeSec)
    setFreqMarkerHz(freqHz)
    // Новая точка клика — уровень сигнала прежней к ней не относится
    setLevelUv(null)
    if (!timeInWindow(timeSec, window)) {
      setParams({
        windowCenterSec: clampEegCenter(timeSec, window.t1 - window.t0, frame.durationSec),
      })
    }
  }

  /**
   * Клик по треку: время — в общий курсор, уровень сигнала — в линию уровня.
   *
   * Уровень считается в компоненте (`yToAmplitudeUv`) по координате клика, а здесь
   * только принимается: пересчитывать его по времени нельзя — это вертикаль точки.
   */
  function handleTrackPick(timeSec: number, uv: number) {
    setCursorSec(timeSec)
    setLevelUv(uv)
    // Частота принадлежала прежней точке клика
    setFreqMarkerHz(null)
  }

  /** Клик по полосе времени: только время — уровня и частоты у этой точки нет */
  function handleTimelinePick(timeSec: number) {
    setCursorSec(timeSec)
    setFreqMarkerHz(null)
    setLevelUv(null)
  }

  /** Двойной клик по любой половине снимает метки точки клика: она одна на обе */
  function clearMarkers() {
    setCursorSec(null)
    setFreqMarkerHz(null)
    setLevelUv(null)
  }

  // Полоса времени одна и живёт внутри верхней половины (под треком) — её высоту
  // и вычитаем; холст спектрограммы занимает свою половину целиком
  const trackHeight = halfCanvasHeight(heights.top)
  const spectrogramHeight = heights.bottom
  const overview = params.spectrogramMode === 'overview' && shownGrid !== null
  const windowLabel = `${window.t0.toFixed(1)}–${window.t1.toFixed(1)} с`
  // Метки точки клика для полосы состояния: частота (спектрограмма) и уровень (трек).
  // Обе живут ровно столько же, сколько курсор: точка клика у половин одна
  const clickMarks =
    params.showCursor && cursorSec !== null
      ? [
          freqMarkerHz !== null ? `${formatHzTick(freqMarkerHz)} Гц` : null,
          levelUv !== null ? formatUvLevel(levelUv) : null,
        ].filter((mark): mark is string => mark !== null)
      : []

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      {demo ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-1.5 text-sm text-warn">
          Демо-сигнал (синтетика): трек — фикстура вьюера, спектрограмма — синтетическая сетка
          для проверки палитры. Расчёт на сервере для демо не запускается.
        </p>
      ) : null}
      {error ? <ErrorBlock title="Спектрограмма не рассчитана" message={error} /> : null}
      {gridError ? <ErrorBlock title="Сетка спектрограммы не загрузилась" message={gridError} /> : null}

      <div
        ref={wrapRef}
        data-testid="eeg-workspace"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-bg-1"
      >
        {/* Верхняя половина: трек выбранного канала + полоса времени */}
        <div className="flex flex-col overflow-hidden" style={{ height: `${heights.top}px` }}>
          <EegTrackView
            signal={frame}
            channel={channel}
            window={window}
            amplitudeUv={params.amplitudeUv}
            width={size.width}
            height={trackHeight}
            cursorSec={params.showCursor ? cursorSec : null}
            markerUv={params.showCursor ? levelUv : null}
            grid={params.grid}
            onPick={handleTrackPick}
            onClear={clearMarkers}
            onAmplitudeDrag={handleAmplitudeDrag}
            onPan={handlePan}
          />
          <EegTimeline
            window={window}
            width={size.width}
            cursorSec={params.showCursor ? cursorSec : null}
            onCursor={handleTimelinePick}
            label="Трек"
            testId="eeg-track-timeline"
          />
        </div>

        <SplitPane
          ratio={params.splitRatio}
          onRatioChange={(ratio) => setParams({ splitRatio: ratio })}
          containerHeight={size.height}
          label="Разделитель: трек и спектрограмма"
        />

        {/* Нижняя половина: спектрограмма (полоса времени одна на раздел — под треком) */}
        <div className="flex flex-col overflow-hidden" style={{ height: `${heights.bottom}px` }}>
          <SpectrogramCanvas
            grid={shownGrid}
            window={window}
            overview={overview}
            palette={params.palette}
            dbRangeDb={params.dbRangeDb}
            smoothMs={params.smoothMs}
            smoothBins={params.smoothBins}
            freqWindow={params.freqWindow}
            lines={params.grid}
            width={size.width}
            height={spectrogramHeight}
            cursorSec={params.showCursor ? cursorSec : null}
            markerHz={params.showCursor ? freqMarkerHz : null}
            onPick={handleSpectrogramPick}
            onClear={clearMarkers}
            onFreqDrag={handleFreqDrag}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone="accent" title={`Окно времени: ${windowLabel}`}>
          {`Канал ${channel} · ${params.amplitudeUv} мкВ/дел · ${windowLabel}`}
        </StatusPill>
        <StatusPill tone="neutral" title="Масштаб по времени: ×1 — вся сессия">
          {`×${factor}`}
        </StatusPill>
        {demo ? <StatusPill tone="warn">демо-сетка</StatusPill> : null}
        {shownGrid && !demo ? (
          <StatusPill tone="ok" title={`Сетка расчёта: ${shownGrid.channel}`}>
            {`Спектрограмма: ${shownGrid.nFreqs} × ${shownGrid.nTimes} · окно ${Math.round(
              shownGrid.windowMs,
            )} мс`}
          </StatusPill>
        ) : null}
        {!demo && !shownGrid ? (
          <StatusPill tone="neutral">спектрограмма не рассчитана</StatusPill>
        ) : null}
        {stale ? (
          <StatusPill tone="warn" title="Параметры расчёта изменили после расчёта">
            параметры расчёта изменены
          </StatusPill>
        ) : null}
        {cursorSec !== null ? (
          <StatusPill
            tone="accent"
            title="Клик по треку — курсор и уровень сигнала; по спектрограмме — курсор и линия частоты"
          >
            {`курсор ${cursorSec.toFixed(2)} с${
              clickMarks.length ? ` · ${clickMarks.join(' · ')}` : ''
            }`}
          </StatusPill>
        ) : null}
        {pendingLevel !== null ? (
          <StatusPill tone="neutral">{`уровень ×${pendingLevel} догружается`}</StatusPill>
        ) : null}
        {recording ? (
          <StatusPill tone="neutral" title={recording.filename}>
            {`запись ${recording.filename}`}
          </StatusPill>
        ) : null}
      </div>
    </div>
  )
}
