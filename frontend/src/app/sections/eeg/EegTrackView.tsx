/**
 * Верхняя половина раздела «ЭЭГ»: сырой трек одного канала на canvas.
 *
 * Отрисовка — не uPlot, а простой холст: нужно ровно два слоя (огибающая
 * min/max и общий курсор) плюс линейка значений справа, которую можно
 * перетаскивать. Чарт на каждый канал здесь не нужен — канал один.
 *
 * Данные приходят кадром `SignalFrame` (пирамида сигналов записи, срез 2.5) —
 * тем же, что рисует вьюер EDF: раздел не читает EDF заново и не имитирует
 * обработку. Огибающая агрегируется по корзинам окна (`frameEnvelope`), поэтому
 * пики артефактов видны на любом зуме.
 *
 * Интерактив: клик по области графика — общий с спектрограммой курсор и линия
 * уровня (уровень сигнала в точке клика), двойной клик — снять метки,
 * перетаскивание **правой линейки** — шкала мкВ на деление, перетаскивание
 * области — панорамирование окна. Зум — колесом (обрабатывает родитель).
 */
import { useEffect, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { frameEnvelope, type TimeWindow } from '@/shared/lib/viewerMath'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import {
  ampTicks,
  amplitudeRangeUv,
  formatUvLevel,
  plotLeftPx,
  plotRightPx,
  plotTimeAtX,
  plotTimeX,
  plotWidthPx,
  timeInWindow,
  valueToY,
  yToAmplitudeUv,
} from '@/shared/lib/eegView'
import {
  canvasTheme,
  drawCursor,
  drawEmptyMessage,
  drawGridLines,
  drawLeftLabel,
  drawLevelMarker,
  drawNullLine,
  drawValueAxis,
  setupCanvas,
} from './eegCanvas'

export type EegTrackViewProps = {
  signal: SignalFrame
  channel: string
  window: TimeWindow
  /** Шкала трека: мкВ на деление */
  amplitudeUv: number
  width: number
  height: number
  /** Время общего курсора, с (null — курсора нет) */
  cursorSec: number | null
  /** Уровень линии уровня, мкВ (null — линии нет) */
  markerUv: number | null
  /** Рисовать ли сетку шкалы */
  grid: boolean
  /** Клик по области: время — в общий курсор, уровень — в линию уровня */
  onPick: (timeSec: number, levelUv: number) => void
  /** Двойной клик по области: снять метки точки клика */
  onClear: () => void
  /** Перетаскивание правой линейки: смещение вниз по вертикали, px */
  onAmplitudeDrag: (dyPx: number) => void
  /** Перетаскивание области: сдвиг окна по горизонтали, px */
  onPan: (dxPx: number) => void
}

export function EegTrackView({
  signal,
  channel,
  window,
  amplitudeUv,
  width,
  height,
  cursorSec,
  markerUv,
  grid,
  onPick,
  onClear,
  onAmplitudeDrag,
  onPan,
}: EegTrackViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** Где началось перетаскивание: различаем «клик — курсор» и «drag — панорама» */
  const dragRef = useRef<{ mode: 'none' | 'axis' | 'pan'; x: number; y: number; moved: boolean }>({
    mode: 'none',
    x: 0,
    y: 0,
    moved: false,
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = setupCanvas(canvas, width, height)
    if (!ctx) return
    const theme = canvasTheme()
    const left = plotLeftPx()
    const right = plotRightPx(width)
    const plotWidth = Math.max(1, right - left)
    const half = amplitudeRangeUv(amplitudeUv)
    const ticks = ampTicks(amplitudeUv, height)

    drawLeftLabel(ctx, [channel, 'мкВ'], height, theme)
    if (grid) drawGridLines(ctx, ticks.map((tick) => tick.y), left, right, theme)
    // Нулевая линия — под огибающей: где шумно, её закрывает сам сигнал, а на
    // спокойных участках видно, стоит сигнал на нуле или смещён
    drawNullLine(ctx, valueToY(0, half, height), width, theme)
    drawValueAxis(ctx, ticks, width, theme, 'мкВ')

    const row = signal.min[channel] ? channel : null
    if (!row) {
      drawEmptyMessage(ctx, `Канал ${channel} недоступен в этом кадре`, width, height, theme)
      return
    }

    // Бюджет точек = 2 × ширины области: больше пикселей не различить
    const envelope = frameEnvelope(
      signal.times,
      signal.min[row] as Float32Array,
      signal.max[row] as Float32Array,
      window,
      plotWidth * 2,
      signal.decimated,
    )
    const yOf = (value: number) => height / 2 - (value / half) * (height / 2)

    ctx.save()
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = 1
    // Огибающая min/max — вертикальные штрихи: пики не срезаются прореживанием
    ctx.beginPath()
    for (let i = 0; i < envelope.times.length; i++) {
      const x = plotTimeX(envelope.times[i] as number, window, width)
      ctx.moveTo(x, yOf(envelope.max[i] as number))
      ctx.lineTo(x, yOf(envelope.min[i] as number))
    }
    ctx.stroke()
    ctx.restore()

    if (markerUv !== null && Math.abs(markerUv) <= half) {
      // Уровень — по той же шкале, что нарисована: `valueToY` обратна `yToAmplitudeUv`
      drawLevelMarker(ctx, valueToY(markerUv, half, height), formatUvLevel(markerUv), width, theme)
    }

    if (cursorSec !== null && timeInWindow(cursorSec, window)) {
      drawCursor(ctx, plotTimeX(cursorSec, window, width), height, theme)
    }
  }, [signal, channel, window, amplitudeUv, width, height, cursorSec, markerUv, grid])

  /** Попадание в столбец значений справа (по нему — перетаскивание шкалы). */
  function insideValueAxis(clientX: number): boolean {
    const canvas = canvasRef.current
    if (!canvas) return false
    // Смещение берём из разметки, а ширину — из пропа: холст отрисован ровно
    // по нему (`style.width`), и геометрия не зависит от того, посчитал ли
    // браузер раскладку (в jsdom все прямоугольники нулевые).
    return clientX - canvas.getBoundingClientRect().left >= plotRightPx(width)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    // Не-левая кнопка (или её отсутствие в окружении без PointerEvent) — не жест
    if (typeof event.button === 'number' && event.button !== 0) return
    dragRef.current = {
      mode: insideValueAxis(event.clientX) ? 'axis' : 'pan',
      x: event.clientX,
      y: event.clientY,
      moved: false,
    }
    // Захват указателя — необязательное улучшение (в jsdom этих методов нет)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (drag.mode === 'none') return
    const dy = event.clientY - drag.y
    const dx = event.clientX - drag.x
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
    if (!drag.moved) return
    if (drag.mode === 'axis') {
      onAmplitudeDrag(dy)
      dragRef.current = { ...drag, y: event.clientY }
      return
    }
    onPan(dx)
    dragRef.current = { ...drag, x: event.clientX }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    dragRef.current = { mode: 'none', x: 0, y: 0, moved: false }
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    // Клик (без перетаскивания) и не по линейке — курсор и уровень в точке клика
    if (drag.mode !== 'pan' || drag.moved) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const xPx = event.clientX - rect.left
    const plotWidth = plotWidthPx(width)
    if (plotWidth <= 0 || xPx < plotLeftPx() || xPx > plotLeftPx() + plotWidth) return
    // Уровень зажат областью графика: вертикаль клика мы уже отсекли, а сама
    // обратная функция обязана быть той же, что рисует линию (`valueToY`)
    const yPx = Math.min(Math.max(event.clientY - rect.top, 0), height)
    onPick(plotTimeAtX(xPx, window, width), yToAmplitudeUv(yPx, amplitudeUv, height))
  }

  function handleDoubleClick(event: MouseEvent<HTMLCanvasElement>) {
    // Двойной клик по области — снять метки точки клика (как у спектрограммы)
    if (insideValueAxis(event.clientX)) return
    onClear()
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="eeg-track-canvas"
      className="block cursor-crosshair touch-none"
      style={{
        width: `${Math.max(1, Math.round(width))}px`,
        height: `${Math.max(1, Math.round(height))}px`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    />
  )
}

