/**
 * Мультитрековый вьюер ЭЭГ на uPlot (canvas).
 *
 * Один чарт на канал (дешёвый пересчёт при панорамировании), общая ось
 * времени у нижнего трека, огибающая min/max как band — пики артефактов
 * видны на любом уровне зума (см. `viewerMath.envelopeOf`).
 *
 * Интеракции: колесо — дискретный зум ×1…×16 (якорь в точке курсора),
 * drag — панорамирование, движение мыши — курсор со временем,
 * клик по подписи канала — скрыть/показать, Ctrl+клик — только этот канал.
 *
 * Чартам отключены собственные жесты (pointer-events: none): окном управляет
 * обёртка, чтобы drag/колесо работали одинаково на всех треках.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { SignalData } from '@/shared/lib/demoSignal'
import {
  anchoredCenter,
  envelopeOf,
  panByPixels,
  pointsBudget,
  zoomWindow,
  type TimeWindow,
} from '@/shared/lib/viewerMath'
import { TIME_LEVELS, useEdfParams, useEdfParamsValue } from '@/shared/state/edfParams'

// Цвета холста: canvas не читает CSS-токены, значения синхронизированы с темой
// (styles/index.css: --color-accent #4da3ff, --color-fg-2 #8695a8, --color-border).
const STROKE = '#4da3ff'
const ENVELOPE_FILL = 'rgba(77, 163, 255, 0.22)'
const AXIS_TEXT = '#8695a8'
const AXIS_GRID = 'rgba(44, 58, 77, 0.6)'

const TRACK_HEIGHT = 64
const LABEL_WIDTH = 56

export type TrackStackProps = {
  signal: SignalData
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
  data: ArrayLike<number>
  sfreq: number
  window: TimeWindow
  width: number
  amplitudeMode: 'shared' | 'per_channel'
  amplitudeScaleUv: number
  showXAxis: boolean
  onLabelClick: (name: string, solo: boolean) => void
}

function TrackRow({
  name,
  data,
  sfreq,
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
    () => envelopeOf(data, sfreq, window, pointsBudget(width)),
    [data, sfreq, window, width],
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
export function TrackStack({ signal }: TrackStackProps) {
  const params = useEdfParamsValue()
  const setParams = useEdfParams((state) => state.setParams)
  const toggleChannel = useEdfParams((state) => state.toggleChannel)
  const availableChannels = useEdfParams((state) => state.availableChannels)

  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [centerSec, setCenterSec] = useState(() => signal.durationSec / 2)
  const [cursor, setCursor] = useState<{ xPx: number; timeSec: number } | null>(null)

  // Новая запись/демо — возвращаемся к «вся сессия»
  useEffect(() => {
    setCenterSec(signal.durationSec / 2)
    setCursor(null)
  }, [signal])

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
      const cursorSec = oldWin.t0 + fraction * (oldWin.t1 - oldWin.t0)

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

  // Порядок отображения — порядок каналов сигнала (монтаж), а не порядок кликов
  const visible = signal.channels.filter(
    (name) => params.visibleChannels.includes(name) && signal.data[name],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="track-stack">
      <div className="tnum flex items-center gap-3 px-2 py-1 text-xs text-fg-2">
        <span>
          Окно {window.t0.toFixed(2)}–{window.t1.toFixed(2)} с
        </span>
        <span>×{factor}</span>
        <span className="ml-auto truncate">
          Колесо — зум · drag — панорама · клик по каналу — скрыть · Ctrl+клик — только этот
        </span>
      </div>

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
          const timeSec = window.t0 + (xPx / trackWidth) * (window.t1 - window.t0)
          setCursor({ xPx: xPx + LABEL_WIDTH + 4, timeSec })
        }}
        onMouseLeave={() => setCursor(null)}
      >
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-fg-2">
            Все каналы скрыты — включите их в панели «Каналы» справа.
          </p>
        ) : (
          visible.map((name, index) => (
            <TrackRow
              key={name}
              name={name}
              data={signal.data[name]}
              sfreq={signal.sfreq}
              window={window}
              width={width}
              amplitudeMode={params.amplitudeMode}
              amplitudeScaleUv={params.amplitudeScaleUv}
              showXAxis={index === visible.length - 1}
              onLabelClick={handleLabelClick}
            />
          ))
        )}

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
