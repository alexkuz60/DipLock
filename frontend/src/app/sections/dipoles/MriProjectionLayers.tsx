/**
 * Слои проекции мозга: подложка МРТ, анатомия атласа, силуэт головы,
 * слой MNI (сетка, условная схема, следы срезов), поля Бродмана, векторы
 * моментов и позиции диполей.
 *
 * Вынесены из `MriProjection.tsx` (разрезка 3.4, правило
 * `docs/rules/frontend-state.md` п.6: крупный модуль делят по ответственности,
 * файл-хозяин остаётся сборкой). Условие включения слоя и весь JSX перенесены
 * дословно — поведение и DOM не меняются, тесты `MriProjection.test.tsx`
 * остаются зелёными без правок. Общего состояния у слоёв нет, поэтому хуков
 * здесь нет: сборка держит курсор, масштаб и признак неудавшейся картинки,
 * слои только рисуют переданное. Порядок слоёв в `<svg>` задаёт сборка.
 *
 * Слои снизу вверх (порядок и подписи — в `shared/state/dipoleParams.ts`):
 * `mri` → `anatomy` → `brain` → `mni` → `brodmann` → `vectors` → `dipoles`;
 * анимация кадра (`playback`) и перекрестие живут в `MriProjectionParts.tsx`.
 */
