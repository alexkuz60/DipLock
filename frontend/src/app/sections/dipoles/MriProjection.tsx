/**
 * Проекция мозга: срез с фоновыми слоями и точками диполей (срез 3.1, срез МРТ — 3.2).
 *
 * Фигура — **SVG, а не canvas**: цвета берутся напрямую токенами темы
 * (`var(--color-mri-*)`), геометрия — из `shared/lib/mriProjections.ts`, а срез
 * томографии приходит готовым PNG и вставляется как `<image>` (браузер сам
 * кэширует картинки по URL — пиксели не проходят через JS).
 *
 * Слои снизу вверх (порядок и подписи — в `shared/state/dipoleParams.ts`):
 * `mri` — реальный срез T1, `head` — силуэт головы на срезе, `mni` — сетка и
 * схема среза, `brodmann` — поля Бродмана, `dipoles` — позиции диполей,
 * `vectors` — векторы моментов. Каждый слой включается отдельно; выключенный
 * слой не рисуется вовсе, а не прячется прозрачностью. Позиции и векторы —
 * **разные слои** (срез 3.5): «где» и «куда» отвечают на разные вопросы, и при
 * плотном облаке точек лучи мешают читать позиции (и наоборот).
 *
 * Позиция диполя — белое кольцо **фиксированного экранного размера** (Ø 10 px,
 * штрих 2 px при любом размере окна: фигура растягивается по ширине колонки,
 * поэтому геометрия кольца делится на масштаб `renderedWidth / viewBox.width`,
 * который отслеживает ResizeObserver). Выделенный диполь залит оранжево-жёлтым.
 * Сила момента видна по лучу (`dipoleRayVisual` в `shared/lib/dipolePoints.ts`),
 * а не по размеру кольца; толщина луча тоже фиксирована (2 px по экрану), как и
 * штрих кольца. Наконечник вектора рисуется полигоном с длиной от длины луча:
 * размер `<marker>` SVG один на всю проекцию, поэтому на коротком луче стрелка
 * накрывала бы весь луч, а на длинном выглядела бы точкой.
 *
 * Клик по точке **выделяет диполь** (`onSelectPoint`) **и наводит срезы** на его
 * позицию (`onPick`): поправка ручной проверки — срезы обязаны меняться при
 * любом клике по фигуре. `stopPropagation` остаётся, чтобы клик не обработался
 * дважды: фигура навела бы срезы на «сырую» точку клика, а хит-зона шире кольца.
 *
 * Координаты под курсором — только текстом в строке под фигурой: маркера,
 * бегающего за мышью, нет, чтобы его не путали с кольцами диполей.
 *
 * Кадр воспроизведения (срез 3.7) рисуется отдельным компонентом `FrameMarker`:
 * он берёт кадр из контекста (`PlaybackFrame.tsx`) и потому обновляется сам, а
 * статичные слои при движении кадра не перерисовываются. В режиме кадра облако
 * приглушается (`dimmed`) — иначе сотни колец спорят с маркером за внимание.
 *
 * Схема среза (`demoSliceStructures`) — фикстура анатомии: она показывается только
 * без реального тома, иначе рисовала бы «вторую» анатомию поверх настоящей.
 * Силуэт головы остаётся: это граница черепа (в маске МРТ её нет), а не имитация
 * среза.
 *
 * Компонент **не управляет состоянием раздела**: срезы, видимость слоёв,
 * ссылка на срезы МРТ и референс-точка приходят пропсами из `DipolesSection`, а
 * клик отдаётся наверх через `onPick`. В локальном состоянии живёт «точка под
 * курсором» и признак недоступной картинки — они нужны текущей отрисовке.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import {
  PROJECTION_HINTS,
  PROJECTION_LABELS,
  PROJECTION_PADDING,
  brodmannAreaAt,
  coordsLabel,
  demoBrodmannAreas,
  demoHeadContours,
  demoSliceStructures,
  ellipsePx,
  mniToNormalized,
  normalizedToPx,
  planeEdgeLabels,
  planeGridLines,
  pointFromProjectionClick,
  projectPoint,
  projectionBox,
  pxToNormalized,
  sliceGuides,
  sliceLabel,
  type MniVector,
  type PixelPoint,
  type PlaneEdgeLabel,
  type ProjectionPlane,
  type SliceTriplet,
} from '@/shared/lib/mriProjections'
import { MRI_SLICE_UNAVAILABLE, mriSliceRect, mriSliceUrl } from '@/shared/lib/mriSlices'
import {
  contourPathPx,
  shapeAtPoint,
} from '@/shared/lib/atlasContours'
import type { ContourSlice, MriSliceRef } from '@/shared/api/types'
import {
  DIPOLE_DOT_RADIUS_PX,
  DIPOLE_DOT_STROKE_PX,
  DIPOLE_FRAME_HALO_RADIUS_PX,
  DIPOLE_FRAME_HALO_STROKE_PX,
  DIPOLE_RAY_STROKE_PX,
  DOT_HIT_RADIUS_PX,
  FRAME_DIM_OPACITY,
  TRAIL_STROKE_PX,
  dipoleMarker,
  dipolePointTitle,
  dipoleRayVisual,
  emptyDipoleLayer,
  type DipoleLayer,
} from '@/shared/lib/dipolePoints'
import { layerVisible, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { cx } from '@/shared/ui/cx'
import { usePlaybackFrame } from './playbackClock'

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
  /** Выделенная структура атласа (имя метки) — подсвечивается, как и поле */
  selectedStructure?: string | null
  /**
   * Контуры атласа для этого среза (срез 3.9). `null` — ассета нет: слои рисуют
   * условные фигуры (`demoBrodmannAreas`), честно помеченные как схема. Пустой
   * массив меток — это «на срезе их нет», а не «данных нет», и подменять одно
   * другим нельзя.
   */
  contours?: ContourSlice | null
  /**
   * Режим кадра воспроизведения (срез 3.7): облако точек приглушается, чтобы
   * движение читалось. Сам маркер кадра приходит контекстом (`usePlaybackFrame`).
   */
  dimmed?: boolean
  /** Выделенный диполь: подсвечивается на **всех** проекциях (id из `points`) */
  selectedPointId?: string | null
  /** Клик по точке диполя: выделить (или снять — `null` при повторном клике) и навести срезы (`onPick`) */
  onSelectPoint?: (id: string | null) => void
  /** Референс-точка сессии (перекрестие на всех проекциях) */
  reference?: MniVector | null
  /**
   * Ссылка на срезы МРТ из `/meta` (срез 3.2). Без неё слой `mri` просто не
   * рисуется: раздел не догадывается о версии тома сам, её объявляет сервер.
   */
  mri?: MriSliceRef | null
  /** Клик по срезу: точка MNI в плоскости среза + поле и структура под кликом */
  onPick?: (point: MniVector, area: string | null, structure: string | null) => void
  className?: string
  /** Внешние размеры фигуры в раскладке раздела (ширина колонки задаётся снаружи) */
  style?: CSSProperties
}

