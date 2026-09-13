/**
 * Мультитрековый вьюер ЭЭГ на uPlot (canvas).
 *
 * Один чарт на канал (дешёвый пересчёт при панорамировании), общая ось
 * времени у нижнего трека, огибающая min/max как band — пики артефактов
 * видны на любом уровне зума (см. `viewerMath.frameEnvelope`).
 *
 * Данные приходят кадром `SignalFrame`: огибающая уровня пирамиды от сервера
 * (срез 2.5, `GET /recordings/{id}/signals?level=`) или демо-фикстура. Вьюеру
 * не важно, откуда кадр: он не хранит сырые отсчёты и не декодирует EDF.
 *
 * Интеракции: колесо — дискретный зум ×1…×16 (якорь в точке курсора),
 * drag — панорамирование, движение мыши — курсор со временем,
 * клик по подписи канала — скрыть/показать, Ctrl+клик — только этот канал.
 *
 * Поверх треков — **слои результата** (срез 2.6, `viewerLayers.ts` + `TrackLayers.tsx`):
 * зоны артефактов (клик → детали: тип, интервал, каналы), границы эпох с номерами и
 * штриховка отброшенных эпох. Слои — DOM поверх canvas, поэтому зум пересчитывает
 * только их позиции. Пока стадии не подключены к серверу, данные слоёв — фикстура.
 *
 * Чартам отключены собственные жесты (pointer-events: none): окном управляет
 * обёртка, чтобы drag/колесо работали одинаково на всех треках.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import {
  anchoredCenter,
  frameEnvelope,
  panByPixels,
  pointsBudget,
  xToTime,
  zoomWindow,
  type TimeWindow,
} from '@/shared/lib/viewerMath'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import {
  artifactCounts,
  buildEpochCells,
  demoLayers,
  visibleZones,
  type EdfViewerLayers,
} from '@/shared/lib/viewerLayers'
import { TIME_LEVELS, useEdfParams, useEdfParamsValue } from '@/shared/state/edfParams'
import { StatusPill } from '@/shared/ui/StatusPill'
import {
  ArtifactZoneLayer,
  EpochLayer,
  LayersLegend,
  SelectedZoneCard,
} from './TrackLayers'

// Цвета холста: canvas не читает CSS-токены, значения синхронизированы с темой
// (styles/index.css: --color-accent #4da3ff, --color-fg-2 #8695a8, --color-border).
const STROKE = '#4da3ff'
const ENVELOPE_FILL = 'rgba(77, 163, 255, 0.22)'
const AXIS_TEXT = '#8695a8'
const AXIS_GRID = 'rgba(44, 58, 77, 0.6)'

const TRACK_HEIGHT = 64
const LABEL_WIDTH = 56

export type TrackStackProps = {
  signal: SignalFrame
  /**
   * Слои результата (зоны артефактов, отброшенные эпохи). По умолчанию —
   * детерминированная фикстура (срез 2.6); в срезе 2.7 сюда придёт результат
   * задачи предподготовки.
   */
  layers?: EdfViewerLayers
}

function formatTick(spanSec: number, value: number): string {
  const digits = spanSec >= 60 ? 0 : spanSec >= 5 ? 1 : 2
  return `${value.toFixed(digits)} с`
}

/** Диапазон оси Y: общий (±N мкВ) или авто по окну канала. */
function yRangeFor(
  mode: 'shared' | 'per_channel',
  scaleUv: number,
  envMin: number,
  envMax: number,
): [number, number] | 'auto' {
  if (mode === 'shared') return [-scaleUv, scaleUv]
  if (!Number.isFinite(envMin) || !Number.isFinite(envMax) || envMax <= envMin) return [-1, 1]
  const pad = (envMax - envMin) * 0.08
  return [envMin - pad, envMax + pad]
}