import type { ContourShape, MipOutline } from '@/shared/api/types'
import { contourPathPx, smoothHullsPathPx } from '@/shared/lib/atlasContours'
import {
  dipolePointTitle,
  type DipoleDotVisual,
  type DipoleMarker,
  type DipolePoint,
  type DipoleRayVisual,
} from '@/shared/lib/dipolePoints'
import {
  PROJECTION_PADDING,
  xOfNormalized,
  yOfNormalized,
  type MniGridLine,
  type MniGuideLine,
  type ProjectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import { layerVisible, type DipoleLayerId } from '@/shared/state/dipoleParams'

/**
 * Запись маркера диполя: всё, что считает сборка на каждый кадр отрисовки —
 * позиция, геометрия луча, визуал силы и кольцо кратности узла. Тот же тип
 * использует курсорная модель сборки (`dipoleAt` — ближайший центр).
 */
export type DipoleMarkerEntry = {
  point: DipolePoint
  marker: DipoleMarker
  visual: DipoleRayVisual
  dot: DipoleDotVisual
}

/** Прямоугольник картинки среза в пикселях фигуры (`mriSliceRect`). */
type ImageRect = { x: number; y: number; width: number; height: number }

/**
 * Срез МРТ — подложка: рисуется первым, чтобы сетка, поля и диполи легли
 * поверх. Прямоугольник картинки равен прямоугольнику плоскости, а масштаб
 * мм/пиксель у фигуры общий, поэтому `preserveAspectRatio="none"` ничего не
 * растягивает: пиксель PNG и пиксель фигуры — один и тот же миллиметр.
 */
export function MriLayer({
  plane,
  mriShown,
  mriHref,
  imageRect,
  onImageError,
}: {
  plane: ProjectionPlane
  /** Слой показан: ссылка есть, слой включён и картинка ещё не падала */
  mriShown: boolean
  mriHref: string | null
  imageRect: ImageRect
  /** Картинка не загрузилась: сборка запоминает URL и пробует снова при смене среза */
  onImageError: () => void
}) {
  return mriShown ? (
    <image
      data-testid={`layer-mri-${plane}`}
      href={mriHref ?? undefined}
      x={imageRect.x}
      y={imageRect.y}
      width={imageRect.width}
      height={imageRect.height}
      preserveAspectRatio="none"
      onError={onImageError}
    />
  ) : null
}

/**
 * Анатомические структуры атласа (`aparc+aseg`): реальные контуры среза.
 * Дырки (желудочки внутри структур) приходят отдельными полигонами, поэтому
 * заливка — `evenodd`: «кольцо» не закрашивается. Подписи в `<title>` —
 * та же подсказка, что видна под курсором в строке под фигурой.
 */
export function AnatomyLayer({
  plane,
  visibility,
  structureShapes,
  selectedStructure,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  /** `null` — ассета нет: слой не рисуется (сама фигура — в слое `mni`) */
  structureShapes: ContourShape[] | null
  selectedStructure?: string | null
}) {
  return layerVisible(visibility, 'anatomy') && structureShapes ? (
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
  ) : null
}

/**
 * Границы мозга на проекции: **только внешний силуэт коры** — статичная белая
 * обводка, одинаковая для любых срезов (срез 3.12, доводка 19.10.2026).
 * Растровая MIP-подложка убрана: внутреннюю анатомию показывают свои слои
 * (срез МРТ, структуры, поля Бродмана), а этот слой отвечает только за внешний
 * контур — как белая обводка glass brain у nilearn. Источник контура —
 * корковый меш `*.pial` fsaverage (как `silhouette=True` у MNE), контракт
 * `/surface/mri/mip/outline`; цвет — цвет переднего плана, поэтому в тёмной
 * теме контур белый. Контур приходит с растровой сетки 1 мм, поэтому рисуется
 * **плавной** замкнутой кривой (`smoothHullsPathPx`, сплайн Катмулла—Рома),
 * а не «лестничной» ломаной. Без данных обводки слой честно пуст.
 */
export function BrainLayer({
  plane,
  visibility,
  outline,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  /** Силуэт коры (мм MNI): единственное содержимое слоя */
  outline: MipOutline | null
}) {
  if (!layerVisible(visibility, 'brain')) return null
  const hulls = outline?.outlines[plane] ?? null
  if (!hulls || hulls.length === 0) return null
  return (
    <g data-testid={`layer-brain-${plane}`}>
      <path
        d={smoothHullsPathPx(plane, hulls)}
        fill="none"
        stroke="var(--color-fg-0)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </g>
  )
}

/**
 * Слой MNI: координатная сетка (нулевые линии — оси AC–PC) и следы срезов
 * соседних проекций. Условная схема среза (эллипсы структур) удалена
 * (17.10.2026): анатомию рисуют только реальные контуры атласа и срез МРТ.
 */
export function MniLayer({
  plane,
  visibility,
  box,
  grid,
  guides,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  box: ProjectionBox
  grid: MniGridLine[]
  guides: MniGuideLine[]
}) {
  return layerVisible(visibility, 'mni') ? (
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

      {/* Схема среза (эллипсы структур) удалена (17.10.2026): анатомию рисуют
          только реальные контуры атласа (слои `anatomy`/`brodmann`) и срез МРТ */}

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
  ) : null
}

/**
 * Поля Бродмана: реальные контуры атласа. Условные эллипсы фикстуры удалены
 * (17.10.2026): без ассета контуров слой честно пуст, а не рисует «вторую»
 * схематичную анатомию (подсказка `CONTOURS_UNAVAILABLE` — в полосе состояния).
 */
export function BrodmannLayer({
  plane,
  visibility,
  areaShapes,
  selectedArea,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  /** `null` — ассета нет: слой пуст (условных эллипсов больше нет) */
  areaShapes: ContourShape[] | null
  selectedArea?: string | null
}) {
  return layerVisible(visibility, 'brodmann') && areaShapes ? (
    <g data-testid={`layer-brodmann-${plane}`}>
      {/* Реальные поля атласа: контуры приходят полигонами в мм MNI и по ним же
          считается попадание клика. */}
      {areaShapes.map((shape) => {
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
      })}
    </g>
  ) : null
}

/**
 * Слой векторов — отдельно от позиций (срез 3.5). Луч идёт от позиции
 * диполя, поэтому он рисуется и при выключенных точках: карта направлений
 * без точек — осмысленный вид, а не «сломанный» слой.
 */
export function VectorLayer({
  plane,
  visibility,
  markers,
  selectedPointId,
  rayStrokePx,
  dim,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  markers: DipoleMarkerEntry[]
  selectedPointId?: string | null
  /** Толщина луча в единицах viewBox (экранные пиксели ÷ масштаб фигуры) */
  rayStrokePx: number
  /** Приглушение облака в режиме кадра (1 — обычный режим) */
  dim: number
}) {
  return layerVisible(visibility, 'vectors') ? (
    <g data-testid={`layer-dipole-vectors-${plane}`}>
      {markers.map(({ point, marker, visual }) => {
        if (!marker.end || !marker.shaftEnd || !marker.head) return null
        const selected = selectedPointId === point.id
        /**
         * Цвет луча — **приглушённый** токен (`--color-mri-dipole-vector`),
         * а не оранжевый диполя: векторы («куда») не должны спорить с
         * кольцами позиций («где»). У полос пакета (С1) луч рисуется **цветом
         * полосы** (гамма red→violet, `point.band.color`) — так потоки разных
         * полос различимы в общем облаке. Выделение остаётся акцентным, а вектор
         * кадра анимации (`MriProjectionParts.FrameMarker`) не затрагивается:
         * приглушение — признак облака, а не кадра.
         */
        const rayColor = selected
          ? 'var(--color-accent)'
          : (point.band?.color ?? 'var(--color-mri-dipole-vector)')
        return (
          <g key={point.id} data-testid={`dipole-ray-${plane}-${point.id}`}>
            <title>{dipolePointTitle(point)}</title>
            <line
              data-testid={`dipole-vector-${plane}-${point.id}`}
              x1={marker.at.x}
              y1={marker.at.y}
              x2={marker.shaftEnd.x}
              y2={marker.shaftEnd.y}
              stroke={rayColor}
              strokeWidth={rayStrokePx}
              strokeOpacity={selected ? 1 : visual.opacity * dim}
            />
            {/*
              Наконечник: залитый треугольник **фиксированного** размера (~4 px,
              `DIPOLE_ARROW_PX` — один для всех полос, поправка 17.10.2026),
              а не `<marker>` на всю проекцию. Вершина — конец луча, крылья — по
              сторонам от неё; полосу несёт цвет заливки, а не размер стрелы.
            */}
            <polygon
              data-testid={`dipole-arrow-${plane}-${point.id}`}
              points={marker.head.map((vertex) => `${vertex.x},${vertex.y}`).join(' ')}
              fill={rayColor}
              fillOpacity={selected ? 1 : visual.opacity * dim}
            />
          </g>
        )
      })}
    </g>
  ) : null
}

/**
 * Позиции диполей («где»): кольцо фиксированного экранного штриха, диаметр
 * читает кратность узла сетки, сила момента — слой `vectors`, а не кольцо.
 */
export function DipoleDotsLayer({
  plane,
  visibility,
  markers,
  selectedPointId,
  dotStrokePx,
  dim,
}: {
  plane: ProjectionPlane
  visibility: Record<DipoleLayerId, boolean>
  markers: DipoleMarkerEntry[]
  selectedPointId?: string | null
  /** Толщина штриха кольца в единицах viewBox (экранные пиксели ÷ масштаб) */
  dotStrokePx: number
  /** Приглушение облака в режиме кадра (1 — обычный режим) */
  dim: number
}) {
  return layerVisible(visibility, 'dipoles') ? (
    <g data-testid={`layer-dipoles-${plane}`}>
      {markers.map(({ point, marker, dot }) => {
        const selected = selectedPointId === point.id
        /** Заливка: выделение — акцент, кратность узла — цветом кольца */
        const filled = selected || dot.fillOpacity > 0
        return (
          <g
            key={point.id}
            data-testid={`dipole-${plane}-${point.id}`}
            data-selected={selected ? 'true' : 'false'}
          >
            {/*
              Кольцо позиции: Ø 6 px плюс 2 px на каждый диполь в узле (кратность
              узла сетки), штрих 2 px — пиксели поделены на масштаб фигуры.
              Кольцо не растёт шире `2 · grid_mm` (центр соседнего узла): когда
              диполей больше, число читается заливкой от 25 % (`dipoleDotVisual`).
              Сила момента по-прежнему читается по лучу, а не по размеру кольца.
            */}
            <circle
              data-testid={`dipole-dot-${plane}-${point.id}`}
              cx={marker.at.x}
              cy={marker.at.y}
              r={dot.radiusUnits}
              fill={
                selected
                  ? 'var(--color-mri-dipole)'
                  : filled
                    ? 'var(--color-mri-dipole-point)'
                    : 'none'
              }
              fillOpacity={selected ? 1 : dot.fillOpacity}
              stroke={point.band?.color ?? 'var(--color-mri-dipole-point)'}
              strokeWidth={dotStrokePx}
              strokeOpacity={selected ? 1 : dim}
            />
            {/*
              Хит-зоны и `<title>` у точки больше нет: попадание и тултип
              считает курсорная модель фигуры (`dipoleAt` — ближайший центр,
              подпись узла с эпохами — в строке под фигурой). DOM-стэкинг
              ошибался, когда хит-зоны соседних узлов перекрывались.
            */}
          </g>
        )
      })}
    </g>
  ) : null
}
