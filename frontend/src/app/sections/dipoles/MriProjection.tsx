/**
 * Проекция мозга: срез с фоновыми слоями и точками диполей (срез 3.1).
 *
 * Фигура — **SVG, а не canvas**: цвета берутся напрямую токенами темы
 * (`var(--color-mri-*)`), геометрия — из `shared/lib/mriProjections.ts`, поэтому
 * отрисовка не дублирует ни цвета, ни математику. Canvas понадобится только там,
 * где нужна пиксельная заливка реального тома МРТ (см. `docs/ui.md` §3.3).
 *
 * Слои снизу вверх (порядок и подписи — в `shared/state/dipoleParams.ts`):
 * `head` — силуэт головы на срезе, `mni` — схема среза с координатной сеткой и
 * следами соседних срезов, `brodmann` — поля Бродмана, `dipoles` — точки диполей
 * с векторами моментов. Каждый слой включается отдельно; выключенный слой не
 * рисуется вовсе, а не прячется прозрачностью.
 *
 * Компонент **не управляет состоянием раздела**: срезы, видимость слоёв и
 * референс-точка приходят пропсами из `DipolesSection`, а клик отдаётся наверх
 * через `onPick`. В локальном состоянии живёт только «точка под курсором» — она
 * нужна текущей отрисовке и не переживает выход из раздела.
 */
