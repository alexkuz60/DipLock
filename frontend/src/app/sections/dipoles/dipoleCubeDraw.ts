/**
 * Отрисовка 3D-вида «Куб» (`DipoleCube.tsx`): сцена → вызовы 2D-контекста.
 *
 * Модуль отделён от компонента (по образцу `eegCanvas.ts` в разделе «ЭЭГ»):
 * компонент держит состояние и события, здесь — только рисование. Вся
 * геометрия — чистая (`shared/lib/dipoleCube.ts`), цвета приходят готовыми
 * (`CubeColors` резолвит токены темы через `themeColor` — canvas не понимает
 * `var(...)`).
 *
 * Порядок слоёв (снизу вверх): фон → стенки (дальние сначала) с картинками
 * срезов/силуэта → каркас куба и подписи осей → спираль момента → облако
 * диполей (с лучами) → фокус (линии проекции + кресты, точки поверх) → маркеры
 * и шлейфы анимации → совместный курсор. Стенки рисуются до содержимого:
 * камера стартового ракурса смотрит из октанта +x +y +z, и точки куба всегда
 * перед дальними стенками.
 */
import {
  CUBE_CENTER,
  cubeCorners,
  cubeWalls,
  projectionCross,
  projectionLinesToWalls,
  wallImageTransform,
  wallOutline,
  type CubeProjector,
  type CubeSize,
  type CubeWallsMode,
} from '@/shared/lib/dipoleCube'
import {
  FRAME_DIM_OPACITY,
  dipoleVectorLength,
  type DipolePoint,
} from '@/shared/lib/dipolePoints'
import {
  MNI_BRAIN_BOUNDS,
  type MniAxis,
  type MniVector,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import { arcSense3d, spiralTipsMm, type SpiralTrailArc } from '@/shared/lib/spiralTrail'
import { TRAIL_ALPHA_HEAD } from '@/shared/lib/playback'
import type { BandFrame } from './playbackClock'

/** Радиус точки облака, px (при кратности узла сетки чуть больше). */
const DOT_RADIUS_PX = 3.5
/** Прибавка радиуса за каждый лишний диполь в узле сетки, px. */
const DOT_RADIUS_OVERLAP_PX = 0.8
/** Радиус и обводка точки в фокусе (выделенный диполь/пакет эпохи), px. */
const FOCUS_DOT_RADIUS_PX = 5
/** Толщина линий проекции фокуса, px. */
const FOCUS_LINE_PX = 2
/** Радиус маркера кадра анимации и его гало, px. */
const MARKER_RADIUS_PX = 4
const MARKER_HALO_PX = 2
/** Толщина шлейфа анимации и витков спирали, px. */
const TRAIL_PX = 2
const SPIRAL_PX = 1.5
/** Курсор: крест и кружок, px. */
const CURSOR_HALF_PX = 6
const CURSOR_RADIUS_PX = 3
const CURSOR_PX = 1.5
/** Каркас куба и рамки стенок, px. */
const BOX_STROKE_PX = 1
/** Подписи осей x/y/z у положительных концов, px. */
const AXIS_LABEL_FONT = '11px system-ui, sans-serif'
/** Отступ подписи оси от края куба, мм. */
const AXIS_LABEL_MM = 10

/** Готовые цвета сцены (токены темы уже разрезолвлены компонентом). */
export type CubeColors = {
  bg: string
  wall: string
  border: string
  text: string
  accent: string
  danger: string
  dipole: string
  vector: string
  white: string
  spiral: Record<'ccw' | 'cw' | 'none', string>
}

/** Сцена куба: всё, что нужно нарисовать одним кадром. */
export type CubeScene = {
  size: CubeSize
  projector: CubeProjector
  wallsMode: CubeWallsMode
  /** Картинки стенок по плоскостям (срез или силуэт; `undefined` — не загружена) */
  wallImages: Partial<Record<ProjectionPlane, HTMLImageElement | undefined>>
  /** Слой «Срез МРТ»: картинки срезов на стенках (режим `slices`) */
  showSliceImages: boolean
  /** Слой «Границы мозга»: MIP-силуэт на стенках (режим `silhouette`) */
  showSilhouette: boolean
  points: DipolePoint[]
  showPoints: boolean
  showVectors: boolean
  spiral: SpiralTrailArc[]
  showSpiral: boolean
  frames: BandFrame[]
  showPlayback: boolean
  /** Точки в фокусе: [выделенная точка] или пакет выбранной эпохи */
  focus: DipolePoint[]
  cursor: MniVector | null
  /** Плей активен — облако приглушается (как в проекциях) */
  dimmed: boolean
  colors: CubeColors
}

/** Отрезок одним вызовом: цвет, толщина и непрозрачность штриха. */
function strokeLine(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  widthPx: number,
  alpha = 1,
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = widthPx
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

/** Залитый кружок (точка диполя, маркер кадра). */
function drawDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radiusPx: number,
  color: string,
  alpha = 1,
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, radiusPx, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Луч момента от точки: направление — проекция вектора ориентации, длина —
 * `dipoleVectorLength` (пиксели; в 3D экран и фигуры делят один масштаб).
 */
function drawRay(
  ctx: CanvasRenderingContext2D,
  point: DipolePoint,
  projector: CubeProjector,
  color: string,
  alpha: number,
): void {
  const orientation = point.orientation
  const norm = Math.hypot(orientation.x, orientation.y, orientation.z)
  if (!(norm > 0)) return
  const lengthPx = dipoleVectorLength(point.amplitudeNaM, point.band?.bandHz ?? null)
  const lengthMm = lengthPx / projector.scale
  const tip = {
    x: point.position.x + (orientation.x / norm) * lengthMm,
    y: point.position.y + (orientation.y / norm) * lengthMm,
    z: point.position.z + (orientation.z / norm) * lengthMm,
  }
  strokeLine(ctx, projector.project(point.position), projector.project(tip), color, 1.5, alpha)
}

/** Средняя глубина стенки (порядок рисования: дальние сначала). */
function wallDepth(wall: { corners: readonly MniVector[] }, projector: CubeProjector): number {
  let total = 0
  for (const corner of wall.corners) {
    total += projector.project(corner).depth
  }
  return total / wall.corners.length
}

/** Луч и точка облака: общий порядок «сначала луч, потом точка поверх». */
function drawCloudPoint(
  ctx: CanvasRenderingContext2D,
  point: DipolePoint,
  projector: CubeProjector,
  scene: CubeScene,
  alpha: number,
): void {
  const color = point.band?.color ?? scene.colors.dipole
  if (scene.showVectors) {
    drawRay(ctx, point, projector, point.band?.color ?? scene.colors.vector, alpha)
  }
  const projected = projector.project(point.position)
  const overlap = Math.max(0, (point.overlapCount ?? 1) - 1)
  const radius = DOT_RADIUS_PX + Math.min(3, overlap * DOT_RADIUS_OVERLAP_PX)
  drawDot(ctx, projected.x, projected.y, radius, color, alpha)
}


/**
 * Рисует сцену куба одним кадром. `dpr` — плотность пикселей канваса: базовый
 * трансформ масштабирует пиксельные размеры, трансформ картинки стенки
 * составляется с ним же (иначе срез «уедет» на экранах с retina).
 */
export function drawCubeScene(
  ctx: CanvasRenderingContext2D,
  scene: CubeScene,
  dpr: number,
): void {
  const { size, projector, colors } = scene
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.fillStyle = colors.bg
  ctx.fillRect(0, 0, size.width, size.height)

  // Стенки: три дальней плоскости куба (дальние сначала), картинка —
  // срез «Срезов MNI» или силуэт мозга по режиму стенок
  const walls = [...cubeWalls()].sort(
    (left, right) => wallDepth(left, projector) - wallDepth(right, projector),
  )
  for (const wall of walls) {
    const outline = wallOutline(wall, projector)
    ctx.beginPath()
    ctx.moveTo(outline[0].x, outline[0].y)
    for (const corner of outline.slice(1)) {
      ctx.lineTo(corner.x, corner.y)
    }
    ctx.closePath()
    ctx.fillStyle = colors.wall
    ctx.fill()
    const image = scene.wallImages[wall.plane]
    const imagesAllowed =
      scene.wallsMode === 'silhouette' ? scene.showSilhouette : scene.showSliceImages
    if (image && imagesAllowed) {
      const [a, b, c, d, e, f] = wallImageTransform(wall, projector)
      ctx.save()
      ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr)
      try {
        ctx.drawImage(image, 0, 0, 1, 1)
      } catch {
        // Картинка не готова/сломана — стенка остаётся залитой без среза
      }
      ctx.restore()
    }
    ctx.strokeStyle = colors.border
    ctx.lineWidth = BOX_STROKE_PX
    ctx.stroke()
  }

  // Каркас куба: 12 рёбер — ракурс читается даже без картинок стенок
  const corners = cubeCorners()
  for (let i = 0; i < corners.length; i += 1) {
    for (let j = i + 1; j < corners.length; j += 1) {
      const left = corners[i]
      const right = corners[j]
      const differs =
        (left.x !== right.x ? 1 : 0) + (left.y !== right.y ? 1 : 0) + (left.z !== right.z ? 1 : 0)
      if (differs !== 1) continue
      strokeLine(ctx, projector.project(left), projector.project(right), colors.border, BOX_STROKE_PX, 0.8)
    }
  }

  // Подписи осей у положительных концов: z вверх, как в фигуре MNE
  ctx.fillStyle = colors.text
  ctx.font = AXIS_LABEL_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const axis of ['x', 'y', 'z'] as MniAxis[]) {
    const tip: MniVector = { ...CUBE_CENTER }
    tip[axis] = MNI_BRAIN_BOUNDS[axis][1] + AXIS_LABEL_MM
    const projected = projector.project(tip)
    ctx.fillText(axis, projected.x, projected.y)
  }

  // Спираль момента (слой «Спираль момента»): витки кончика луча, окраска —
  // знак поворота, непрозрачность гаснет с возрастом витка
  if (scene.showSpiral) {
    for (const arc of scene.spiral) {
      const tips = spiralTipsMm(arc)
      if (tips.length < 2) continue
      ctx.save()
      ctx.globalAlpha = Math.min(1, Math.max(0, arc.alpha / TRAIL_ALPHA_HEAD))
      ctx.strokeStyle = scene.colors.spiral[arcSense3d(arc)]
      ctx.lineWidth = SPIRAL_PX
      ctx.beginPath()
      tips.forEach((tip, index) => {
        const projected = projector.project(tip)
        if (index === 0) ctx.moveTo(projected.x, projected.y)
        else ctx.lineTo(projected.x, projected.y)
      })
      ctx.stroke()
      ctx.restore()
    }
  }

  // Облако диполей: дальние точки сначала (порядок глубины), полосные цвета;
  // в Плей облако приглушается, чтобы движение читалось (как в проекциях)
  if (scene.showPoints) {
    const alpha = scene.dimmed ? FRAME_DIM_OPACITY : 1
    const ordered = scene.points
      .map((point) => ({ point, depth: projector.project(point.position).depth }))
      .sort((left, right) => left.depth - right.depth)
    for (const { point } of ordered) {
      drawCloudPoint(ctx, point, projector, scene, alpha)
    }
  }

  // Фокус: линии проекции точки на стенки + кресты (один диполь — красные
  // линии фигуры MNE, пакет эпохи — линии цветом полосы каждой точки),
  // облако приглушается выше, точки фокуса — поверх со светлой обводкой
  if (scene.focus.length > 0) {
    const wallByPlane = new Map(cubeWalls().map((wall) => [wall.plane, wall]))
    for (const point of scene.focus) {
      const color =
        scene.focus.length === 1
          ? scene.colors.danger
          : (point.band?.color ?? scene.colors.accent)
      const from = projector.project(point.position)
      for (const line of projectionLinesToWalls(point.position)) {
        strokeLine(ctx, from, projector.project(line.end), color, FOCUS_LINE_PX)
        const wall = wallByPlane.get(line.plane)
        if (!wall) continue
        for (const segment of projectionCross(wall, line.end, projector)) {
          strokeLine(ctx, segment.from, segment.to, color, FOCUS_LINE_PX)
        }
      }
    }
    for (const point of scene.focus) {
      const projected = projector.project(point.position)
      drawDot(ctx, projected.x, projected.y, FOCUS_DOT_RADIUS_PX, point.band?.color ?? scene.colors.dipole)
      ctx.save()
      ctx.strokeStyle = scene.colors.white
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(projected.x, projected.y, FOCUS_DOT_RADIUS_PX, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  // Анимация полос (слой «Кадр воспроизведения»): шлейфы, «хвост» перехода и
  // маркер каждой отмеченной полосы — цветом своей полосы
  if (scene.showPlayback) {
    for (const bandFrame of scene.frames) {
      const color = bandFrame.band?.color ?? scene.colors.accent
      for (const segment of bandFrame.trail) {
        strokeLine(
          ctx,
          projector.project(segment.from),
          projector.project(segment.to),
          color,
          TRAIL_PX,
          segment.alpha,
        )
      }
      if (bandFrame.headSegment) {
        strokeLine(
          ctx,
          projector.project(bandFrame.headSegment.from),
          projector.project(bandFrame.headSegment.to),
          color,
          TRAIL_PX,
          0.8,
        )
      }
      const point = bandFrame.point
      if (!point) continue
      const projected = projector.project(point.position)
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = color
      ctx.lineWidth = MARKER_HALO_PX
      ctx.beginPath()
      ctx.arc(projected.x, projected.y, MARKER_RADIUS_PX + 2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
      drawRay(ctx, point, projector, color, 1)
      drawDot(ctx, projected.x, projected.y, MARKER_RADIUS_PX, color)
    }
  }

  // Совместный курсор проекций (мм MNI): перекрестие и кружок
  if (scene.cursor) {
    const cursor = projector.project(scene.cursor)
    const cross = { x: cursor.x, y: cursor.y }
    strokeLine(
      ctx,
      { x: cross.x - CURSOR_HALF_PX, y: cross.y },
      { x: cross.x + CURSOR_HALF_PX, y: cross.y },
      colors.accent,
      CURSOR_PX,
      0.85,
    )
    strokeLine(
      ctx,
      { x: cross.x, y: cross.y - CURSOR_HALF_PX },
      { x: cross.x, y: cross.y + CURSOR_HALF_PX },
      colors.accent,
      CURSOR_PX,
      0.85,
    )
    ctx.save()
    ctx.globalAlpha = 0.85
    ctx.strokeStyle = colors.accent
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.arc(cross.x, cross.y, CURSOR_RADIUS_PX, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

