/**
 * Совместный курсор проекций (срез 3.5): перекрестие точки MNI под курсором.
 *
 * Оверлей рисуется **поверх всех слоёв** любой из трёх проекций и не входит в
 * `DIPOLE_LAYERS`: курсор — состояние ховера (`projectionCursor` в сторе), а не
 * фоновый слой данных — выключить его чекбоксом нельзя, как и «выключить»
 * положение мыши. Точку и зажатие к краю считает чистая `cursorCross`
 * (`shared/lib/mriProjections.ts`, покрыта Vitest).
 *
 * Источники точки: ховер/клик в любой проекции (туда же пишется) и кроссхейр
 * Niivue в 3D-виде (`Brain3D.tsx` шлёт `onCursor` в тот же стор) — поэтому
 * перекрестие видно «везде», включая проекции, куда мышь не входила.
 */
import {
  PROJECTION_PADDING,
  cursorCross,
  type ProjectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import type { MniVector } from '@/shared/lib/mriProjections'

/** Толщина и прозрачность линий курсора: заметнее сетки, но тише выделения. */
export const CURSOR_STROKE_PX = 1.1
export const CURSOR_OPACITY = 0.85

export function ProjectionCursor({
  plane,
  cursor,
  box,
}: {
  plane: ProjectionPlane
  cursor: MniVector
  box: ProjectionBox
}) {
  const cross = cursorCross(plane, cursor)
  const left = PROJECTION_PADDING
  const right = box.width - PROJECTION_PADDING
  const top = PROJECTION_PADDING
  const bottom = box.height - PROJECTION_PADDING

  return (
    <g
      data-testid={`projection-cursor-${plane}`}
      aria-hidden
      stroke="var(--color-accent)"
      strokeWidth={CURSOR_STROKE_PX}
      strokeOpacity={CURSOR_OPACITY}
    >
      <line x1={cross.x} y1={top} x2={cross.x} y2={bottom} strokeDasharray="4 3" />
      <line x1={left} y1={cross.y} x2={right} y2={cross.y} strokeDasharray="4 3" />
      <circle
        data-testid={`projection-cursor-point-${plane}`}
        cx={cross.x}
        cy={cross.y}
        r={3}
        fill="none"
        strokeWidth={1.4}
      />
    </g>
  )
}