export function MriProjection({
  plane,
  slices,
  visibility,
  points = emptyDipoleLayer(),
  selectedArea = null,
  selectedStructure = null,
  contours = null,
  selectedPointId = null,
  dimmed = false,
  onSelectPoint,
  reference = null,
  mri = null,
  onPick,
  className,
  style,
}: MriProjectionProps) {
  const sliceMm = slices[plane]
  /** «Точка под курсором» — только для текущей отрисовки (в стор не уходит) */
  const [hover, setHover] = useState<MniVector | null>(null)
  /**
   * URL картинки, которая не загрузилась. Держим именно URL, а не флаг: смена
   * среза — новый URL, и попытка повторяется (сервер мог вернуться).
   */
  const [failedHref, setFailedHref] = useState<string | null>(null)

  /**
   * Размеры фигуры: прямоугольник плоскости плюс поля. Раньше фигура была
   * квадратной, и каждая ось растягивалась на свой размах — анатомия искажалась
   * (аксиальная до 22%). Масштаб берётся из геометрии, компонент его не считает.
   */
  const box = projectionBox(plane)

  const svgRef = useRef<SVGSVGElement | null>(null)
  /**
   * Масштаб фигуры: CSS-пикселей экрана на единицу viewBox. Фигура растягивается
   * по ширине колонки (`w-full`), а кольцо диполя обязано держать экранный
   * размер (Ø 10 px, штрих 2 px) при любом размере окна — поэтому его геометрия
   * делится на этот масштаб. В jsdom раскладки нет (rect.width = 0): масштаб
   * остаётся 1, и тесты видят «честные» пиксели.
   */
  const [pxPerUnit, setPxPerUnit] = useState(1)
  useEffect(() => {
    const element = svgRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const width = element.getBoundingClientRect().width
      if (width > 0) setPxPerUnit(width / box.width)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [box.width])
  const dotRadiusPx = DIPOLE_DOT_RADIUS_PX / pxPerUnit
  const dotStrokePx = DIPOLE_DOT_STROKE_PX / pxPerUnit
  const rayStrokePx = DIPOLE_RAY_STROKE_PX / pxPerUnit
  /**
   * Приглушение облака в режиме кадра: выделенный кликом диполь не приглушается —
   * это осознанный выбор пользователя, и «спорить» с ним кадру не за чем.
   */
  const dim = dimmed ? FRAME_DIM_OPACITY : 1

  /**
   * Слой МРТ: включён, ссылка есть и картинка ещё не падала. Пока он показан,
   * схема среза не рисуется — реальная анатомия вместо фикстуры.
   */
  const mriHref = mri && layerVisible(visibility, 'mri') ? mriSliceUrl(mri, plane, sliceMm) : null
  const mriShown = mriHref !== null && mriHref !== failedHref
  const mriFailed = mriHref !== null && mriHref === failedHref
  const imageRect = mriSliceRect(plane)

  const contour = useMemo(
    () =>
      demoHeadContours(plane, sliceMm)
        .map((point) => normalizedToPx(point, plane))
        .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join(' '),
    [plane, sliceMm],
  )

  const structures = useMemo(() => demoSliceStructures(plane, sliceMm), [plane, sliceMm])
  const demoAreas = useMemo(() => demoBrodmannAreas(plane, sliceMm), [plane, sliceMm])
  /**
   * Контуры атласа: `null` — ассета нет, и тогда рисуется условная фикстура;
   * пустой список — «на этом срезе метки нет», и подменять это фикстурой нельзя
   * (иначе на срезе без поля появилось бы нарисованное поле).
   */
  const structureShapes = contours ? contours.structures : null
  const areaShapes = contours ? contours.areas : null
  const grid = useMemo(() => planeGridLines(plane), [plane])
  const guides = useMemo(() => sliceGuides(plane, slices), [plane, slices])
  const edges = useMemo(() => planeEdgeLabels(plane), [plane])

  const markers = useMemo(
    () =>
      points.points.map((point) => ({
        point,
        marker: dipoleMarker(plane, point),
        visual: dipoleRayVisual(point.amplitudeNaM),
      })),
    [plane, points],
  )

  const referencePx = reference ? projectPoint(plane, reference) : null

  /**
   * Координаты курсора в пикселях фигуры. `getBoundingClientRect` нужен, потому
   * что фигура растягивается по ширине колонки: атрибутная система координат
   * (`viewBox`) и экранная не совпадают. В jsdom ширина rect нулевая — тогда
   * считаем масштаб 1:1, и тесты работают в координатах viewBox.
   */
  const pxOf = (event: MouseEvent<SVGSVGElement>): PixelPoint => {
    const rect = event.currentTarget.getBoundingClientRect()
    const scaleX = rect.width > 0 ? box.width / rect.width : 1
    const scaleY = rect.height > 0 ? box.height / rect.height : 1
    return {
      x: Math.min(
        box.width - PROJECTION_PADDING,
        Math.max(PROJECTION_PADDING, (event.clientX - rect.left) * scaleX),
      ),
      y: Math.min(
        box.height - PROJECTION_PADDING,
        Math.max(PROJECTION_PADDING, (event.clientY - rect.top) * scaleY),
      ),
    }
  }

  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!onPick) return
    const px = pxOf(event)
    const normalized = pxToNormalized(px, plane)
    // Поле и структуру ищем по **той же** геометрии, что нарисована: реальные
    // контуры атласа, когда они есть, иначе — условные эллипсы фикстуры.
    const structure = structureShapes
      ? (shapeAtPoint(structureShapes, plane, normalized)?.id ?? null)
      : null
    const area = areaShapes
      ? (shapeAtPoint(areaShapes, plane, normalized)?.id ?? null)
      : brodmannAreaAt(plane, sliceMm, normalized)
    onPick(pointFromProjectionClick(plane, sliceMm, px), area, structure)
  }

  const handleHover = (event: MouseEvent<SVGSVGElement>) => {
    setHover(pointFromProjectionClick(plane, sliceMm, pxOf(event)))
  }

  /** Метка под курсором: структура атласа, иначе поле (та же геометрия, что нарисована). */
  const hoverLabel = useMemo(() => {
    if (!hover) return null
    const normalized = mniToNormalized(plane, hover)
    const structure = structureShapes ? shapeAtPoint(structureShapes, plane, normalized) : null
    if (structure) return structure.label
    return areaShapes ? (shapeAtPoint(areaShapes, plane, normalized)?.label ?? null) : null
  }, [hover, plane, structureShapes, areaShapes])

  // Текст подписи над фигурой: под курсором — координаты и метка атласа, иначе
  // пояснение плоскости; недоступная картинка среза важнее пояснения — о ней надо
  // сказать.
  const footnote = hover
    ? [coordsLabel(hover), hoverLabel].filter(Boolean).join(' · ')
    : mriFailed
      ? MRI_SLICE_UNAVAILABLE
      : PROJECTION_HINTS[plane]

  return (
    <figure
      data-testid={`projection-${plane}`}
      className={cx('flex min-w-0 flex-col gap-1', className)}
      style={style}
    >
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-fg-0">{PROJECTION_LABELS[plane]}</span>
        <span className="tnum font-mono text-sm text-mri-slice">{sliceLabel(plane, sliceMm)}</span>
      </figcaption>

      <svg
        ref={svgRef}
        data-testid={`projection-svg-${plane}`}
        viewBox={`0 0 ${box.width} ${box.height}`}
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
        {/* Наконечники векторов рисуются полигонами (см. `dipoleArrowHead`): тег
            `<marker>` один на проекцию и не подстраивается под длину луча. */}
        {/*
          Срез МРТ — подложка: рисуется первым, чтобы сетка, поля и диполи легли
          поверх. Прямоугольник картинки равен прямоугольнику плоскости, а масштаб
          мм/пиксель у фигуры общий, поэтому `preserveAspectRatio="none"` ничего не
          растягивает: пиксель PNG и пиксель фигуры — один и тот же миллиметр.
        */}
        {mriShown ? (
          <image
            data-testid={`layer-mri-${plane}`}
            href={mriHref ?? undefined}
            x={imageRect.x}
            y={imageRect.y}
            width={imageRect.width}
            height={imageRect.height}
            preserveAspectRatio="none"
            onError={() => setFailedHref(mriHref)}
          />
        ) : null}

        {/*
          Анатомические структуры атласа (`aparc+aseg`): реальные контуры среза.
          Дырки (желудочки внутри структур) приходят отдельными полигонами, поэтому
          заливка — `evenodd`: «кольцо» не закрашивается. Подписи в `<title>` —
          та же подсказка, что видна под курсором в строке под фигурой.
        */}
        {layerVisible(visibility, 'anatomy') && structureShapes ? (
          <g data-testid={`layer-anatomy-${plane}`}>
            {structureShapes.map((shape) => {
              const active = selectedStructure === shape.id
              return (
                <path
                  key={shape.id}
                  data-testid={`anatomy-${plane}-${shape.id}`}
                  data-active={active ? 'true' : 'false'}
                  d={contourPathPx(plane, shape)}
                  fillRule="evenodd"
                  fill="var(--color-mri-structure)"
                  fillOpacity={active ? 0.3 : 0.12}
                  stroke="var(--color-mri-structure)"
                  strokeOpacity={active ? 0.95 : 0.55}
                  strokeWidth={active ? 1.6 : 0.9}
                >
                  <title>{`${shape.label} · ${shape.area_mm2} мм²`}</title>
                </path>
              )
            })}
          </g>
        ) : null}

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
                const x = xOfNormalized(plane, line.at)
                return (
                  <line
                    key={`grid-v-${line.valueMm}`}
                    data-testid={`grid-${plane}-v-${line.valueMm}`}
                    x1={x}
                    y1={PROJECTION_PADDING}
                    x2={x}
                    y2={box.height - PROJECTION_PADDING}
                    stroke="var(--color-mri-slice)"
                    strokeOpacity={zero ? 0.45 : 0.16}
                    strokeDasharray={zero ? undefined : '3 4'}
                  />
                )
              }
              const y = yOfNormalized(plane, line.at)
              return (
                <line
                  key={`grid-h-${line.valueMm}`}
                  data-testid={`grid-${plane}-h-${line.valueMm}`}
                  x1={PROJECTION_PADDING}
                  y1={y}
                  x2={box.width - PROJECTION_PADDING}
                  y2={y}
                  stroke="var(--color-mri-slice)"
                  strokeOpacity={zero ? 0.45 : 0.16}
                  strokeDasharray={zero ? undefined : '3 4'}
                />
              )
            })}

            {/* Схема среза: желудочки, мозолистое тело, ствол — фикстура тома.
                Показывается только без реального среза: иначе поверх настоящей
                анатомии рисовалась бы «вторая», условная. */}
            {mriShown
              ? null
              : structures.map((structure) => {
                  const ellipse = ellipsePx(plane, structure.center, structure.radius)
                  return (
                    <ellipse
                      key={structure.id}
                      data-testid={`slice-structure-${plane}-${structure.id}`}
                      cx={ellipse.cx}
                      cy={ellipse.cy}
                      rx={ellipse.rx}
                      ry={ellipse.ry}
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
                  x1={xOfNormalized(plane, guide.at)}
                  y1={PROJECTION_PADDING}
                  x2={xOfNormalized(plane, guide.at)}
                  y2={box.height - PROJECTION_PADDING}
                  stroke="var(--color-mri-slice)"
                  strokeOpacity={0.4}
                  strokeDasharray="6 4"
                />
              ) : (
                <line
                  key={guide.label}
                  data-testid={`guide-${plane}-${guide.orientation}`}
                  x1={PROJECTION_PADDING}
                  y1={yOfNormalized(plane, guide.at)}
                  x2={box.width - PROJECTION_PADDING}
                  y2={yOfNormalized(plane, guide.at)}
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
            {/*
              Реальные поля атласа: контуры приходят полигонами в мм MNI и по ним же
              считается попадание клика. Пока ассета нет, рисуются условные эллипсы
              фикстуры — и это видно по подписи метода в полосе состояния раздела.
            */}
            {areaShapes
              ? areaShapes.map((shape) => {
                  const active = selectedArea === shape.id
                  return (
                    <path
                      key={shape.id}
                      data-testid={`area-${plane}-${shape.id}`}
                      data-active={active ? 'true' : 'false'}
                      d={contourPathPx(plane, shape)}
                      fillRule="evenodd"
                      fill="var(--color-mri-brodmann)"
                      fillOpacity={active ? 0.32 : 0.13}
                      stroke="var(--color-mri-brodmann)"
                      strokeOpacity={active ? 0.95 : 0.5}
                      strokeWidth={active ? 1.8 : 1}
                    >
                      <title>{`${shape.label} · ${shape.area_mm2} мм²`}</title>
                    </path>
                  )
                })
              : demoAreas.map((area) => {
                  const ellipse = ellipsePx(plane, area.center, area.radius)
                  const active = selectedArea === area.name
                  return (
                    <g
                      key={area.name}
                      data-testid={`brodmann-${plane}-${area.name}`}
                      data-active={active ? 'true' : 'false'}
                    >
                      <ellipse
                        cx={ellipse.cx}
                        cy={ellipse.cy}
                        rx={ellipse.rx}
                        ry={ellipse.ry}
                        fill="var(--color-mri-brodmann)"
                        fillOpacity={(active ? 0.32 : 0.13) * area.alpha}
                        stroke="var(--color-mri-brodmann)"
                        strokeOpacity={(active ? 0.95 : 0.5) * area.alpha}
                        strokeWidth={active ? 1.8 : 1}
                      />
                      <text
                        x={ellipse.cx}
                        y={ellipse.cy}
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

        {/*
          Слой векторов — отдельно от позиций (срез 3.5). Луч идёт от позиции
          диполя, поэтому он рисуется и при выключенных точках: карта направлений
          без точек — осмысленный вид, а не «сломанный» слой.
        */}
        {layerVisible(visibility, 'vectors') ? (
          <g data-testid={`layer-dipole-vectors-${plane}`}>
            {markers.map(({ point, marker, visual }) => {
              if (!marker.end || !marker.shaftEnd || !marker.head) return null
              const selected = selectedPointId === point.id
              return (
                <g key={point.id} data-testid={`dipole-ray-${plane}-${point.id}`}>
                  <title>{dipolePointTitle(point)}</title>
                  <line
                    data-testid={`dipole-vector-${plane}-${point.id}`}
                    x1={marker.at.x}
                    y1={marker.at.y}
                    x2={marker.shaftEnd.x}
                    y2={marker.shaftEnd.y}
                    stroke={selected ? 'var(--color-accent)' : 'var(--color-mri-dipole)'}
                    strokeWidth={rayStrokePx}
                    strokeOpacity={selected ? 1 : visual.opacity * dim}
                  />
                  {/* Наконечник: полигон от длины луча, а не `<marker>` на всю проекцию */}
                  <polygon
                    data-testid={`dipole-arrow-${plane}-${point.id}`}
                    points={marker.head.map((vertex) => `${vertex.x},${vertex.y}`).join(' ')}
                    fill={selected ? 'var(--color-accent)' : 'var(--color-mri-dipole)'}
                    fillOpacity={selected ? 1 : visual.opacity * dim}
                  />
                </g>
              )
            })}
          </g>
        ) : null}

        {layerVisible(visibility, 'dipoles') ? (
          <g data-testid={`layer-dipoles-${plane}`}>
            {markers.map(({ point, marker }) => {
              const selected = selectedPointId === point.id
              return (
                <g
                  key={point.id}
                  data-testid={`dipole-${plane}-${point.id}`}
                  data-selected={selected ? 'true' : 'false'}
                >
                  <title>{dipolePointTitle(point)}</title>
                  {/*
                    Кольцо позиции: белое, фиксированного экранного размера
                    (Ø 10 px, штрих 2 px) — пиксели поделены на масштаб фигуры.
                    Выделенный диполь залит оранжево-жёлтым; сила момента
                    читается по лучу, а не по размеру кольца.
                  */}
                  <circle
                    data-testid={`dipole-dot-${plane}-${point.id}`}
                    cx={marker.at.x}
                    cy={marker.at.y}
                    r={dotRadiusPx}
                    fill={selected ? 'var(--color-mri-dipole)' : 'none'}
                    stroke="var(--color-mri-dipole-point)"
                    strokeWidth={dotStrokePx}
                    strokeOpacity={selected ? 1 : dim}
                  />
                  {/*
                    Хит-зона выделения: попасть в кольцо диаметром 10 px мышью
                    трудно, поэтому клик принимает невидимый круг большего радиуса.
                    Он гасит всплытие, чтобы клик не обработался дважды (фигура
                    навела бы срезы на «сырую» точку клика у края хит-зоны), и сам
                    наводит срезы на точную позицию диполя: срезы меняются при
                    любом клике.
                  */}
                  {onSelectPoint ? (
                    <circle
                      data-testid={`dipole-hit-${plane}-${point.id}`}
                      cx={marker.at.x}
                      cy={marker.at.y}
                      r={DOT_HIT_RADIUS_PX}
                      fill="transparent"
                      className="cursor-pointer"
                      onClick={(event) => {
                        event.stopPropagation()
                        onSelectPoint(selected ? null : point.id)
                        // Клик по точке диполя — это выбор **диполя**: структуру под
                        // ним не угадываем (контур нового среза ещё не пришёл), и
                        // прежняя подпись структуры не должна «залипать».
                        onPick?.(point.position, point.brodmannArea, null)
                      }}
                    >
                      <title>{`Выделить диполь: ${dipolePointTitle(point)}`}</title>
                    </circle>
                  ) : null}
                </g>
              )
            })}
          </g>
        ) : null}

        {/* Маркер кадра воспроизведения — поверх слоёв: он и есть «сейчас» */}
        <FrameMarker plane={plane} visibility={visibility} pxPerUnit={pxPerUnit} />

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

        {/* Края фигуры подписаны по знакам осей: L/R, A/P, S/I */}
        <EdgeLabel
          testId={`edge-${plane}-left`}
          label={edges.left}
          x={PROJECTION_PADDING / 2}
          y={box.height / 2}
          anchor="middle"
        />
        <EdgeLabel
          testId={`edge-${plane}-right`}
          label={edges.right}
          x={box.width - PROJECTION_PADDING / 2}
          y={box.height / 2}
          anchor="middle"
        />
        <EdgeLabel
          testId={`edge-${plane}-top`}
          label={edges.top}
          x={box.width / 2}
          y={PROJECTION_PADDING / 2}
          anchor="middle"
        />
        <EdgeLabel
          testId={`edge-${plane}-bottom`}
          label={edges.bottom}
          x={box.width / 2}
          y={box.height - PROJECTION_PADDING / 2}
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
function xOfNormalized(plane: ProjectionPlane, u: number): number {
  return normalizedToPx({ u, v: 0 }, plane).x
}

/** Пиксельная вертикаль по нормализованной координате (ось v растёт вверх). */
function yOfNormalized(plane: ProjectionPlane, v: number): number {
  return normalizedToPx({ u: 0, v }, plane).y
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
 * Слои уважаются и здесь: выключенные позиции — нет кольца кадра, выключенные
 * векторы — нет его луча (кадр остаётся виден тем слоем, который включён).
 *
 * Шлейф траектории (срез 3.7, поправка) рисуется **под** маркером: отрезки между
 * измеренными точками последних секунд сессии, гаснущие с возрастом. Он живёт в
 * слое позиций (путь — это «где был», а не «куда направлен») и показывается вместе
 * с маркером: нет кадра — нет и шлейфа.
 */
function FrameMarker({
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
  if (!point) return null

  const marker = dipoleMarker(plane, point)
  const visual = dipoleRayVisual(point.amplitudeNaM)
  const showsDot = layerVisible(visibility, 'dipoles')
  // Луч кадра — отдельным объектом: проверка слоя и наличия луча в одном месте,
  // без «утверждений о непустоте» внутри разметки
  const ray =
    layerVisible(visibility, 'vectors') && marker.shaftEnd && marker.head
      ? { end: marker.shaftEnd, head: marker.head }
      : null
  // Шлейф — в слое позиций: это путь **позиций** диполя, и он же скрывается вместе
  // с точками (векторы отвечают на другой вопрос — «куда», а не «где был»)
  const trail = showsDot ? (frame?.trail ?? []) : []

  return (
    <g data-testid={`frame-${plane}`}>
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
      {showsDot ? (
        <>
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
        </>
      ) : null}
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
