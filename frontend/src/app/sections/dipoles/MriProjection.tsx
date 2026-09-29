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
 * схема среза, `brodmann` — поля Бродмана, `anatomy` — структуры атласа,
 * `dipoles` — позиции диполей, `vectors` — векторы моментов, `playback` —
 * анимация (кадр, его луч и шлейф). Каждый слой включается отдельно; выключенный
 * слой не рисуется вовсе, а не прячется прозрачностью. Позиции и векторы —
 * **разные слои** (срез 3.5): «где» и «куда» отвечают на разные вопросы, и при
 * плотном облаке точек лучи мешают читать позиции (и наоборот).
 *
 * Слои вынесены в `MriProjectionLayers.tsx` (разрезка 3.4, правило
 * `docs/rules/frontend-state.md` п.6): здесь — состояние, геометрия, жесты
 * и сборка `<svg>`; части фигуры (подписи краёв, кадр, перекрестие) — в
 * `MriProjectionParts.tsx`.
 *
 * Позиция диполя — кольцо **фиксированного экранного штриха** (2 px при любом
 * размере окна: фигура растягивается по ширине колонки, поэтому геометрия кольца
 * делится на масштаб `renderedWidth / viewBox.width`, который отслеживает
 * ResizeObserver). **Диаметр кольца читает кратность узла сетки** (поправка ручной
 * проверки, 18.09.2026): в быстром режиме несколько эпох часто выбирают один узел, и
 * Ø растёт на 2 px за каждый диполь в узле, пока не упрётся в предел `2 · grid_mm`
 * (центр соседнего узла) — дальше число диполей показывает заливка от 25 %
 * (`dipoleDotVisual`). Силу момента кодирует **луч** (`dipoleRayVisual`), а не
 * кольцо: две величины в одном канале спорили бы. Выделенный диполь залит акцентным
 * цветом целиком. Толщина луча тоже фиксирована (2 px по экрану), как и штрих
 * кольца. Наконечник вектора рисуется полигоном с длиной от длины луча: размер
 * `<marker>` SVG один на всю проекцию, поэтому на коротком луче стрелка накрывала бы
 * весь луч, а на длинном выглядела бы точкой.
 *
 * Клик по точке **выделяет диполь** (`onSelectPoint`) **и наводит срезы** на его
 * позицию (`onPick`): поправка ручной проверки — срезы обязаны меняться при
 * любом клике по фигуре. `stopPropagation` остаётся, чтобы клик не обработался
 * дважды: фигура навела бы срезы на «сырую» точку клика, а хит-зона шире кольца.
 *
 * Координаты под курсором — только текстом в строке под фигурой: маркера,
 * бегающего за мышью, нет, чтобы его не путали с кольцами диполей.
 *
 * Перекрестие точки клика (`reference`, часть `ReferenceCross`) — **XY-линии
 * плоскостей MNI-срезов** в этой точке (поправка ручной проверки): клик наводит
 * все три среза, и линии показывают, где эти плоскости проходят на каждой фигуре.
 * Короткий штрих в центре отмечает саму точку клика, а слой это не гасит:
 * перекрестие — состояние просмотра, а не данные.
 *
 * Кадр воспроизведения (срез 3.7) рисуется отдельным компонентом `FrameMarker`:
 * он берёт кадр из контекста (`PlaybackFrame.tsx`) и потому обновляется сам, а
 * статичные слои при движении кадра не перерисовываются. Анимация — **свой слой**
 * (`layer-playback`, поправка ручной проверки): кадр, его луч и шлейф не зависят
 * от слоёв облака, а её выключение убирает анимацию целиком. В режиме кадра облако
 * приглушается (`dimmed`, α 0.3) — иначе сотни колец спорят с маркером за внимание.
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
  coordsLabel,
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
  type ProjectionPlane,
  type SliceTriplet,
} from '@/shared/lib/mriProjections'
// Условные фигуры (силуэт, схема среза, поля Бродмана) — отдельный модуль-заглушка:
// он удаляется целиком, когда панель закроют реальные срезы/контуры атласа.
import {
  brodmannAreaAt,
  demoBrodmannAreas,
  demoHeadContours,
  demoSliceStructures,
} from '@/shared/lib/mriDemoShapes'
import { MRI_SLICE_UNAVAILABLE, mriSliceRect, mriSliceUrl } from '@/shared/lib/mriSlices'
import { contourPointToNormalized, shapeAtPoint } from '@/shared/lib/atlasContours'
import type { ContourSlice, MriSliceRef } from '@/shared/api/types'
import {
  DIPOLE_DOT_STROKE_PX,
  DIPOLE_RAY_STROKE_PX,
  DOT_HIT_RADIUS_PX,
  FRAME_DIM_OPACITY,
  dipoleDotVisual,
  dipoleMarker,
  dipoleNodeSiblings,
  dipoleNodeTitle,
  dipoleRayVisual,
  emptyDipoleLayer,
  type DipoleLayer,
  type DipolePoint,
} from '@/shared/lib/dipolePoints'
import { layerVisible, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { cx } from '@/shared/ui/cx'
import {
  AnatomyLayer,
  BrodmannLayer,
  DipoleDotsLayer,
  HeadLayer,
  MniLayer,
  MriLayer,
  VectorLayer,
} from './MriProjectionLayers'
import { EdgeLabel, FrameMarker, ReferenceCross } from './MriProjectionParts'
import { ProjectionCursor } from './ProjectionCursor'

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
  /**
   * Шаг сетки расчёта, мм (`result.grid_mm`): задаёт предел роста кольца —
   * `2 · gridMm`. Без него (или `<= 0`) кольцо растёт по кратности узла без предела,
   * и заливка не включается.
   */
  gridMm?: number
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
  /** Референс-точка сессии: XY-линии плоскостей MNI-срезов в точке клика на всех проекциях */
  reference?: MniVector | null
  /**
   * Совместный курсор (срез 3.5): точка MNI под ховером в **любой** проекции
   * или положение кроссхейра Niivue. Рисуется оверлеем `ProjectionCursor`
   * поверх слоёв (курсор — состояние просмотра, а не слой данных).
   */
  cursor?: MniVector | null
  /** Ховер/выход мыши этой проекции → в стор совместного курсора */
  onCursorChange?: (point: MniVector | null) => void
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
  gridMm = 0,
  selectedArea = null,
  selectedStructure = null,
  contours = null,
  selectedPointId = null,
  dimmed = false,
  onSelectPoint,
  reference = null,
  cursor = null,
  onCursorChange,
  mri = null,
  onPick,
  className,
  style,
}: MriProjectionProps) {
  const sliceMm = slices[plane]
  /** «Точка под курсором» — только для текущей отрисовки (в стор не уходит) */
  const [hover, setHover] = useState<MniVector | null>(null)
  /** Диполь под курсором (ближайший центр): тултип-строка вместо `<title>`. */
  const [hoverDipole, setHoverDipole] = useState<DipolePoint | null>(null)
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
   * размер (Ø 6 px, штрих 2 px) при любом размере окна — поэтому его геометрия
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

  /**
   * Силуэт головы: **реальные** полигоны `head` из ответа контуров (срез 3.5),
   * а при `null` (ассета `seghead.mgz` нет или контуры ещё не пришли) — условная
   * фикстура `demoHeadContours` (запасной вид, строго по паттерну полей
   * Бродмана: `null` ≠ пустой список — пустой массив значит «на срезе нет
   * вокселей головы», и подменять его фикстурой нельзя).
   */
  const headHulls = contours?.head ?? null
  const headPolygons = useMemo(() => {
    if (headHulls === null) {
      return [
        demoHeadContours(plane, sliceMm)
          .map((point) => normalizedToPx(point, plane))
          .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
          .join(' '),
      ]
    }
    return headHulls
      .map((hull) =>
        hull
          .map((point) =>
            normalizedToPx(contourPointToNormalized(plane, point as [number, number]), plane),
          )
          .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
          .join(' '),
      )
      .filter((points) => points.length > 0)
  }, [plane, sliceMm, headHulls])

  const structures = useMemo(() => demoSliceStructures(plane, sliceMm), [plane, sliceMm])
  const demoAreas = useMemo(() => demoBrodmannAreas(plane, sliceMm), [plane, sliceMm])
  /**
   * Контуры атласа: `null` — ассета нет, и тогда рисуется условная фикстура;
   * пустой список — «на этом срезе метки нет», и подменять это фикстурой нельзя
   * (иначе на срезе без поля появилось бы нарисованное поле).
   */
  const structureShapes = contours?.structures ?? null
  const areaShapes = contours?.areas ?? null
  const grid = useMemo(() => planeGridLines(plane), [plane])
  const guides = useMemo(() => sliceGuides(plane, slices), [plane, slices])
  const edges = useMemo(() => planeEdgeLabels(plane), [plane])

  const markers = useMemo(
    () =>
      points.points.map((point) => ({
        point,
        marker: dipoleMarker(plane, point),
        visual: dipoleRayVisual(point.amplitudeNaM),
        // Кольцо: Ø растёт с кратностью узла, предел — 2 · gridMm (см. dipoleDotVisual)
        dot: dipoleDotVisual(point.overlapCount ?? 1, gridMm, pxPerUnit),
      })),
    [plane, points, gridMm, pxPerUnit],
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

  /**
   * Диполь под курсором: **ближайший центр**, а не верхний элемент DOM
   * (находка ручной проверки, 19.09.2026). При мелкой сетке (2 мм — это 3 px
   * проекции) хит-зоны соседних узлов перекрываются, и «верхний» элемент мог
   * принадлежать соседнему узлу: курсор стоял на крупном кольце узла с N=4, а
   * тултип и клик рассказывали про одиночного соседа. Хит-радиус растёт вместе
   * с кольцом — по краю крупного «мульти-дипольного» кольца клик работает.
   */
  const dipoleAt = (px: PixelPoint): (typeof markers)[number] | null => {
    if (!layerVisible(visibility, 'dipoles')) return null
    let best: (typeof markers)[number] | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const entry of markers) {
      const hitUnits =
        Math.max(DOT_HIT_RADIUS_PX, entry.dot.radiusUnits * pxPerUnit + 2) / pxPerUnit
      const distance = Math.hypot(entry.marker.at.x - px.x, entry.marker.at.y - px.y)
      if (distance <= hitUnits && distance < bestDistance) {
        best = entry
        bestDistance = distance
      }
    }
    return best
  }

  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    const px = pxOf(event)
    const dipole = dipoleAt(px)
    if (dipole && onSelectPoint) {
      // Клик по точке диполя — это выбор **диполя**: структуру под ним не
      // угадываем (контур нового среза ещё не пришёл), а прежняя подпись
      // структуры не должна «залипать». Срезы наводятся на точную позицию
      // диполя, а не на «сырую» точку клика у края хит-зоны.
      onSelectPoint(selectedPointId === dipole.point.id ? null : dipole.point.id)
      onPick?.(dipole.point.position, dipole.point.brodmannArea, null)
      return
    }
    if (!onPick) return
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
    const px = pxOf(event)
    const point = pointFromProjectionClick(plane, sliceMm, px)
    setHover(point)
    setHoverDipole(dipoleAt(px)?.point ?? null)
    // Совместный курсор (срез 3.5): точка под мышью этой проекции видна
    // перекрестием на всех трёх фигурах и как кроссхейр в 3D-виде.
    onCursorChange?.(point)
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
  // сказать. Курсор на диполе — тултип узла с эпохами вместо подписи атласа.
  const hoverDipoleSiblings = hoverDipole ? dipoleNodeSiblings(points.points, hoverDipole) : null
  const footnote = hoverDipole
    ? dipoleNodeTitle(hoverDipole, hoverDipoleSiblings ?? [hoverDipole])
    : hover
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
        onMouseLeave={() => {
          setHover(null)
          setHoverDipole(null)
          // Курсор сбрасывается: мышь покинула все проекции (Niivue держит свой)
          onCursorChange?.(null)
        }}
      >
        {/* Наконечники векторов рисуются полигонами (см. `dipoleArrowHead`): тег
            `<marker>` один на проекцию и не подстраивается под длину луча. */}
        {/* Слои снизу вверх (порядок и подписи — в `shared/state/dipoleParams.ts`);
            сами слои — `MriProjectionLayers.tsx` (разрезка 3.4) */}
        <MriLayer
          plane={plane}
          mriShown={mriShown}
          mriHref={mriHref}
          imageRect={imageRect}
          onImageError={() => setFailedHref(mriHref)}
        />

        <AnatomyLayer
          plane={plane}
          visibility={visibility}
          structureShapes={structureShapes}
          selectedStructure={selectedStructure}
        />

        <HeadLayer plane={plane} visibility={visibility} polygons={headPolygons} />

        <MniLayer
          plane={plane}
          visibility={visibility}
          box={box}
          grid={grid}
          structures={structures}
          guides={guides}
          mriShown={mriShown}
        />

        <BrodmannLayer
          plane={plane}
          visibility={visibility}
          areaShapes={areaShapes}
          demoAreas={demoAreas}
          selectedArea={selectedArea}
        />

        <VectorLayer
          plane={plane}
          visibility={visibility}
          markers={markers}
          selectedPointId={selectedPointId}
          rayStrokePx={rayStrokePx}
          dim={dim}
        />

        <DipoleDotsLayer
          plane={plane}
          visibility={visibility}
          markers={markers}
          selectedPointId={selectedPointId}
          dotStrokePx={dotStrokePx}
          dim={dim}
        />

        {/* Анимация — свой слой (`layer-playback`, поправка ручной проверки):
            кадр рисуется поверх остальных слоёв и не зависит от слоёв облака */}
        <FrameMarker plane={plane} visibility={visibility} pxPerUnit={pxPerUnit} />

        {/* Перекрестие точки клика: XY-линии плоскостей MNI-срезов в этой точке —
            видно, какие срезы выбраны, а не только «где щёлкнули» (часть
            `ReferenceCross`). Слоям оно не подчиняется: это состояние просмотра. */}
        {referencePx ? <ReferenceCross plane={plane} at={referencePx} box={box} /> : null}

        {/* Совместный курсор (срез 3.5): оверлей поверх всех слоёв — курсор это
            состояние ховера/кроссхейра Niivue, а не фоновый слой данных, поэтому
            в DIPOLE_LAYERS его нет и выключается он только выходом мыши. */}
        {cursor ? <ProjectionCursor plane={plane} cursor={cursor} box={box} /> : null}

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
