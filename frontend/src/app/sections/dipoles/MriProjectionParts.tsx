/**
 * Части проекции мозга: подписи краёв фигуры и маркер кадра воспроизведения.
 *
 * Вынесены из `MriProjection.tsx` (правило `docs/rules/frontend-state.md` п.6:
 * компонент рисует, но не считает; файл-хозяин остаётся сборкой слоёв). Общего
 * состояния у частей нет, поэтому они принимают только пропсы:
 *
 * * `EdgeLabel` — буква направления края (L/R, A/P, S/I) с пояснением в
 *   `<title>`; сами подписи считает `planeEdgeLabels` из знаков осей;
 * * `ReferenceCross` — перекрестие точки клика: XY-линии плоскостей MNI-срезов
 *   в этой точке плюс короткий штрих на самой точке (поправка ручной проверки);
 * * `FrameMarker` — кадр воспроизведения траектории (срез 3.7): его обновляет
 *   контекст (`usePlaybackFrame`), поэтому статичные слои проекции при движении
 *   кадра не перерисовываются.
 */
import {
  DIPOLE_DOT_RADIUS_PX,
  DIPOLE_DOT_STROKE_PX,
  DIPOLE_FRAME_HALO_RADIUS_PX,
  DIPOLE_FRAME_HALO_STROKE_PX,
  DIPOLE_RAY_STROKE_PX,
  TRAIL_STROKE_PX,
  dipoleMarker,
  dipolePointTitle,
  dipoleRayVisual,
} from '@/shared/lib/dipolePoints'
import {
  PROJECTION_PADDING,
  projectPoint,
  type PixelPoint,
  type PlaneEdgeLabel,
  type ProjectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import { layerVisible, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { usePlaybackFrame } from './playbackClock'

/** Подпись края фигуры: буква направления плюс пояснение в тултипе. */
export function EdgeLabel({
  testId,
  label,
  x,
  y,
  anchor,
}: {
  testId: string
  label: PlaneEdgeLabel
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
}) {
  return (
    <g data-testid={testId}>
      <title>{label.hint}</title>
      <text
        x={x}
        y={y}
        textAnchor={anchor}
        dominantBaseline="middle"
        fontSize={11}
        fill="var(--color-fg-2)"
      >
        {label.text}
      </text>
    </g>
  )
}

/** Полудлина штриха перекрестия в точке клика (px фигуры) и его толщина. */
export const REFERENCE_TICK_PX = 6
export const REFERENCE_TICK_STROKE_PX = 1.4

/**
 * Толщина и плотность XY-линий плоскостей срезов: линии длинные, поэтому они
 * приглушены относительно штриха точки — иначе перекрестие спорило бы с сеткой
 * MNI и анатомией за внимание. Пунктира нет: пунктир — признак сетки/следа среза.
 */
export const REFERENCE_PLANE_STROKE_PX = 1.2
export const REFERENCE_PLANE_OPACITY = 0.55

/**
 * Перекрестие точки клика: **XY-линии плоскостей MNI-срезов** в этой точке
 * (поправка ручной проверки) плюс короткий штрих на самой точке.
 *
 * Клик по проекции задаёт точку MNI (две координаты — из позиции клика, третья —
 * из среза плоскости), и `applyPointToSlices` наводит её на **все три** среза.
 * Линии показывают, где проходят плоскости этих срезов: на каждой проекции —
 * вертикаль (одна ось плоскости) и горизонталь (другая), от края до края
 * прямоугольника плоскости. Без них видно только «точку», а связь «клик →
 * плоскости срезов» приходилось читать по подписям в панели. Штрих в центре
 * остаётся: он отмечает саму точку клика, которой соответствуют координаты в
 * строке под фигурой.
 *
 * Рисуется это **во всех трёх** проекциях (проп `reference` раздела) и не
 * подчиняется слоям: перекрестие — состояние просмотра, а не слой данных.
 * Цвет — токен перекрестия (`--color-accent`, как и след среза): третий синий
 * оттенок здесь завёл бы вторую «легенду» одного и того же смысла.
 */
export function ReferenceCross({
  plane,
  at,
  box,
  padding = PROJECTION_PADDING,
}: {
  plane: ProjectionPlane
  /** Точка клика в пикселях фигуры (`projectPoint`) */
  at: PixelPoint
  /** Габариты фигуры: линии тянутся по её прямоугольнику плоскости */
  box: ProjectionBox
  padding?: number
}) {
  const left = padding
  const right = box.width - padding
  const top = padding
  const bottom = box.height - padding

  return (
    <g
      data-testid={`reference-${plane}`}
      aria-hidden
      stroke="var(--color-accent)"
      strokeWidth={REFERENCE_TICK_STROKE_PX}
    >
      {/* XY-линии плоскостей срезов: вертикаль — ось одной, горизонталь — другой */}
      <line
        data-testid={`reference-plane-${plane}-vertical`}
        x1={at.x}
        y1={top}
        x2={at.x}
        y2={bottom}
        strokeWidth={REFERENCE_PLANE_STROKE_PX}
        strokeOpacity={REFERENCE_PLANE_OPACITY}
      />
      <line
        data-testid={`reference-plane-${plane}-horizontal`}
        x1={left}
        y1={at.y}
        x2={right}
        y2={at.y}
        strokeWidth={REFERENCE_PLANE_STROKE_PX}
        strokeOpacity={REFERENCE_PLANE_OPACITY}
      />
      {/* Точка клика: короткий штрих поверх линий — плотнее и заметнее самих линий */}
      <line x1={at.x - REFERENCE_TICK_PX} y1={at.y} x2={at.x + REFERENCE_TICK_PX} y2={at.y} />
      <line x1={at.x} y1={at.y - REFERENCE_TICK_PX} x2={at.x} y2={at.y + REFERENCE_TICK_PX} />
    </g>
  )
}

/**
 * Маркер кадра воспроизведения (срез 3.7): интерполированная точка текущей эпохи
 * поверх приглушённого облака. Кадр приходит **контекстом**, поэтому маркер
 * обновляется сам (60 раз в секунду), а статичные слои проекции не перерисовываются.
 *
 * От кликового выделения кадр отличается **гало** — тонким кольцом большего радиуса
 * при том же размере кольца позиции: «все позиции — одинаковые кольца» — правило
 * раздела, и менять размер под курсор времени нельзя.
 *
 * Слои уважаются и здесь: выключенный слой анимации (`playback`) убирает кадр, его
 * луч и шлейф целиком и не трогает облако диполей.
 */
export function FrameMarker({
  plane,
  visibility,
  pxPerUnit,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  pxPerUnit: number
}) {
  const frame = usePlaybackFrame()
  const point = frame?.point ?? null
  /**
   * Слой анимации (поправка ручной проверки): кадр, его луч и шлейф — **свой
   * слой**, а не часть облака диполей и векторов. Иначе при выключенных позициях
   * гало кадра исчезало бы вместе с облаком, хотя кадр — не облако, а шлейф
   * пропадал бы вместе с лучами. Слой включён по умолчанию; его выключение убирает
   * анимацию целиком и не трогает облако.
   */
  if (!point || !layerVisible(visibility, 'playback')) return null

  const marker = dipoleMarker(plane, point)
  const visual = dipoleRayVisual(point.amplitudeNaM)
  // Луч кадра — отдельным объектом: проверка наличия луча в одном месте, без
  // «утверждений о непустоте» внутри разметки
  const ray =
    marker.shaftEnd && marker.head ? { end: marker.shaftEnd, head: marker.head } : null
  // Шлейф принадлежит кадру (это история измерений, а не ещё один слой диполей):
  // нет кадра — нет и шлейфа, а при выключенных позициях он остаётся
  const trail = frame?.trail ?? []

  return (
    <g data-testid={`layer-playback-${plane}`}>
      <title>{`Кадр воспроизведения: ${dipolePointTitle(point)}`}</title>
      {trail.length > 0 ? (
        <g data-testid={`frame-trail-${plane}`}>
          {trail.map((segment) => {
            const from = projectPoint(plane, segment.from)
            const to = projectPoint(plane, segment.to)
            return (
              <line
                key={segment.id}
                data-testid={`trail-segment-${plane}-${segment.id}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="var(--color-mri-dipole)"
                strokeWidth={TRAIL_STROKE_PX / pxPerUnit}
                strokeOpacity={segment.alpha}
                strokeLinecap="round"
              />
            )
          })}
        </g>
      ) : null}
      {/* Кадр: гало акцентным цветом плюс кольцо позиции того же размера, что и у
          облака (Ø 6 px) — размер позиции не зависит от того, «сейчас» это или нет */}
      <circle
        data-testid={`frame-halo-${plane}`}
        cx={marker.at.x}
        cy={marker.at.y}
        r={DIPOLE_FRAME_HALO_RADIUS_PX / pxPerUnit}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={DIPOLE_FRAME_HALO_STROKE_PX / pxPerUnit}
      />
      <circle
        data-testid={`frame-dot-${plane}`}
        cx={marker.at.x}
        cy={marker.at.y}
        r={DIPOLE_DOT_RADIUS_PX / pxPerUnit}
        fill="var(--color-mri-dipole)"
        stroke="var(--color-mri-dipole-point)"
        strokeWidth={DIPOLE_DOT_STROKE_PX / pxPerUnit}
      />
      {ray ? (
        <>
          <line
            data-testid={`frame-vector-${plane}`}
            x1={marker.at.x}
            y1={marker.at.y}
            x2={ray.end.x}
            y2={ray.end.y}
            stroke="var(--color-accent)"
            strokeWidth={DIPOLE_RAY_STROKE_PX / pxPerUnit}
            strokeOpacity={visual.opacity}
          />
          <polygon
            data-testid={`frame-arrow-${plane}`}
            points={ray.head.map((vertex) => `${vertex.x},${vertex.y}`).join(' ')}
            fill="var(--color-accent)"
            fillOpacity={visual.opacity}
          />
        </>
      ) : null}
    </g>
  )
}
