/**
 * Части проекции мозга: подписи краёв фигуры и маркер кадра воспроизведения.
 *
 * Вынесены из `MriProjection.tsx` (правило `docs/rules/frontend-state.md` п.6:
 * компонент рисует, но не считает; файл-хозяин остаётся сборкой слоёв). Общего
 * состояния у частей нет, поэтому они принимают только пропсы:
 *
 * * `EdgeLabel` — буква направления края (L/R, A/P, S/I) с пояснением в
 *   `<title>`; сами подписи считает `planeEdgeLabels` из знаков осей;
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
import { projectPoint, type PlaneEdgeLabel, type ProjectionPlane } from '@/shared/lib/mriProjections'
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
