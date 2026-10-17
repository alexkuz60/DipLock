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
import { useMemo } from 'react'
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
  pointPassesThresholds,
  type DisplayThresholds,
} from '@/shared/lib/dipolePoints'
import {
  SPIRAL_SENSE_COLORS,
  SPIRAL_STROKE_PX,
  arcSenseOnPlane,
  spiralSenseLabel,
  spiralTipsPx,
} from '@/shared/lib/spiralTrail'
import { useSpiralTrail } from './useSpiralTrail'
import { bandVectorPx } from '@/shared/lib/bandColors'
import { TRAIL_ALPHA_HEAD, frameAnchor, interpolatedPoint } from '@/shared/lib/playback'
import { frameSources } from '@/shared/lib/dipoleBatch'
import { contourPathPx } from '@/shared/lib/atlasContours'
import type { ContourShape } from '@/shared/api/types'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import {
  PROJECTION_PADDING,
  projectPoint,
  type PixelPoint,
  type PlaneEdgeLabel,
  type ProjectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import { layerVisible, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { usePlaybackFrame, type BandFrame } from './playbackClock'

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
 * У пакета (С1) кадр — **несколько полос сразу** (`frame.frames`): каждая рисуется
 * своей группой в цвете полосы (точка, гало, вектор фиксированной полосной длины
 * и шлейф), и чекбоксы панели выбирают любую комбинацию — от всех до одной.
 * Одиночный расчёт даёт один кадр без полосы (прежние токены темы).
 *
 * От кликового выделения кадр отличается **гало** — тонким кольцом большего радиуса
 * при том же размере кольца позиции: «все позиции — одинаковые кольца» — правило
 * раздела, и менять размер под курсор времени нельзя.
 *
 * Слои уважаются и здесь: выключенный слой анимации (`playback`) убирает кадр, его
 * луч и шлейф целиком и не трогает облако диполей. Шлейф **не пропадает** вместе с
 * кадром в эпохах без диполя (сглаживание разрывов, 17.10.2026): слой рисуется,
 * пока есть что показать — кадр, его «хвост» перехода или шлейф.
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
  /**
   * Слой анимации (поправка ручной проверки): кадр, его луч и шлейф — **свой
   * слой**, а не часть облака диполей и векторов. Иначе при выключенных позициях
   * гало кадра исчезало бы вместе с облаком, хотя кадр — не облако, а шлейф
   * пропадал бы вместе с лучами. Слой включён по умолчанию; его выключение убирает
   * анимацию целиком и не трогает облако.
   */
  if (!layerVisible(visibility, 'playback')) return null
  const frames = (frame?.frames ?? []).filter(
    (bandFrame) => bandFrame.point !== null || bandFrame.trail.length > 0,
  )
  if (frames.length === 0) return null

  return (
    <g data-testid={`layer-playback-${plane}`}>
      {frames.map((bandFrame) => (
        <BandFrameMarker
          key={bandFrame.band?.key ?? 'single'}
          plane={plane}
          pxPerUnit={pxPerUnit}
          bandFrame={bandFrame}
        />
      ))}
    </g>
  )
}

/** Кадр одной полосы: шлейф, «хвост» перехода, гало, точка и вектор момента. */
function BandFrameMarker({
  plane,
  pxPerUnit,
  bandFrame,
}: {
  plane: ProjectionPlane
  pxPerUnit: number
  bandFrame: BandFrame
}) {
  const { band, point, trail, headSegment } = bandFrame
  // Полосной цвет (гамма red→violet) или токены темы для одиночного расчёта
  const color = band?.color ?? null
  const haloColor = color ?? 'var(--color-accent)'
  const rayColor = color ?? 'var(--color-accent)'
  const trailColor = color ?? 'var(--color-mri-dipole)'
  // Одиночный кадр сохраняет прежние test-id; полосные суффиксируются ключом
  const suffix = band ? `-${band.key}` : ''
  // В анимации луч — фиксированной полосной длины (поток не «дышит» по амплитуде)
  const marker = point
    ? dipoleMarker(plane, point, PROJECTION_PADDING, band ? bandVectorPx(band.bandHz) : undefined)
    : null
  const visual = point ? dipoleRayVisual(point.amplitudeNaM) : null
  // Луч кадра — отдельным объектом: проверка наличия луча в одном месте, без
  // «утверждений о непустоте» внутри разметки
  const ray =
    marker && marker.shaftEnd && marker.head ? { end: marker.shaftEnd, head: marker.head } : null

  return (
    <g data-testid={`frame-${plane}${suffix || '-single'}`}>
      {point ? (
        <title>
          {band
            ? `Кадр воспроизведения (${band.label}): ${dipolePointTitle(point)} — между эпохами кадр интерполирован, анатомия — по измеренной точке его эпохи`
            : `Кадр воспроизведения: ${dipolePointTitle(point)} — между эпохами кадр интерполирован, анатомия — по измеренной точке его эпохи`}
        </title>
      ) : null}
      {trail.length > 0 ? (
        <g data-testid={`frame-trail-${plane}${suffix}`}>
          {trail.map((segment) => {
            const from = projectPoint(plane, segment.from)
            const to = projectPoint(plane, segment.to)
            return (
              <line
                key={segment.id}
                data-testid={`trail-segment-${plane}${suffix}-${segment.id}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={trailColor}
                strokeWidth={TRAIL_STROKE_PX / pxPerUnit}
                strokeOpacity={segment.alpha}
                strokeLinecap="round"
              />
            )
          })}
        </g>
      ) : null}
      {/* «Хвост» текущего перехода: растущий отрезок от якоря к кадру — траектория
          не «моргает» на эпохах без диполя (сглаживание разрывов, 17.10.2026) */}
      {headSegment ? (
        <line
          data-testid={`frame-head-${plane}${suffix}`}
          x1={projectPoint(plane, headSegment.from).x}
          y1={projectPoint(plane, headSegment.from).y}
          x2={projectPoint(plane, headSegment.to).x}
          y2={projectPoint(plane, headSegment.to).y}
          stroke={trailColor}
          strokeWidth={TRAIL_STROKE_PX / pxPerUnit}
          strokeOpacity={TRAIL_ALPHA_HEAD}
          strokeLinecap="round"
        />
      ) : null}
      {marker && point ? (
        <>
          {/* Кадр: гало акцентным цветом плюс кольцо позиции того же размера, что и у
              облака (Ø 6 px) — размер позиции не зависит от того, «сейчас» это или нет */}
          <circle
            data-testid={`frame-halo-${plane}${suffix}`}
            cx={marker.at.x}
            cy={marker.at.y}
            r={DIPOLE_FRAME_HALO_RADIUS_PX / pxPerUnit}
            fill="none"
            stroke={haloColor}
            strokeWidth={DIPOLE_FRAME_HALO_STROKE_PX / pxPerUnit}
          />
          <circle
            data-testid={`frame-dot-${plane}${suffix}`}
            cx={marker.at.x}
            cy={marker.at.y}
            r={DIPOLE_DOT_RADIUS_PX / pxPerUnit}
            fill={color ?? 'var(--color-mri-dipole)'}
            stroke="var(--color-mri-dipole-point)"
            strokeWidth={DIPOLE_DOT_STROKE_PX / pxPerUnit}
          />
          {ray && visual ? (
            <>
              <line
                data-testid={`frame-vector-${plane}${suffix}`}
                x1={marker.at.x}
                y1={marker.at.y}
                x2={ray.end.x}
                y2={ray.end.y}
                stroke={rayColor}
                strokeWidth={DIPOLE_RAY_STROKE_PX / pxPerUnit}
                strokeOpacity={visual.opacity}
              />
              <polygon
                data-testid={`frame-arrow-${plane}${suffix}`}
                points={ray.head.map((vertex) => `${vertex.x},${vertex.y}`).join(' ')}
                fill={rayColor}
                fillOpacity={visual.opacity}
              />
            </>
          ) : null}
        </>
      ) : null}
    </g>
  )
}

/**
 * Подсветка анатомии кадра (п.3, 17.10.2026): поле Бродмана и анатомическая
 * структура, в которых находится диполь текущего кадра, выделяются на проекциях
 * во время анимации — так же, как при кликовом выделении (`data-active` слоёв),
 * но отдельным оверлеем: слои атласа статичны и не перерисовываются на кадрах.
 *
 * Подписка — на **номер эпохи** (`playback.epochIndex`), а не на 60 fps-контекст:
 * метки принадлежат измеренной точке-якорю и меняются только на смене эпохи
 * (несколько раз в секунду). У пакета подсвечивается объединение меток всех
 * отмеченных полос (`frameSources` — те же точки, что у часов кадра). Кадр,
 * скрытый порогами отображения, анатомию не подсвечивает: на картинке его нет.
 */
export function FrameAnatomyHighlight({
  plane,
  visibility,
  structureShapes,
  areaShapes,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  structureShapes: ContourShape[] | null
  areaShapes: ContourShape[] | null
}) {
  const active = useDipoleCalc((state) => state.playback.active)
  const epochIndex = useDipoleCalc((state) => state.playback.epochIndex)
  const result = useDipoleCalc((state) => state.result)
  const batch = useDipoleCalc((state) => state.batch)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const minGofPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const minAmplitudeNaM = useDipoleCalc((state) => state.amplitudeThresholdNam)

  const sources = useMemo(
    () => frameSources(result, batch, playbackBandKeys),
    [result, batch, playbackBandKeys],
  )
  const highlight = useMemo(() => {
    const structures = new Set<string>()
    const areas = new Set<string>()
    if (!active) return { structures, areas }
    const thresholds: DisplayThresholds = { minGofPercent, minAmplitudeNaM }
    for (const { points } of sources) {
      const anchor = frameAnchor(points, epochIndex)
      if (!anchor) continue
      const frame = interpolatedPoint(points, epochIndex, 0)
      if (!frame || !pointPassesThresholds(frame, thresholds)) continue
      if (anchor.structure) structures.add(anchor.structure)
      if (anchor.brodmannArea) areas.add(anchor.brodmannArea)
    }
    return { structures, areas }
  }, [active, sources, epochIndex, minGofPercent, minAmplitudeNaM])

  // Метки точки (`aparc+aseg`/`BA17-lh`) могут приходить и как имя атласа, и как
  // русская подпись — контур ищется по `id`, `name` и `label`
  const match = (shape: ContourShape, labels: Set<string>): boolean =>
    labels.has(shape.id) || labels.has(shape.name) || labels.has(shape.label)
  const structureHighlights = (structureShapes ?? []).filter((shape) =>
    match(shape, highlight.structures),
  )
  const areaHighlights = (areaShapes ?? []).filter((shape) => match(shape, highlight.areas))
  const showStructures = layerVisible(visibility, 'anatomy') && structureHighlights.length > 0
  const showAreas = layerVisible(visibility, 'brodmann') && areaHighlights.length > 0
  if (!showStructures && !showAreas) return null

  return (
    <g data-testid={`layer-frame-anatomy-${plane}`}>
      {showStructures
        ? structureHighlights.map((shape) => (
            <path
              key={`structure-${shape.id}`}
              data-testid={`frame-anatomy-${plane}-${shape.id}`}
              d={contourPathPx(plane, shape)}
              fillRule="evenodd"
              fill="var(--color-mri-structure)"
              fillOpacity={0.3}
              stroke="var(--color-mri-structure)"
              strokeOpacity={0.95}
              strokeWidth={1.6}
            >
              <title>{`Анатомия кадра: ${shape.label}`}</title>
            </path>
          ))
        : null}
      {showAreas
        ? areaHighlights.map((shape) => (
            <path
              key={`area-${shape.id}`}
              data-testid={`frame-area-${plane}-${shape.id}`}
              d={contourPathPx(plane, shape)}
              fillRule="evenodd"
              fill="var(--color-mri-brodmann)"
              fillOpacity={0.32}
              stroke="var(--color-mri-brodmann)"
              strokeOpacity={0.95}
              strokeWidth={1.8}
            >
              <title>{`Поле Бродмана кадра: ${shape.label}`}</title>
            </path>
          ))
        : null}
    </g>
  )
}


/**
 * Слой «Спираль момента» (срез 3.11): затухающий шлейф витков кончика луча
 * момента вдоль траектории.
 *
 * Шлейф строит `useSpiralTrail` (окно последних секунд и угасание с возрастом —
 * как у шлейфа кадра анимации), здесь только отрисовка: виток — полилиния
 * кончиков луча (`spiralTipsPx`), цвет — знак поворота момента **на этой
 * проекции** (`arcSenseOnPlane`), непрозрачность — `arc.alpha`, легенда — в
 * подсказке слоя. Подписка — на номер эпохи кадра (шлейф следует за ним), а не
 * на 60 fps-контекст. Шлейф — отображение интерполяции (slerp), а не измерение.
 */
export function SpiralTrailLayer({
  plane,
  visibility,
  pxPerUnit,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  pxPerUnit: number
}) {
  const arcs = useSpiralTrail()
  if (!layerVisible(visibility, 'spiral') || arcs.length === 0) return null
  return (
    <g data-testid={`layer-spiral-${plane}`}>
      {arcs.map((arc) => {
        const sense = arcSenseOnPlane(arc, plane)
        const tips = spiralTipsPx(arc, plane)
        return (
          <path
            key={arc.id}
            data-testid={`spiral-arc-${plane}-${arc.id}`}
            d={tips.map((tip, index) => `${index === 0 ? 'M' : 'L'}${tip.x},${tip.y}`).join(' ')}
            fill="none"
            stroke={SPIRAL_SENSE_COLORS[sense]}
            strokeWidth={SPIRAL_STROKE_PX / pxPerUnit}
            strokeOpacity={arc.alpha}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <title>
              {`Спираль момента: эпоха ${arc.from.epochIndex + 1} → ${arc.to.epochIndex + 1} — ${spiralSenseLabel(sense)}`}
            </title>
          </path>
        )
      })}
    </g>
  )
}