import { useMemo, useState, type MouseEvent } from 'react'
import {
  PROJECTION_HINTS,
  PROJECTION_LABELS,
  PROJECTION_PADDING,
  PROJECTION_SIZE,
  brodmannAreaAt,
  coordsLabel,
  demoBrodmannAreas,
  demoHeadContours,
  demoSliceStructures,
  normalizedToPx,
  planeEdgeLabels,
  planeGridLines,
  pointFromProjectionClick,
  projectPoint,
  pxToNormalized,
  sliceGuides,
  sliceLabel,
  type MniVector,
  type PixelPoint,
  type PlaneEdgeLabel,
  type ProjectionPlane,
  type SliceTriplet,
} from '@/shared/lib/mriProjections'
import {
  dipoleMarker,
  dipolePointTitle,
  emptyDipoleLayer,
  type DipoleLayer,
} from '@/shared/lib/dipolePoints'
import { layerVisible, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { cx } from '@/shared/ui/cx'

export type MriProjectionProps = {
  plane: ProjectionPlane
  /** Срезы всех трёх плоскостей: фигура показывает свой срез и следы соседних */
  slices: SliceTriplet
  /** Видимость фоновых слоёв (состояние раздела) */
  visibility: Record<DipoleLayerId, boolean>
  /**
   * Точки диполей. По умолчанию — пустой слой: раздел не имитирует расчёт,
   * точки придут из результата задачи (следующий срез фазы 3).
   */
  points?: DipoleLayer
  /** Выделенное поле Бродмана: подсвечивается, остальные приглушаются */
  selectedArea?: string | null
  /** Референс-точка сессии (перекрестие на всех проекциях) */
  reference?: MniVector | null
  /** Клик по срезу: точка MNI в плоскости среза + поле Бродмана под кликом */
  onPick?: (point: MniVector, area: string | null) => void
  size?: number
  className?: string
}

export function MriProjection({
  plane,
  slices,
  visibility,
  points = emptyDipoleLayer(),
  selectedArea = null,
  reference = null,
  onPick,
  size = PROJECTION_SIZE,
  className,
}: MriProjectionProps) {
  const sliceMm = slices[plane]
  /** «Точка под курсором» — только для текущей отрисовки (в стор не уходит) */
  const [hover, setHover] = useState<MniVector | null>(null)

  const half = (size - PROJECTION_PADDING * 2) / 2

  const contour = useMemo(
    () =>
      demoHeadContours(plane, sliceMm)
        .map((point) => normalizedToPx(point, size, PROJECTION_PADDING))
        .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join(' '),
    [plane, sliceMm, size],
  )

  const structures = useMemo(() => demoSliceStructures(plane, sliceMm), [plane, sliceMm])
  const areas = useMemo(() => demoBrodmannAreas(plane, sliceMm), [plane, sliceMm])
  const grid = useMemo(() => planeGridLines(plane), [plane])
  const guides = useMemo(() => sliceGuides(plane, slices), [plane, slices])
  const edges = useMemo(() => planeEdgeLabels(plane), [plane])

  const markers = useMemo(
    () =>
      points.points.map((point) => ({
        point,
        marker: dipoleMarker(plane, point, size, PROJECTION_PADDING),
      })),
    [plane, points, size],
  )

  const referencePx = reference ? projectPoint(plane, reference, size, PROJECTION_PADDING) : null
  const hoverPx = hover ? projectPoint(plane, hover, size, PROJECTION_PADDING) : null

  /**
   * Координаты курсора в пикселях фигуры. `getBoundingClientRect` нужен, потому
   * что фигура растягивается по ширине колонки: атрибутная система координат
   * (`viewBox`) и экранная не совпадают. В jsdom ширина rect нулевая — тогда
   * считаем масштаб 1:1, и тесты работают в координатах viewBox.
   */
  const pxOf = (event: MouseEvent<SVGSVGElement>): PixelPoint => {
    const rect = event.currentTarget.getBoundingClientRect()
    const scaleX = rect.width > 0 ? size / rect.width : 1
    const scaleY = rect.height > 0 ? size / rect.height : 1
    const limit = size - PROJECTION_PADDING
    return {
      x: Math.min(limit, Math.max(PROJECTION_PADDING, (event.clientX - rect.left) * scaleX)),
      y: Math.min(limit, Math.max(PROJECTION_PADDING, (event.clientY - rect.top) * scaleY)),
    }
  }

  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!onPick) return
    const px = pxOf(event)
    // Поле Бродмана ищем по той же геометрии, что нарисована: попадание в эллипс
    onPick(
      pointFromProjectionClick(plane, sliceMm, px, size, PROJECTION_PADDING),
      brodmannAreaAt(plane, sliceMm, pxToNormalized(px, size, PROJECTION_PADDING)),
    )
  }

  const handleHover = (event: MouseEvent<SVGSVGElement>) => {
    setHover(pointFromProjectionClick(plane, sliceMm, pxOf(event), size, PROJECTION_PADDING))
  }

  // Текст подписи над фигурой: под курсором — координаты точки, иначе пояснение
  const footnote = hover ? coordsLabel(hover) : PROJECTION_HINTS[plane]

  return (
    <figure
      data-testid={`projection-${plane}`}
      className={cx('flex min-w-0 flex-col gap-1', className)}
    >
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-fg-0">{PROJECTION_LABELS[plane]}</span>
        <span className="tnum font-mono text-sm text-mri-slice">{sliceLabel(plane, sliceMm)}</span>
      </figcaption>

      <svg
        data-testid={`projection-svg-${plane}`}
        viewBox={`0 0 ${size} ${size}`}
        width="100%"
        role="img"
        aria-label={`${PROJECTION_LABELS[plane]} проекция, ${sliceLabel(plane, sliceMm)}: ${PROJECTION_HINTS[plane]}`}
        className={cx(
          'h-auto w-full rounded-lg border border-border bg-bg-1',
          onPick && 'cursor-crosshair',
        )}
        onClick={handleClick}
        onMouseMove={handleHover}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {/* Наконечник вектора момента: свой id на проекцию, чтобы не совпадали */}
          <marker
            id={`dipole-arrow-${plane}`}
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 z" fill="var(--color-mri-dipole)" />
          </marker>
        </defs>
        {layerVisible(visibility, 'head') ? (
          <polygon
            data-testid={`layer-head-${plane}`}
            points={contour}
            fill="var(--color-mri-outline)"
            fillOpacity={0.07}
            stroke="var(--color-mri-outline)"
            strokeOpacity={0.75}
            strokeWidth={1.2}
          />
        ) : null}

        {layerVisible(visibility, 'mni') ? (
          <g data-testid={`layer-mni-${plane}`}>
            {/* Координатная сетка MNI: нулевые линии — оси AC–PC, они ярче */}
            {grid.map((line) => {
              const zero = line.valueMm === 0
              if (line.orientation === 'vertical') {
                const x = xOfNormalized(line.at, size)
                return (
                  <line
                    key={`grid-v-${line.valueMm}`}
                    data-testid={`grid-${plane}-v-${line.valueMm}`}
                    x1={x}
                    y1={PROJECTION_PADDING}
                    x2={x}
                    y2={size - PROJECTION_PADDING}
                    stroke="var(--color-mri-slice)"
                    strokeOpacity={zero ? 0.45 : 0.16}
                    strokeDasharray={zero ? undefined : '3 4'}
                  />
                )
              }
              const y = yOfNormalized(line.at, size)
              return (
                <line
                  key={`grid-h-${line.valueMm}`}
                  data-testid={`grid-${plane}-h-${line.valueMm}`}
                  x1={PROJECTION_PADDING}
                  y1={y}
                  x2={size - PROJECTION_PADDING}
                  y2={y}
                  stroke="var(--color-mri-slice)"
                  strokeOpacity={zero ? 0.45 : 0.16}
                  strokeDasharray={zero ? undefined : '3 4'}
                />
              )
            })}

            {/* Схема среза: желудочки, мозолистое тело, ствол — фикстура тома */}
            {structures.map((structure) => {
              const center = normalizedToPx(structure.center, size, PROJECTION_PADDING)
              return (
                <ellipse
                  key={structure.id}
                  data-testid={`slice-structure-${plane}-${structure.id}`}
                  cx={center.x}
                  cy={center.y}
                  rx={structure.radius.u * half}
                  ry={structure.radius.v * half}
                  fill={structure.hollow ? 'none' : 'var(--color-mri-slice)'}
                  fillOpacity={structure.hollow ? 0 : 0.12 * structure.alpha}
                  stroke="var(--color-mri-slice)"
                  strokeOpacity={0.5 * structure.alpha}
                  strokeWidth={1.1}
                />
              )
            })}

            {/* Следы срезов соседних проекций: только когда сосед стоит на оси */}
            {guides.map((guide) =>
              guide.axis === 'vertical' ? (
                <line
                  key={guide.label}
                  data-testid={`guide-${plane}-${guide.orientation}`}
                  x1={xOfNormalized(guide.at, size)}
                  y1={PROJECTION_PADDING}
                  x2={xOfNormalized(guide.at, size)}
                  y2={size - PROJECTION_PADDING}
                  stroke="var(--color-mri-slice)"
                  strokeOpacity={0.4}
                  strokeDasharray="6 4"
                />
              ) : (
                <line
                  key={guide.label}
                  data-testid={`guide-${plane}-${guide.orientation}`}
                  x1={PROJECTION_PADDING}
                  y1={yOfNormalized(guide.at, size)}
                  x2={size - PROJECTION_PADDING}
                  y2={yOfNormalized(guide.at, size)}
                  stroke="var(--color-mri-slice)"
                  strokeOpacity={0.4}
                  strokeDasharray="6 4"
                />
              ),
            )}
          </g>
        ) : null}
        {layerVisible(visibility, 'brodmann') ? (
          <g data-testid={`layer-brodmann-${plane}`}>
            {areas.map((area) => {
              const center = normalizedToPx(area.center, size, PROJECTION_PADDING)
              const active = selectedArea === area.name
              return (
                <g
                  key={area.name}
                  data-testid={`brodmann-${plane}-${area.name}`}
                  data-active={active ? 'true' : 'false'}
                >
                  <ellipse
                    cx={center.x}
                    cy={center.y}
                    rx={area.radius.u * half}
                    ry={area.radius.v * half}
                    fill="var(--color-mri-brodmann)"
                    fillOpacity={(active ? 0.32 : 0.13) * area.alpha}
                    stroke="var(--color-mri-brodmann)"
                    strokeOpacity={(active ? 0.95 : 0.5) * area.alpha}
                    strokeWidth={active ? 1.8 : 1}
                  />
                  <text
                    x={center.x}
                    y={center.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={10}
                    fill="var(--color-mri-brodmann)"
                    fillOpacity={Math.max(0.35, area.alpha)}
                  >
                    {area.name}
                  </text>
                </g>
              )
            })}
          </g>
        ) : null}

        {layerVisible(visibility, 'dipoles') ? (
          <g data-testid={`layer-dipoles-${plane}`}>
            {markers.map(({ point, marker }) => (
              <g key={point.id} data-testid={`dipole-${plane}-${point.id}`}>
                <title>{dipolePointTitle(point)}</title>
                {/* Вектор момента: null у `end` — момент вдоль нормали среза */}
                {marker.end ? (
                  <line
                    data-testid={`dipole-vector-${plane}-${point.id}`}
                    x1={marker.at.x}
                    y1={marker.at.y}
                    x2={marker.end.x}
                    y2={marker.end.y}
                    stroke="var(--color-mri-dipole)"
                    strokeWidth={1.6}
                    markerEnd={`url(#dipole-arrow-${plane})`}
                  />
                ) : null}
                <circle
                  data-testid={`dipole-dot-${plane}-${point.id}`}
                  cx={marker.at.x}
                  cy={marker.at.y}
                  r={4}
                  fill="var(--color-mri-dipole)"
                  fillOpacity={0.85}
                  stroke="var(--color-bg-0)"
                  strokeWidth={1}
                />
              </g>
            ))}
          </g>
        ) : null}
        {referencePx ? (
          <g
            data-testid={`reference-${plane}`}
            aria-hidden
            stroke="var(--color-accent)"
            strokeWidth={1.4}
          >
            <line
              x1={referencePx.x - 6}
              y1={referencePx.y}
              x2={referencePx.x + 6}
              y2={referencePx.y}
            />
            <line
              x1={referencePx.x}
              y1={referencePx.y - 6}
              x2={referencePx.x}
              y2={referencePx.y + 6}
            />
          </g>
        ) : null}

        {hoverPx ? (
          <circle
            data-testid={`hover-${plane}`}
            cx={hoverPx.x}
            cy={hoverPx.y}
            r={3}
            fill="none"
            stroke="var(--color-fg-0)"
            strokeOpacity={0.7}
          />
        ) : null}

        {/* Края фигуры подписаны по знакам осей: L/R, A/P, S/I */}
        <EdgeLabel
          testId={`edge-${plane}-left`}
          label={edges.left}
          x={PROJECTION_PADDING / 2}
          y={size / 2}
          anchor="middle"
        />
        <EdgeLabel
          testId={`edge-${plane}-right`}
          label={edges.right}
          x={size - PROJECTION_PADDING / 2}
          y={size / 2}
          anchor="middle"
        />
        <EdgeLabel
          testId={`edge-${plane}-top`}
          label={edges.top}
          x={size / 2}
          y={PROJECTION_PADDING / 2}
          anchor="middle"
        />
        <EdgeLabel
          testId={`edge-${plane}-bottom`}
          label={edges.bottom}
          x={size / 2}
          y={size - PROJECTION_PADDING / 2}
          anchor="middle"
        />
      </svg>

      <p
        data-testid={`projection-readout-${plane}`}
        className="tnum min-h-5 font-mono text-xs text-fg-2"
      >
        {footnote}
      </p>
    </figure>
  )
}

/** Подпись края фигуры: буква направления плюс пояснение в тултипе. */
function EdgeLabel({
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

/** Пиксельная горизонталь по нормализованной координате: сетка и следы срезов. */
function xOfNormalized(u: number, size: number): number {
  return normalizedToPx({ u, v: 0 }, size, PROJECTION_PADDING).x
}

/** Пиксельная вертикаль по нормализованной координате (ось v растёт вверх). */
function yOfNormalized(v: number, size: number): number {
  return normalizedToPx({ u: 0, v }, size, PROJECTION_PADDING).y
}
