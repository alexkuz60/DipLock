/**
 * Таймлайн раздела «ЭЭГ»: секунды окна и общий курсор.
 *
 * Полоса времени одна на раздел — она стоит под треком, у которого своя шкала
 * времени, и относится к нему; спектрограмма в режиме «связано» показывает то же
 * окно. Вторая такая же полоса под спектрограммой дублировала ось и читалась как
 * «вторые часы» с другим масштабом (в «обзоре» спектрограмма показывает всю
 * запись), поэтому её убрали.
 *
 * Деления и курсор считаются **в области графика** (`plotTimeX`/`plotTimeAtX`),
 * а не по всей ширине холста: иначе метка секунды уезжала бы от той же секунды на
 * графике (шкала растягивалась бы на столбцы подписи и значений).
 *
 * Клик по полосе ставит общий курсор — так его ставят и по графику, но по
 * таймлайну это проще (он не занят данными).
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { TimeWindow } from '@/shared/lib/viewerMath'
import {
  EEG_TIMELINE_H,
  plotLeftPx,
  plotTimeAtX,
  plotTimeX,
  plotWidthPx,
  timeInWindow,
  timeTicks,
} from '@/shared/lib/eegView'
import { canvasTheme, drawCursor, drawValueAxis, setupCanvas } from './eegCanvas'

export type EegTimelineProps = {
  window: TimeWindow
  width: number
  cursorSec: number | null
  /** Клик по области графика: время под курсором (снять метки умеет график, не полоса) */
  onCursor: (timeSec: number) => void
  /** Подпись слева: чья это шкала времени (полоса одна — окно трека, «Трек») */
  label: string
  /** Доступное имя для тестов и скринридеров */
  testId: string
}

export function EegTimeline({ window, width, cursorSec, onCursor, label, testId }: EegTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = setupCanvas(canvas, width, EEG_TIMELINE_H)
    if (!ctx) return
    const theme = canvasTheme()
    const left = plotLeftPx()
    // Деления — по области графика, а не по всей ширине: у графика и полосы одна
    // шкала времени, поэтому секунда стоит под своей же точкой (`plotTimeX`)
    const ticks = timeTicks(window.t0, window.t1, plotWidthPx(width))
    ctx.save()
    ctx.fillStyle = theme.label
    ctx.textAlign = 'left'
    ctx.fillText(label, 8, EEG_TIMELINE_H / 2)
    ctx.restore()
    ticks.forEach((tick) => {
      const x = left + tick.x
      ctx.save()
      ctx.strokeStyle = theme.grid
      ctx.beginPath()
      ctx.moveTo(x + 0.5, 0)
      ctx.lineTo(x + 0.5, 4)
      ctx.stroke()
      ctx.fillStyle = theme.text
      ctx.fillText(tick.label, x + 3, EEG_TIMELINE_H / 2)
      ctx.restore()
    })
    // Столбец значений справа повторяем и здесь: ось времени должна обрываться
    // там же, где график, иначе полоса «шире» картинки
    drawValueAxis(ctx, [], width, theme, '')
    if (cursorSec !== null && timeInWindow(cursorSec, window)) {
      drawCursor(ctx, plotTimeX(cursorSec, window, width), EEG_TIMELINE_H, theme)
    }
  }, [window, width, cursorSec, label])

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    // Ширина — из пропа: холст отрисован ровно по нему, а в jsdom раскладка
    // не считается (нулевые прямоугольники), и геометрия не должна от неё зависеть
    const xPx = event.clientX - canvas.getBoundingClientRect().left
    const plotWidth = plotWidthPx(width)
    if (plotWidth <= 0 || xPx < plotLeftPx() || xPx > plotLeftPx() + plotWidth) return
    onCursor(plotTimeAtX(xPx, window, width))
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      aria-label={`Полоса времени: ${label}`}
      className="block cursor-pointer touch-none"
      style={{ width: `${Math.max(1, Math.round(width))}px`, height: `${EEG_TIMELINE_H}px` }}
      onPointerUp={handlePointerUp}
    />
  )
}