function makeTrackOptions(
  width: number,
  window: TimeWindow,
  yRange: [number, number],
  showXAxis: boolean,
): uPlot.Options {
  return {
    width,
    height: TRACK_HEIGHT,
    legend: { show: false },
    cursor: { show: false },
    padding: [4, 4, 0, 0],
    scales: {
      x: { time: false, min: window.t0, max: window.t1 },
      y: { range: yRange },
    },
    axes: [
      showXAxis
        ? {
            stroke: AXIS_TEXT,
            font: '12px system-ui',
            grid: { stroke: AXIS_GRID, width: 1 },
            ticks: { show: false },
            size: 26,
            values: (self, splits) => {
              const span = self.scales.x.max! - self.scales.x.min!
              return splits.map((v) => formatTick(span, v))
            },
          }
        : { show: false },
      { show: false },
    ],
    series: [
      {},
      // min — невидимая опорная серия огибающей (нужна band'у)
      { show: true, points: { show: false }, stroke: 'rgba(0,0,0,0)', width: 0.1 },
      // max — видимая линия трека
      { show: true, points: { show: false }, stroke: STROKE, width: 1.25 },
    ],
    bands: [{ series: [2, 1], fill: ENVELOPE_FILL, dir: 1 }],
  }
}

type TrackRowProps = {
  name: string
  frame: SignalFrame
  window: TimeWindow
  width: number
  amplitudeMode: 'shared' | 'per_channel'
  amplitudeScaleUv: number
  showXAxis: boolean
  onLabelClick: (name: string, solo: boolean) => void
}

