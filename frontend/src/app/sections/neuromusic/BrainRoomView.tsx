/**
 * Силуэт BrainRoom для секции «Визуализация» «Нейромузыки» (спецификация
 * владельца 07.10.2026; перенесён сюда из секции «Пространство» правого
 * сайдбара): вид сверху, стены комнаты в пропорциях 1.0 : 1.3,
 * контур мозга с продольной щелью и слушатель в центре; точки — позиции
 * источников текущей сцены (дуга «Экспресса» или 4 модуля «Монтажа»).
 *
 * Без МРТ-срезов — чистая векторная схема: координаты идут из
 * `spatialLayout.brainroomProject` («деформация сферы» — нормировка на
 * пропорции комнаты), поэтому силуэт и звук стоят в одной геометрии.
 *
 * Экономия места (правка 10.10.2026): текст-легенда под силуэтом убрана,
 * SVG — `h-full w-full` с `preserveAspectRatio="xMidYMid meet"` — голова
 * вписывается по высоте ячейки и держит **ту же высоту, что соседний график
 * «Эмо»** (`RadialChart` — тот же `h-full w-full` в ячейке той же строки).
 */
import { brainroomProject, scenePoints } from '@/shared/lib/spatialLayout'
import { ROW_COLORS } from './rowMeta'

/** Размер viewBox: ширина 1.0, длина 1.3 — ровно пропорции стен. */
const VIEW_W = 200
const VIEW_H = 260
const PAD = 12
/** Полуоси стен (px): длина = ширина × 1.3. */
const WALL_RX = VIEW_W / 2 - PAD
const WALL_RY = WALL_RX * 1.3
/** Контур мозга чуть меньше стен. */
const BRAIN_RX = WALL_RX - 10
const BRAIN_RY = BRAIN_RX * 1.3

export type BrainRoomViewProps = {
  /** Вариант рендера: у «Монтажа» точки стоят по модулям рядов */
  variant: 'express' | 'montage'
  /** id рядов «Монтажа» (`status.rows`) — порядок показа как на сервере */
  rows: readonly string[]
  /** Число полос (источников в модуле/на дуге) */
  bands: number
  /** Разброс из «Пространства», % — силуэт живёт от ползунка */
  spreadPct: number
}

export function BrainRoomView({ variant, rows, bands, spreadPct }: BrainRoomViewProps) {
  const bandCount = Math.max(1, bands)
  const points = scenePoints({
    variant,
    rows,
    bands: bandCount,
    spread: Math.min(1, Math.max(0, spreadPct / 100)),
  })
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 }
  /** Точка сцены → SVG: u вправо, v вверх (фронт наверху схемы). */
  const toXY = (x: number, z: number) => {
    const { u, v } = brainroomProject(x, z)
    return { cx: center.x + u * WALL_RX, cy: center.y - v * WALL_RY }
  }
  const brainTop = center.y - BRAIN_RY
  const brainBottom = center.y + BRAIN_RY

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Силуэт BrainRoom: вид сверху, ${variant === 'montage' ? 'модули рядов' : 'дуга ±60°'}`}
      data-testid="brainroom-view"
      className="h-full w-full"
    >
      {/* Стены BrainRoom: эллипс 1.0 : 1.3, слушатель в центре. */}
      <ellipse
        cx={center.x}
        cy={center.y}
        rx={WALL_RX}
        ry={WALL_RY}
        fill="var(--color-bg-1)"
        stroke="var(--color-border)"
        strokeWidth={2}
      />
      {/* Мозг сверху: овал коры + продольная щель + выступ носа спереди. */}
      <ellipse
        cx={center.x}
        cy={center.y}
        rx={BRAIN_RX}
        ry={BRAIN_RY}
        fill="none"
        stroke="var(--color-fg-2)"
        strokeWidth={1.5}
      />
      <line
        x1={center.x}
        y1={brainTop + 6}
        x2={center.x}
        y2={brainBottom - 6}
        stroke="var(--color-fg-2)"
        strokeWidth={1}
        strokeDasharray="4 5"
      />
      <path
        d={`M ${center.x - 6} ${brainTop} L ${center.x} ${brainTop - 7} L ${center.x + 6} ${brainTop} Z`}
        fill="var(--color-fg-2)"
      />
      {/* Слушатель (y=0, сцена XY): белая точка + прицел. */}
      <line
        x1={center.x - 8}
        y1={center.y}
        x2={center.x + 8}
        y2={center.y}
        stroke="var(--color-fg-0)"
        strokeWidth={1}
      />
      <line
        x1={center.x}
        y1={center.y - 8}
        x2={center.x}
        y2={center.y + 8}
        stroke="var(--color-fg-0)"
        strokeWidth={1}
      />
      <circle cx={center.x} cy={center.y} r={3.5} fill="var(--color-fg-0)" />
      {/* Источники сцены. */}
      {points.map((point, index) => {
        const { cx, cy } = toXY(point.x, point.z)
        const color = point.row
          ? (ROW_COLORS[point.row] ?? 'var(--color-accent)')
          : 'var(--color-accent)'
        return (
          <circle
            key={`${point.row ?? 'arc'}-${index}`}
            cx={cx}
            cy={cy}
            r={3.2}
            fill={color}
            stroke="var(--color-bg-0)"
            strokeWidth={1}
          />
        )
      })}
    </svg>
  )
}