function TrackRow({
  name,
  frame,
  window,
  width,
  amplitudeMode,
  amplitudeScaleUv,
  showXAxis,
  onLabelClick,
}: TrackRowProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<uPlot | null>(null)

  const env = useMemo(
    () =>
      frameEnvelope(
        frame.times,
        frame.min[name] ?? [],
        frame.max[name] ?? [],
        window,
        pointsBudget(width),
        frame.decimated,
      ),
    [frame, name, window, width],
  )
  const yRange = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < env.min.length; i++) {
      if (env.min[i] < lo) lo = env.min[i]
      if (env.max[i] > hi) hi = env.max[i]
    }
    return yRangeFor(amplitudeMode, amplitudeScaleUv, lo, hi)
  }, [env, amplitudeMode, amplitudeScaleUv])

  // Создание/уничтожение чарта (ширина и окно применяются отдельно)
  useEffect(() => {
    const host = hostRef.current
    if (!host || width <= 0) return
    const chart = new uPlot(
      makeTrackOptions(width, window, yRange === 'auto' ? [-1, 1] : yRange, showXAxis),
      [[], [], []] as uPlot.AlignedData,
      host,
    )
    chartRef.current = chart
    return () => {
      chart.destroy()
      chartRef.current = null
    }
    // Пересоздаём при смене канала/ширины/режима шкалы; ось времени обновляется ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, width, showXAxis, amplitudeMode, amplitudeScaleUv])

  useEffect(() => {
    chartRef.current?.setData([env.times, env.min, env.max] as uPlot.AlignedData, false)
    chartRef.current?.setScale('x', { min: window.t0, max: window.t1 })
  }, [env, window])

  useEffect(() => {
    if (yRange !== 'auto') return
    // null = «подобрать автоматически из данных» (контракт uPlot для scale min/max)
    chartRef.current?.setScale('y', { min: null as unknown as number, max: null as unknown as number })
  }, [yRange])

  return (
    <div className="flex items-stretch gap-1" data-testid={`track-${name}`}>
      <button
        type="button"
        data-testid={`track-label-${name}`}
        title="Клик — скрыть канал; Ctrl+клик — показать только этот"
        onClick={(event) => onLabelClick(name, event.ctrlKey || event.metaKey)}
        className="tnum w-14 shrink-0 cursor-pointer self-center rounded text-right font-mono text-xs text-fg-2 hover:text-fg-0"
        style={{ width: LABEL_WIDTH }}
      >
        {name}
      </button>
      <div ref={hostRef} className="pointer-events-none min-w-0 flex-1" />
    </div>
  )
}

/** Стек треков с общей осью времени: зум ×1…×16, панорамирование, курсор. */
export function TrackStack({ signal, layers: layersProp }: TrackStackProps) {
  const params = useEdfParamsValue()
  const setParams = useEdfParams((state) => state.setParams)
  const toggleChannel = useEdfParams((state) => state.toggleChannel)
  const toggleArtifactVisibility = useEdfParams((state) => state.toggleArtifactVisibility)
  const availableChannels = useEdfParams((state) => state.availableChannels)

  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [centerSec, setCenterSec] = useState(() => signal.durationSec / 2)
  const [cursor, setCursor] = useState<{ xPx: number; timeSec: number } | null>(null)
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null)

  // Слои результата: пока стадии не подключены — детерминированная фикстура.
  // Ключ — источник сигнала (запись/демо) и каналы, а не объект кадра: при зуме
  // сервер отдаёт новый кадр того же сигнала, и зоны не должны пересобираться.
  const channelKey = signal.channels.join(',')
  const layers = useMemo(
    () => layersProp ?? demoLayers(signal.durationSec, signal.channels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layersProp, signal.sourceId, signal.durationSec, channelKey],
  )
  const visibleZoneList = useMemo(
    () => visibleZones(layers.artifacts, params.artifactVisibility),
    [layers.artifacts, params.artifactVisibility],
  )
  const counts = useMemo(() => artifactCounts(layers.artifacts), [layers.artifacts])
  const epochs = useMemo(
    () =>
      params.epochBoundaries || params.droppedEpochsHatched
        ? buildEpochCells(signal.durationSec, params.epochLengthMs, layers.rejectedEpochs)
        : [],
    [
      signal.durationSec,
      params.epochBoundaries,
      params.droppedEpochsHatched,
      params.epochLengthMs,
      layers.rejectedEpochs,
    ],
  )
  const selectedZone = useMemo(
    () => visibleZoneList.find((zone) => zone.id === selectedZoneId) ?? null,
    [visibleZoneList, selectedZoneId],
  )
  const hasLayers =
    visibleZoneList.length > 0 || (params.epochBoundaries && epochs.length > 1) || params.droppedEpochsHatched

  // Новая запись/демо — возвращаемся к «вся сессия». Зависимость именно от
  // источника, а не от объекта кадра: при зуме сервер отдаёт новый кадр того же
  // сигнала, и сброс окна по нему ломал бы якорь зума и панорамирование.
  useEffect(() => {
    setCenterSec(signal.durationSec / 2)
    setCursor(null)
  }, [signal.sourceId, signal.durationSec])

  // Ширина области треков (без колонки подписей)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0
      setWidth(Math.max(0, next - LABEL_WIDTH - 8))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const factor = TIME_LEVELS[params.timeLevel] ?? 1
  const window = zoomWindow(signal.durationSec, factor, centerSec)

  // Колесо = дискретный зум (нативный слушатель: React вешает wheel как passive,
  // а нам нужен preventDefault, чтобы колесо не скроллило область)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const state = useEdfParams.getState()
      const level = state.params.timeLevel
      const next = Math.min(
        Math.max(level + (event.deltaY < 0 ? 1 : -1), 0),
        TIME_LEVELS.length - 1,
      )
      if (next === level) return

      const rect = el.getBoundingClientRect()
      const trackWidth = Math.max(1, rect.width - LABEL_WIDTH - 8)
      const xPx = Math.min(Math.max(event.clientX - rect.left - LABEL_WIDTH - 4, 0), trackWidth)
      const oldWin = zoomWindow(signal.durationSec, TIME_LEVELS[level], centerSec)
      const fraction = xPx / trackWidth
      // Якорь зума — время под курсором (та же функция, что у слоёв и курсора)
      const cursorSec = xToTime(xPx, oldWin, trackWidth)

      const newWidth = signal.durationSec / TIME_LEVELS[next]
      setCenterSec(anchoredCenter(cursorSec, fraction, newWidth, signal.durationSec))
      state.setParams({ timeLevel: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [signal, centerSec])

  // Drag = панорамирование
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    let dragging = false
    let lastX = 0

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      dragging = true
      lastX = event.clientX
      // Захват указателя — необязательное улучшение (drag за пределами области);
      // в jsdom этих методов нет, поэтому вызываем защищённо.
      el.setPointerCapture?.(event.pointerId)
      el.style.cursor = 'grabbing'
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return
      const dx = event.clientX - lastX
      lastX = event.clientX
      const state = useEdfParams.getState()
      const win = zoomWindow(
        signal.durationSec,
        TIME_LEVELS[state.params.timeLevel],
        centerSec,
      )
      const trackWidth = Math.max(1, el.clientWidth - LABEL_WIDTH - 8)
      setCenterSec(panByPixels(centerSec, dx, win, trackWidth, signal.durationSec))
    }
    const onPointerUp = (event: PointerEvent) => {
      dragging = false
      el.style.cursor = ''
      if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
    }
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
    }
  }, [signal, centerSec])

  function handleLabelClick(name: string, solo: boolean) {
    if (solo) {
      const only = params.visibleChannels.length === 1 && params.visibleChannels[0] === name
      const restore = availableChannels.length ? availableChannels : signal.channels
      setParams({ visibleChannels: only ? [...restore] : [name] })
      return
    }
    toggleChannel(name)
  }

  // Зоны/эпохи живут в пикселях области треков — та же геометрия, что у курсора
  const geometry = { window, trackWidth: width }
  const handleZoneSelect = useCallback((id: string | null) => setSelectedZoneId(id), [])

  // Порядок отображения — порядок каналов сигнала (монтаж), а не порядок кликов
  const visible = signal.channels.filter(
    (name) => params.visibleChannels.includes(name) && signal.max[name],
  )

  const pointsPerChannel = signal.times.length

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="track-stack">
      <div className="tnum flex items-center gap-3 px-2 py-1 text-xs text-fg-2">
        <span>
          Окно {window.t0.toFixed(2)}–{window.t1.toFixed(2)} с
        </span>
        <span>×{factor}</span>
        <span data-testid="signal-source">
          {signal.level > 0 ? `огибающая, ${pointsPerChannel} т/канал` : 'полный сигнал'}
        </span>
        {hasLayers ? (
          <StatusPill tone="neutral" title="Срез 2.6: слои строятся из детерминированной фикстуры — стадии артефактов и эпох ещё не подключены к серверу (срез 2.7)">
            слои: {layers.source === 'demo' ? 'демо-фикстура' : 'результат расчёта'}
          </StatusPill>
        ) : null}
        <span className="ml-auto truncate">
          Колесо — зум · drag — панорама · клик по каналу — скрыть · Ctrl+клик — только этот
        </span>
      </div>

      {hasLayers ? (
        <LayersLegend
          className="px-2 pb-1"
          counts={counts}
          visibility={params.artifactVisibility}
          onToggle={toggleArtifactVisibility}
        />
      ) : null}

      <div
        ref={wrapRef}
        role="region"
        aria-label="Треки ЭЭГ"
        className="relative min-h-0 flex-1 cursor-crosshair overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-bg-1 py-1 pr-2 select-none"
        onMouseMove={(event) => {
          const el = wrapRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          const xPx = event.clientX - rect.left - LABEL_WIDTH - 4
          const trackWidth = rect.width - LABEL_WIDTH - 8
          if (xPx < 0 || xPx > trackWidth) {
            setCursor(null)
            return
          }
          const timeSec = xToTime(xPx, window, trackWidth)
          setCursor({ xPx: xPx + LABEL_WIDTH + 4, timeSec })
        }}
        onMouseLeave={() => setCursor(null)}
      >
        <div className="relative">
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">
              Все каналы скрыты — включите их в панели «Каналы» справа.
            </p>
          ) : (
            visible.map((name, index) => (
              <TrackRow
                key={name}
                name={name}
                frame={signal}
                window={window}
                width={width}
                amplitudeMode={params.amplitudeMode}
                amplitudeScaleUv={params.amplitudeScaleUv}
                showXAxis={index === visible.length - 1}
                onLabelClick={handleLabelClick}
              />
            ))
          )}

          {/*
            Слои результата поверх canvas: одна система координат с курсором —
            колонка подписей (LABEL_WIDTH) плюс зазор и ширина области треков.
            Открывает список эпох, затем зоны артефактов: зоны кликабельны и
            должны быть выше штриховки/линий.
          */}
          {hasLayers ? (
            <div
              data-testid="track-layers"
              className="pointer-events-none absolute inset-y-0"
              style={{ left: LABEL_WIDTH + 4, width }}
            >
              <EpochLayer
                cells={epochs}
                geometry={geometry}
                showBoundaries={params.epochBoundaries}
                showHatch={params.droppedEpochsHatched}
              />
              <ArtifactZoneLayer
                zones={visibleZoneList}
                geometry={geometry}
                selectedId={selectedZoneId}
                onSelect={handleZoneSelect}
              />
            </div>
          ) : null}
        </div>

        {selectedZone ? (
          <SelectedZoneCard
            zone={selectedZone}
            onClose={() => setSelectedZoneId(null)}
            className="absolute top-1 right-2 z-10 max-w-xs"
          />
        ) : null}

        {cursor ? (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-fg-2/70"
              style={{ left: cursor.xPx }}
            />
            <div
              className="tnum pointer-events-none absolute top-1 rounded bg-bg-3 px-1.5 py-0.5 text-xs text-fg-0"
              style={{ left: cursor.xPx + 6 }}
            >
              {cursor.timeSec.toFixed(3)} с
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
