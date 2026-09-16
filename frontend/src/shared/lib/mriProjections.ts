/**
 * Три ортогональные проекции мозга (срез 3.1): MNI-геометрия, фикстура границ
 * головы, поля Бродмана и чистая арифметика наведения срезов.
 *
 * Точки диполей приходят в MNI-координатах (мм), поэтому и фикстура строится в
 * MNI: система координат одна — иначе срезы, поля Бродмана и диполи не совпали бы.
 *
 * Реальные MNI-срезы (том fsaverage `mri/T1.mgz` → `mni305.cor.mgz`, MNI152), меш
 * и Brodmann-поля — серверный кэшируемый актив (`docs/ui.md` §3.3, §12). Пока их
 * нет, панель рисует **условный силуэт** границ головы и фикстуру полей по
 * детерминированным генераторам (`demoHeadContours`, `demoBrodmannAreas`):
 * наведение срезов, линейка координат и подсветка полей проверяются без бэкенда,
 * а подмена на реальные данные — это смена источника, а не переписывание отрисовки.
 *
 * Проекции — не 3D-рендер, а три ортогональных среза: фигура и точки диполей
 * рисуются SVG (`app/sections/dipoles/MriProjection.tsx`) — DOM-графика вместо
 * canvas, чтобы слои (вкл/выкл), подсветка поля Бродмана и наведение среза были
 * обычными узлами с `data-testid`, а цвета читались токенами темы без
 * `getComputedStyle`. Как и вьюер треков, панель по клику ничего не запрашивает:
 * наведение среза — чистая перерисовка (`docs/ui.md`, «UI не запускает обработку сам»).
 *
 * Ориентация фигуры задана знаками осей (`PLANE_HORIZONTAL_SIGN`, `PLANE_VERTICAL_SIGN`)
 * и **всегда видна пользователю**: подписи сторон (L/R, A/P, S/I) выводятся из тех же
 * знаков (`planeEdgeLabels`), поэтому разметка не может разойтись с геометрией.
 * Текущая раскладка: вверх всегда растёт вертикальная ось MNI (z — верх, y — перед);
 * горизонталь аксиальной и коронарной инвертирована, поэтому слева на экране —
 * правое полушарие (x > 0): это радиологическая раскладка, она же получается при
 * взгляде на аксиальный срез снизу, а на коронарный — спереди. Сагиттальная
 * показывает перед (нос) справа — вид со стороны правого полушария. Зеркальная
 * раскладка — смена знака в константе, а не правка отрисовки.
 *
 * Масштаб осей **единый** (`PROJECTION_SCALE`): фигуры прямоугольные, анатомия не
 * растягивается. Всё, что живёт в нормализованных координатах (фикстуры слоёв,
 * сетка, следы срезов), получает этот масштаб через `normalizedToPx`.
 *
 * Цвета слоёв — токены темы (`--color-mri-*` в `styles/index.css`): фигуры
 * рисуются SVG, поэтому цвета берутся классами/`var(--color-mri-*)` напрямую
 * (`color-mix` для заливок), а hex в JS не дублируется.
 *
 * Модуль чистый (без DOM и zustand) — вся арифметика покрыта тестами.
 */

/** Плоскость проекции: аксиальная (top), сагиттальная (side), коронарная (front). */
export type ProjectionPlane = 'axial' | 'sagittal' | 'coronal'

export const PROJECTION_PLANES: ProjectionPlane[] = ['axial', 'sagittal', 'coronal']

/**
 * Оси MNI. Знаки — как в `mne`/FreeSurfer (RAS): x — **вправо** (правое
 * полушарие, x > 0), y — вперёд (перед), z — вверх.
 */
export type MniAxis = 'x' | 'y' | 'z'

/** Точка в MNI (мм). Это же представление уходит в контракт диполей. */
export type MniVector = Record<MniAxis, number>

/** Точка в плоскости проекции: нормализованные координаты, обе в −1…+1. */
export type MniPoint2 = { u: number; v: number }

/** Точка в пикселях фигуры (canvas и DOM-оверлей делят эту систему координат). */
export type PixelPoint = { x: number; y: number }

export const PROJECTION_LABELS: Record<ProjectionPlane, string> = {
  axial: 'Аксиальная',
  sagittal: 'Сагиттальная',
  coronal: 'Коронарная',
}

/** Пояснение к плоскости: какой осью MNI наводится срез и что видно на фигуре. */
export const PROJECTION_HINTS: Record<ProjectionPlane, string> = {
  axial: 'вид сверху, срез наводится по оси z (верх–низ MNI)',
  sagittal: 'вид сбоку, срез наводится по оси x (лево–право MNI)',
  coronal: 'вид спереди, срез наводится по оси y (перед–зад MNI)',
}

/** «Нормаль» плоскости — ось MNI, значение которой выбирает срез. */
export const PLANE_AXIS: Record<ProjectionPlane, MniAxis> = {
  axial: 'z',
  sagittal: 'x',
  coronal: 'y',
}

/** Оси, образующие видимую плоскость: [горизонталь, вертикаль]. */
export const PLANE_AXES: Record<ProjectionPlane, [MniAxis, MniAxis]> = {
  axial: ['x', 'y'],
  sagittal: ['y', 'z'],
  coronal: ['x', 'z'],
}

/**
 * Знак горизонтальной оси на экране. У аксиальной и коронарной проекций −1:
 * горизонталь — ось x, и в радиологической ориентации левая часть экрана
 * показывает правое полушарие (x > 0 — правое: левое в fsaverage/MNI лежит при
 * x < 0). Подписи линейки дают фактические значения MNI.
 */
export const PLANE_HORIZONTAL_SIGN: Record<ProjectionPlane, 1 | -1> = {
  axial: -1,
  sagittal: 1,
  coronal: -1,
}

/** Знак вертикальной оси на экране: +1 — вверх растёт значение MNI (z или y). */
export const PLANE_VERTICAL_SIGN: Record<ProjectionPlane, 1 | -1> = {
  axial: 1,
  sagittal: 1,
  coronal: 1,
}

/** Подписи осей для линейки координат. */
export const AXIS_LABELS: Record<MniAxis, string> = {
  x: 'x, мм (вправо +)',
  y: 'y, мм (вперёд +)',
  z: 'z, мм (вверх +)',
}

/**
 * Именованные срезы MNI (ориентации), к которым «прилипает» наведение по клику.
 * Значения нулевые: начало координат MNI — на уровне передней комиссуры, поэтому
 * `x = 0` — срединная сагитталь, `y = 0` — вертикаль через AC–PC, `z = 0` — её
 * горизонталь. Отсюда берутся и подписи в панели, и маркеры на линейке.
 */
export type MniSliceOrientation = 'midline' | 'coronal_zero' | 'axial_zero'

export const SLICE_ORIENTATION_PRESETS: Record<
  MniSliceOrientation,
  { plane: ProjectionPlane; value: number; label: string; mark: string }
> = {
  midline: { plane: 'sagittal', value: 0, label: 'срединная сагитталь', mark: 'x = 0' },
  coronal_zero: { plane: 'coronal', value: 0, label: 'коронарный через AC–PC', mark: 'y = 0' },
  axial_zero: { plane: 'axial', value: 0, label: 'аксиальный через AC–PC', mark: 'z = 0' },
}

export const SLICE_ORIENTATIONS = Object.keys(SLICE_ORIENTATION_PRESETS) as MniSliceOrientation[]

/** Границы тома (мм MNI): рамка, в которую вписываются все проекции. */
export type MniBrainBounds = Record<MniAxis, [number, number]>

/**
 * Границы тома МРТ в MNI (мм): объём мозга вместе с мозжечком и стволом по маске
 * `brainmask` fsaverage (pial-поверхность кроет только кору и на 30 мм выше).
 * По ним считаются размах фигуры, диапазоны срезов и клиппинг, и ровно на этот
 * прямоугольник накрывает картинка среза МРТ: значения обязаны совпадать с
 * `MRI_BOUNDS` бэкенда (`app/services/mri_slices.py`) — совпадение проверяется
 * тестом `backend/tests/test_mri_slices.py::test_geometry_matches_frontend`.
 */
export const MNI_BRAIN_BOUNDS: MniBrainBounds = {
  x: [-80, 80],
  y: [-116, 80],
  z: [-82, 90],
}

/**
 * Пикселей на миллиметр фигуры: **одна шкала у всех проекций**.
 *
 * Пока каждая ось растягивалась на свой размах, квадрат 284×284 px показывал
 * анатомию с искажением: в аксиальной проекции 160 мм по x и 196 мм по y ложились
 * в одну и ту же ширину (до 22% разницы), поэтому мозг выглядел сплюснутым, а
 * сетка MNI по 20 мм не выдавала подмену (шаг клеток одинаков, мм/пиксель — нет).
 * Теперь масштаб общий и изотропный, поэтому фигуры прямоугольные:
 * axial 240×294, sagittal 294×258, coronal 240×258 px. Множитель 1.5 даёт целые
 * пиксели на размахах осей (160/172/196 мм), дробных размеров SVG не любит.
 */
export const PROJECTION_SCALE = 1.5

/** Поле фигуры: контур головы не должен касаться рамки. */
export const PROJECTION_PADDING = 18

/** Допуск «прилипания» среза к именованной ориентации при наведении, мм. */
export const SLICE_SNAP_TOLERANCE_MM = 10

/** Шаг линейки координат и шаг наведения среза кнопками, мм. */
export const SLICE_STEP_MM = 10

/** Срезы трёх плоскостей: то, чем наводится каждая проекция. */
export type SliceTriplet = Record<ProjectionPlane, number>

/** Габариты оси: минимум, максимум, середина, половина размаха (мм). */
export function axisExtent(axis: MniAxis): {
  min: number
  max: number
  center: number
  half: number
} {
  const [min, max] = MNI_BRAIN_BOUNDS[axis]
  return { min, max, center: (min + max) / 2, half: (max - min) / 2 }
}

/** Габариты горизонтальной и вертикальной осей плоскости проекции. */
export function planeExtent(plane: ProjectionPlane): {
  horizontal: ReturnType<typeof axisExtent>
  vertical: ReturnType<typeof axisExtent>
} {
  const [horizontal, vertical] = PLANE_AXES[plane]
  return { horizontal: axisExtent(horizontal), vertical: axisExtent(vertical) }
}

/** Допустимый диапазон значения среза: внутри границ головы. */
export function planeSliceRange(plane: ProjectionPlane): [number, number] {
  return MNI_BRAIN_BOUNDS[PLANE_AXIS[plane]]
}

/**
 * Размеры фигуры проекции в пикселях: прямоугольник плоскости плюс поля
 * (подписи краёв) и вместе с тем — прямоугольник картинки среза.
 */
export type ProjectionBox = {
  /** Ширина фигуры (SVG) вместе с полями */
  width: number
  /** Высота фигуры (SVG) вместе с полями */
  height: number
  /** Ширина прямоугольника плоскости — её накрывает картинка среза */
  innerWidth: number
  innerHeight: number
}

/**
 * Размеры фигуры проекции: размах каждой оси плоскости в едином масштабе.
 *
 * Только эта функция превращает миллиметры в пиксели: остальная геометрия живёт
 * в нормализованных координатах (−1…+1 по размаху оси), поэтому фигура растёт
 * вместе с масштабом, а не «пересчитывается» в каждом компоненте.
 */
export function projectionBox(plane: ProjectionPlane, padding = PROJECTION_PADDING): ProjectionBox {
  const { horizontal, vertical } = planeExtent(plane)
  const innerWidth = horizontal.half * 2 * PROJECTION_SCALE
  const innerHeight = vertical.half * 2 * PROJECTION_SCALE
  return {
    innerWidth,
    innerHeight,
    width: innerWidth + padding * 2,
    height: innerHeight + padding * 2,
  }
}

/** Оси плоскости для подписей линейки: [горизонталь, вертикаль]. */
export function planeAxisLabels(plane: ProjectionPlane): {
  horizontal: MniAxis
  vertical: MniAxis
} {
  const [horizontal, vertical] = PLANE_AXES[plane]
  return { horizontal, vertical }
}
/** Округление до десятых: срезы и координаты читаются как «мм», а не как float. */
export function roundMm(valueMm: number): number {
  return Math.round(valueMm * 10) / 10
}

/** Срез, зажатый в допустимый диапазон плоскости. */
export function clampSlice(plane: ProjectionPlane, valueMm: number): number {
  const [min, max] = planeSliceRange(plane)
  const bounded = Number.isFinite(valueMm) ? valueMm : 0
  return roundMm(Math.min(max, Math.max(min, bounded)))
}

/** Подпись среза: «z = 12.0 мм» — ось MNI и значение. */
export function sliceLabel(plane: ProjectionPlane, valueMm: number): string {
  return `${PLANE_AXIS[plane]} = ${valueMm.toFixed(1)} мм`
}

/** Подпись срезов всех трёх плоскостей для полосы состояния панели. */
export function slicesSummary(slices: SliceTriplet): string {
  return PROJECTION_PLANES.map((plane) => sliceLabel(plane, slices[plane])).join(' · ')
}

/** Подпись координат точки: «MNI 12.0 / −34.5 / 18.0». */
export function coordsLabel(point: MniVector): string {
  return `MNI ${point.x.toFixed(1)} / ${point.y.toFixed(1)} / ${point.z.toFixed(1)}`
}

/** Шаг среза кнопками: значение сдвигается и остаётся внутри границ плоскости. */
export function shiftSlice(
  plane: ProjectionPlane,
  valueMm: number,
  stepMm = SLICE_STEP_MM,
): number {
  return clampSlice(plane, valueMm + stepMm)
}

/**
 * Значение среза, к которому «прилипает» наведение: если точка клика оказалась
 * рядом с именованным срезом, берём ровно его значение (иначе пользователь
 * никогда не попадёт точно в x = 0). Возвращает и ориентацию для подписи панели.
 */
export function snapSlice(
  plane: ProjectionPlane,
  valueMm: number,
  toleranceMm = SLICE_SNAP_TOLERANCE_MM,
): { value: number; orientation: MniSliceOrientation | null } {
  for (const orientation of SLICE_ORIENTATIONS) {
    const preset = SLICE_ORIENTATION_PRESETS[orientation]
    if (preset.plane !== plane) continue
    if (Math.abs(valueMm - preset.value) <= toleranceMm) {
      return { value: preset.value, orientation }
    }
  }
  return { value: clampSlice(plane, valueMm), orientation: null }
}

/** Ориентация, которой соответствует текущее значение среза (или `null`). */
export function orientationOfSlice(
  plane: ProjectionPlane,
  valueMm: number,
  toleranceMm = 0.05,
): MniSliceOrientation | null {
  for (const orientation of SLICE_ORIENTATIONS) {
    const preset = SLICE_ORIENTATION_PRESETS[orientation]
    if (preset.plane === plane && Math.abs(valueMm - preset.value) <= toleranceMm) {
      return orientation
    }
  }
  return null
}

/** Значение среза, заданное именованной ориентацией (быстрые кнопки панели). */
export function orientationSlice(orientation: MniSliceOrientation): {
  plane: ProjectionPlane
  value: number
} {
  const { plane, value } = SLICE_ORIENTATION_PRESETS[orientation]
  return { plane, value }
}

/** Стартовое положение срезов: 0 = уровень AC–PC, то есть все именованные срезы. */
export function defaultSlices(): SliceTriplet {
  return { axial: 0, sagittal: 0, coronal: 0 }
}

/**
 * Точка → нормализованные координаты фигуры.
 *
 * Нормализованная координата — доля размаха своей оси (−1…+1), поэтому у трёх
 * проекций она означает разное число миллиметров. В пиксели её переводит
 * `normalizedToPx` **единым масштабом мм/пиксель** — именно там, и только там,
 * оси получают равный вес (см. `PROJECTION_SCALE`). Обратное преобразование —
 * `normalizedToMni`.
 */
export function mniToNormalized(plane: ProjectionPlane, point: MniVector): MniPoint2 {
  const [horizontal, vertical] = PLANE_AXES[plane]
  const h = axisExtent(horizontal)
  const v = axisExtent(vertical)
  return {
    u: PLANE_HORIZONTAL_SIGN[plane] * ((point[horizontal] - h.center) / h.half),
    v: PLANE_VERTICAL_SIGN[plane] * ((point[vertical] - v.center) / v.half),
  }
}

/** Нормализованные координаты фигуры → точка MNI на заданном срезе. */
export function normalizedToMni(
  plane: ProjectionPlane,
  sliceMm: number,
  point: MniPoint2,
): MniVector {
  const [horizontal, vertical] = PLANE_AXES[plane]
  const h = axisExtent(horizontal)
  const v = axisExtent(vertical)

  const coords: MniVector = { x: 0, y: 0, z: 0 }
  coords[horizontal] = roundMm(h.center + PLANE_HORIZONTAL_SIGN[plane] * point.u * h.half)
  coords[vertical] = roundMm(v.center + PLANE_VERTICAL_SIGN[plane] * point.v * v.half)
  coords[PLANE_AXIS[plane]] = clampSlice(plane, sliceMm)
  return coords
}

/**
 * Нормализованные координаты → пиксели фигуры (плоскость задаёт прямоугольник).
 *
 * Преобразование чисто двумерное (плоскость уже учтена знаками при переводе из
 * MNI), но **не изотропное по нормализованным единицам**: 1 единица u — это
 * половина размаха горизонтальной оси, 1 единица v — вертикальной. В пикселях же
 * обе оси идут в одном масштабе (`PROJECTION_SCALE` px/мм), поэтому анатомия не
 * растягивается: круг в MNI остаётся кругом.
 */
export function normalizedToPx(
  point: MniPoint2,
  plane: ProjectionPlane,
  padding = PROJECTION_PADDING,
): PixelPoint {
  const box = projectionBox(plane, padding)
  return {
    x: padding + ((point.u + 1) / 2) * box.innerWidth,
    y: padding + ((1 - point.v) / 2) * box.innerHeight,
  }
}

/** Пиксели фигуры → нормализованные координаты (обратная к `normalizedToPx`). */
export function pxToNormalized(
  point: PixelPoint,
  plane: ProjectionPlane,
  padding = PROJECTION_PADDING,
): MniPoint2 {
  const box = projectionBox(plane, padding)
  const width = box.innerWidth > 0 ? box.innerWidth : 1
  const height = box.innerHeight > 0 ? box.innerHeight : 1
  return {
    u: ((point.x - padding) / width) * 2 - 1,
    v: 1 - ((point.y - padding) / height) * 2,
  }
}

/** Эллипс слоя в пикселях фигуры: центр и полуоси. */
export type EllipsePx = { cx: number; cy: number; rx: number; ry: number }

/**
 * Эллипс фикстуры (структура среза, поле Бродмана) в пикселях фигуры.
 *
 * Радиусы заданы **в долях полуразмаха своей оси** (`MniPoint2` в нормализованных
 * координатах), поэтому полуось в пикселях — это радиус × половина стороны
 * прямоугольника плоскости. Функция одна на отрисовку и на хит-тест: попадание в
 * поле считается по тем же эллипсам, что нарисованы (`brodmannAreaAt`), и
 * «второго, невидимого» слоя для мыши в разделе нет. Пересчитывать эту
 * арифметику в компоненте нельзя — разъехавшиеся эллипсы сделают подсветку поля
 * ложной, а поймать это глазами почти невозможно.
 */
export function ellipsePx(
  plane: ProjectionPlane,
  center: MniPoint2,
  radius: MniPoint2,
  padding = PROJECTION_PADDING,
): EllipsePx {
  const box = projectionBox(plane, padding)
  const at = normalizedToPx(center, plane, padding)
  return {
    cx: at.x,
    cy: at.y,
    rx: radius.u * (box.innerWidth / 2),
    ry: radius.v * (box.innerHeight / 2),
  }
}

/** Точка MNI → пиксели фигуры (для точек диполей и подписей на срезе). */
export function projectPoint(
  plane: ProjectionPlane,
  point: MniVector,
  padding = PROJECTION_PADDING,
): PixelPoint {
  return normalizedToPx(mniToNormalized(plane, point), plane, padding)
}

/**
 * Клик по фигуре → точка MNI на срезе этой проекции.
 *
 * Точка лежит **в плоскости текущего среза**: две координаты берутся из позиции
 * клика, третья (нормаль плоскости) — из самого среза. Этой точкой панель наводит
 * все три проекции (`applyPointToSlices`) — «смена выбора срезов MNI в точках
 * клика по проекциям» из плана фазы 3.
 */
export function pointFromProjectionClick(
  plane: ProjectionPlane,
  sliceMm: number,
  clickPx: PixelPoint,
  padding = PROJECTION_PADDING,
): MniVector {
  return normalizedToMni(plane, sliceMm, pxToNormalized(clickPx, plane, padding))
}

/** Результат наведения срезов точкой: новые срезы + «прилипшие» ориентации. */
export type SliceNavigation = {
  slices: SliceTriplet
  /** Только те плоскости, чей срез совпал с именованной ориентацией */
  orientations: Partial<Record<ProjectionPlane, MniSliceOrientation>>
  /** Точка, по которой наводили (для подписи координат под фигурами) */
  point: MniVector
}

/**
 * Наведение всех трёх срезов точкой MNI: срез каждой плоскости берётся из
 * соответствующей координаты точки (с прилипанием к именованным ориентациям).
 *
 * Именно так клик по одной проекции двигает все три: пользователь попадает в
 * точку, которую видит, а не настраивает каждый срез отдельно.
 */
export function applyPointToSlices(
  point: MniVector,
  toleranceMm = SLICE_SNAP_TOLERANCE_MM,
): SliceNavigation {
  const slices = defaultSlices()
  const orientations: Partial<Record<ProjectionPlane, MniSliceOrientation>> = {}

  for (const plane of PROJECTION_PLANES) {
    const snapped = snapSlice(plane, point[PLANE_AXIS[plane]], toleranceMm)
    slices[plane] = snapped.value
    if (snapped.orientation) orientations[plane] = snapped.orientation
  }

  return { slices, orientations, point }
}

/** Прямая-ориентир внутри плоскости: след среза соседней проекции. */
export type MniGuideLine = {
  orientation: MniSliceOrientation
  /** Подпись следа: «x = 0» */
  label: string
  axis: 'horizontal' | 'vertical'
  /** Нормализованная координата линии (−1…+1) по её оси */
  at: number
}

/**
 * Следы срезов соседних проекций внутри текущей плоскости.
 *
 * Показываются только когда соседний срез «стоит» на своей именованной
 * ориентации (`toleranceMm`): рисовать линию «y = 0» при срезе y = −30 значило бы
 * врать о геометрии. Даёт пользователю связность трёх фигур: срединная сагитталь
 * видна вертикалью на аксиальной и коронарной проекциях.
 */
export function sliceGuides(
  plane: ProjectionPlane,
  slices: SliceTriplet,
  toleranceMm = 0.05,
): MniGuideLine[] {
  const [horizontalAxis, verticalAxis] = PLANE_AXES[plane]
  const guides: MniGuideLine[] = []

  for (const orientation of SLICE_ORIENTATIONS) {
    const preset = SLICE_ORIENTATION_PRESETS[orientation]
    if (preset.plane === plane) continue
    const axis = PLANE_AXIS[preset.plane]
    // След есть только у тех срезов, чья нормаль лежит в плоскости текущей проекции
    if (axis !== horizontalAxis && axis !== verticalAxis) continue
    if (Math.abs(slices[preset.plane] - preset.value) > toleranceMm) continue

    guides.push({
      orientation,
      label: preset.mark,
      axis: axis === horizontalAxis ? 'vertical' : 'horizontal',
      at: normalizedAxisValue(plane, axis, slices[preset.plane]),
    })
  }

  return guides
}

/** Нормализованная координата оси внутри плоскости (по её фактическому значению). */
export function normalizedAxisValue(
  plane: ProjectionPlane,
  axis: MniAxis,
  valueMm: number,
): number {
  const [horizontal] = PLANE_AXES[plane]
  const extent = axisExtent(axis)
  const sign = axis === horizontal ? PLANE_HORIZONTAL_SIGN[plane] : PLANE_VERTICAL_SIGN[plane]
  return sign * ((valueMm - extent.center) / extent.half)
}

/** Положение значения среза на линейке: 0 — начало диапазона, 1 — конец. */
export function sliceFraction(plane: ProjectionPlane, valueMm: number): number {
  const [min, max] = planeSliceRange(plane)
  if (max <= min) return 0.5
  return Math.min(1, Math.max(0, (valueMm - min) / (max - min)))
}

/** Деление оси MNI: значение и положение 0…1 от минимума к максимуму. */
export type AxisTick = { valueMm: number; fraction: number }

/** Шаг координатной сетки проекций, мм. */
export const COORD_TICK_MM = 20

/** Деления оси MNI каждые `stepMm` мм: общая основа сетки и линеек. */
export function axisTicks(axis: MniAxis, stepMm = COORD_TICK_MM): AxisTick[] {
  const { min, max } = axisExtent(axis)
  const step = stepMm > 0 ? stepMm : COORD_TICK_MM
  const ticks: AxisTick[] = []
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) {
    ticks.push({ valueMm: value, fraction: (value - min) / (max - min) })
  }
  return ticks
}

/** Деление линейки срезов: то же деление оси плюс подпись значения. */
export type SliceTick = AxisTick & { label: string }

/**
 * Деления линейки срезов: каждые `stepMm` мм по диапазону плоскости.
 *
 * Линейка — второй способ навести срез (первый — клик по фигуре): на срезах
 * с малым шагом клик по пикселю даёт ±1 мм, а линейка позволяет попасть точно и
 * увидеть, где находится текущий срез относительно границ головы.
 */
export function sliceTicks(plane: ProjectionPlane, stepMm = SLICE_STEP_MM): SliceTick[] {
  // Срез наводится по нормали плоскости — деления те же, что у этой оси
  return axisTicks(PLANE_AXIS[plane], stepMm).map((tick) => ({
    ...tick,
    label: String(tick.valueMm),
  }))
}

/**
 * Линия координатной сетки внутри плоскости: где рисовать и что подписать.
 *
 * `orientation` — направление **самой линии**: деление по горизонтальной оси
 * даёт вертикальную линию (линия постоянной горизонтальной координаты).
 * `at` — нормализованная координата (по оси, перпендикулярной линии) с учётом
 * знаков осей плоскости.
 */
export type MniGridLine = {
  orientation: 'horizontal' | 'vertical'
  valueMm: number
  at: number
}

/**
 * Координатная сетка проекции: деления по обеим осям плоскости.
 *
 * Линии идут «через каждые N мм» по каждой оси независимо, а поскольку масштаб
 * мм/пиксель общий, клетки сетки получаются квадратными — по ним и видно, что
 * проекция не растянута (сравните с `PROJECTION_SCALE`).
 */
export function planeGridLines(plane: ProjectionPlane, stepMm = COORD_TICK_MM): MniGridLine[] {
  const [horizontal, vertical] = PLANE_AXES[plane]
  const lines: MniGridLine[] = []
  for (const tick of axisTicks(horizontal, stepMm)) {
    lines.push({
      orientation: 'vertical',
      valueMm: tick.valueMm,
      at: normalizedAxisValue(plane, horizontal, tick.valueMm),
    })
  }
  for (const tick of axisTicks(vertical, stepMm)) {
    lines.push({
      orientation: 'horizontal',
      valueMm: tick.valueMm,
      at: normalizedAxisValue(plane, vertical, tick.valueMm),
    })
  }
  return lines
}

/** Именованный срез на линейке: значение ориентации + её подпись. */
export type SliceOrientationMark = {
  orientation: MniSliceOrientation
  valueMm: number
  fraction: number
  label: string
  mark: string
}

/** Именованные срезы этой плоскости (у каждой проекции он один — на уровне AC–PC). */
export function sliceOrientationMarks(plane: ProjectionPlane): SliceOrientationMark[] {
  return SLICE_ORIENTATIONS.filter(
    (orientation) => SLICE_ORIENTATION_PRESETS[orientation].plane === plane,
  ).map((orientation) => {
    const preset = SLICE_ORIENTATION_PRESETS[orientation]
    return {
      orientation,
      valueMm: preset.value,
      fraction: sliceFraction(plane, preset.value),
      label: preset.label,
      mark: preset.mark,
    }
  })
}

/**
 * Условный силуэт границ головы на срезе (фикстура, `docs/ui.md` §3.3).
 *
 * Замкнутый контур в плоскости среза, сжимающийся к краям диапазона: у полюсов
 * среза он вырождается в точку, поэтому фигура ведёт себя как «череп», а не как
 * рамка окна. Форма детерминирована (без ГПСЧ) — результат одинаков между
 * рендерами, тестами и повторными монтированиями панели.
 *
 * Реальный контур даст объём томографии (fsaverage `mri/brainmask.mgz`, MNI):
 * подключение — смена источника данных, геометрия и отрисовка те же.
 */
export const CONTOUR_SAMPLES = 96

/** Условные оси эллипса-силуэта в нормализованных координатах каждой плоскости.
 *
 * Полурадиусы заданы долями размаха своей оси: анатомию это не искажает — в
 * пиксели их переводит единый масштаб мм/пиксель (`normalizedToPx`), поэтому
 * вытянутая по y голова в аксиальной проекции получается вытянутой и на экране.
 */
const DEMO_HEAD_SHAPE: Record<
  ProjectionPlane,
  { semiU: number; semiV: number; centerU: number; centerV: number }
> = {
  axial: { semiU: 0.9, semiV: 0.84, centerU: 0, centerV: -0.08 },
  sagittal: { semiU: 0.82, semiV: 0.88, centerU: 0, centerV: 0.04 },
  coronal: { semiU: 0.86, semiV: 0.86, centerU: 0, centerV: -0.02 },
}

/** Остаточный размер контура у полюсов среза: фигура не схлопывается в точку. */
const CONTOUR_MIN_SHRINK = 0.35

/** Точки контура границ головы на срезе (нормализованные координаты фигуры). */
export function demoHeadContours(plane: ProjectionPlane, sliceMm: number): MniPoint2[] {
  const shape = DEMO_HEAD_SHAPE[plane]
  // Глубина среза: −1…+1 от середины диапазона к границам
  const t = sliceFraction(plane, sliceMm) * 2 - 1
  const shrink = CONTOUR_MIN_SHRINK + (1 - CONTOUR_MIN_SHRINK) * Math.sqrt(Math.max(0, 1 - t * t))

  const points: MniPoint2[] = []
  for (let index = 0; index < CONTOUR_SAMPLES; index++) {
    const angle = (index / CONTOUR_SAMPLES) * Math.PI * 2
    points.push({
      u: shape.centerU + Math.cos(angle) * shape.semiU * shrink,
      v: shape.centerV + Math.sin(angle) * shape.semiV * shrink,
    })
  }
  return points
}

/** Поле Бродмана на срезе: эллипс в нормализованных координатах + видимость. */
export type MniAreaShape = {
  name: string
  center: MniPoint2
  /** Полурадиусы эллипса в нормализованных единицах (u — горизонталь, v — вертикаль) */
  radius: MniPoint2
  /** Проявление поля на этом срезе, 0…1: поля уходят по глубине, а не «висят» все сразу */
  alpha: number
}

/**
 * Раскладка фикстуры полей Бродмана: несколько областей на плоскость.
 * `t0` — глубина среза (в тех же −1…+1), где поле проявляется максимально,
 * `spread` — насколько быстро оно уходит. Реальные поля придут из
 * `PALS_B12_Brodmann` (`backend/app/services/surface_cache.py`), эта таблица — фикстура.
 */
const DEMO_BA_LAYOUT: Record<
  ProjectionPlane,
  { name: string; u: number; v: number; ru: number; rv: number; t0: number; spread: number }[]
> = {
  axial: [
    { name: 'BA4', u: 0.34, v: 0.22, ru: 0.22, rv: 0.3, t0: 0.3, spread: 1.5 },
    { name: 'BA6', u: 0.3, v: 0.52, ru: 0.2, rv: 0.26, t0: 0.1, spread: 1.6 },
    { name: 'BA17', u: 0, v: -0.72, ru: 0.34, rv: 0.26, t0: -0.2, spread: 1.5 },
    { name: 'BA41', u: -0.52, v: -0.18, ru: 0.24, rv: 0.3, t0: -0.4, spread: 1.2 },
  ],
  sagittal: [
    { name: 'BA8', u: 0.36, v: 0.44, ru: 0.24, rv: 0.26, t0: 0.4, spread: 1.5 },
    { name: 'BA31', u: 0.05, v: 0.5, ru: 0.26, rv: 0.2, t0: -0.1, spread: 1.6 },
    { name: 'BA17', u: -0.62, v: -0.3, ru: 0.24, rv: 0.34, t0: -0.3, spread: 1.5 },
    { name: 'BA22', u: 0.2, v: -0.62, ru: 0.32, rv: 0.22, t0: 0, spread: 1.4 },
  ],
  coronal: [
    { name: 'BA4', u: 0.36, v: 0.42, ru: 0.24, rv: 0.3, t0: 0.5, spread: 1.5 },
    { name: 'BA6', u: 0.3, v: 0.62, ru: 0.22, rv: 0.22, t0: 0.2, spread: 1.6 },
    { name: 'BA44', u: 0.56, v: -0.12, ru: 0.2, rv: 0.24, t0: -0.5, spread: 1.3 },
    { name: 'BA17', u: -0.7, v: -0.18, ru: 0.2, rv: 0.28, t0: -0.4, spread: 1.4 },
  ],
}

/** Ниже этой видимости поле на срезе не рисуем: иначе «пыль» из полупрозрачных пятен. */
const AREA_MIN_ALPHA = 0.15

/** Поля Бродмана, видимые на текущем срезе (фикстура, пока нет реальных полей). */
export function demoBrodmannAreas(plane: ProjectionPlane, sliceMm: number): MniAreaShape[] {
  const t = sliceFraction(plane, sliceMm) * 2 - 1
  return DEMO_BA_LAYOUT[plane]
    .map((area) => ({
      name: area.name,
      center: { u: area.u, v: area.v },
      radius: { u: area.ru, v: area.rv },
      alpha: Math.min(1, Math.max(0, 1 - Math.abs(t - area.t0) / area.spread)),
    }))
    .filter((area) => area.alpha >= AREA_MIN_ALPHA)
}

/**
 * Поле Бродмана под точкой фигуры (`null` — попадание вне полей).
 *
 * Клик по полю подсвечивает его (`docs/ui.md` §3.3: «подсветка поля Бродмана/ROI»),
 * поэтому попадание проверяется по тем же эллипсам, что нарисованы на canvas:
 * геометрия одна, без второго «невидимого» слоя для мыши.
 */
export function brodmannAreaAt(
  plane: ProjectionPlane,
  sliceMm: number,
  point: MniPoint2,
): string | null {
  const areas = demoBrodmannAreas(plane, sliceMm)
  for (let index = areas.length - 1; index >= 0; index--) {
    const area = areas[index]
    const du = (point.u - area.center.u) / area.radius.u
    const dv = (point.v - area.center.v) / area.radius.v
    if (du * du + dv * dv <= 1) return area.name
  }
  return null
}

/** Направления оси MNI на экране: какой край фигуры что показывает. */
export const AXIS_DIRECTION_LABELS: Record<MniAxis, { positive: string; negative: string }> = {
  x: { positive: 'R', negative: 'L' },
  y: { positive: 'A', negative: 'P' },
  z: { positive: 'S', negative: 'I' },
}

/** Полные пояснения направлений осей (подписи краёв и тултипы). */
export const AXIS_DIRECTION_HINTS: Record<MniAxis, { positive: string; negative: string }> = {
  x: { positive: 'правое полушарие, x > 0', negative: 'левое полушарие, x < 0' },
  y: { positive: 'перед, anterior, y > 0', negative: 'зад, posterior, y < 0' },
  z: { positive: 'верх, superior, z > 0', negative: 'низ, inferior, z < 0' },
}

/** Подпись края фигуры: буква-направление и её пояснение. */
export type PlaneEdgeLabel = { text: string; hint: string }

/**
 * Подписи четырёх краёв фигуры проекции (L/R, A/P, S/I).
 *
 * Выводятся из знаков осей (`PLANE_HORIZONTAL_SIGN`/`PLANE_VERTICAL_SIGN`), а не
 * записаны таблицей: разметка краёв не может разойтись с геометрией — поменяли
 * знак оси (зеркальная раскладка) и подписи поменялись вместе с ней. Поэтому
 * пользователь всегда видит, какое полушарие у проекции слева, а какое справа.
 */
export function planeEdgeLabels(plane: ProjectionPlane): {
  right: PlaneEdgeLabel
  left: PlaneEdgeLabel
  top: PlaneEdgeLabel
  bottom: PlaneEdgeLabel
} {
  const [horizontalAxis, verticalAxis] = PLANE_AXES[plane]
  const horizontal = axisDirections(horizontalAxis, PLANE_HORIZONTAL_SIGN[plane])
  const vertical = axisDirections(verticalAxis, PLANE_VERTICAL_SIGN[plane])
  return {
    right: horizontal.positive,
    left: horizontal.negative,
    top: vertical.positive,
    bottom: vertical.negative,
  }
}

/** Направления оси с учётом её знака на экране: что попадает на «плюс», что на «минус». */
function axisDirections(
  axis: MniAxis,
  sign: 1 | -1,
): { positive: PlaneEdgeLabel; negative: PlaneEdgeLabel } {
  const labels = AXIS_DIRECTION_LABELS[axis]
  const hints = AXIS_DIRECTION_HINTS[axis]
  const positive: PlaneEdgeLabel = { text: labels.positive, hint: hints.positive }
  const negative: PlaneEdgeLabel = { text: labels.negative, hint: hints.negative }
  // sign = −1: ось MNI на экране развёрнута, поэтому «плюс» уходит в другую сторону
  return sign === 1 ? { positive, negative } : { positive: negative, negative: positive }
}

/**
 * Анатомический ориентир на срезе MNI (фикстура слоя «Срезы MNI»).
 *
 * Пока реального тома нет, срез рисуется схемой: желудочки, мозолистое тело,
 * ствол, таламус. Схема не претендует на точность — она нужна, чтобы смена
 * срезов была **видна** (структуры уходят по глубине, форма контура меняется),
 * а не чтобы заменять томографию. Реальные срезы — отдельный серверный актив
 * (`docs/ui.md` §3.3, §12), тогда эта таблица станет не нужна.
 */
export type MniSliceStructure = {
  id: string
  label: string
  center: MniPoint2
  /** Полурадиусы эллипса в нормализованных единицах (u — горизонталь, v — вертикаль) */
  radius: MniPoint2
  /** Проявление на этом срезе, 0…1 */
  alpha: number
  /** Полость (желудочек) рисуется обводкой, а не заливкой */
  hollow: boolean
}

/** Раскладка схемы среза: `t0` — глубина (в −1…+1), где структура видна лучше всего. */
const DEMO_SLICE_LAYOUT: Record<
  ProjectionPlane,
  {
    id: string
    label: string
    u: number
    v: number
    ru: number
    rv: number
    t0: number
    spread: number
    hollow?: boolean
  }[]
> = {
  axial: [
    {
      id: 'ventricles',
      label: 'желудочки',
      u: 0,
      v: 0.12,
      ru: 0.28,
      rv: 0.14,
      t0: 0.45,
      spread: 1.1,
      hollow: true,
    },
    { id: 'thalamus', label: 'таламус', u: 0, v: -0.18, ru: 0.24, rv: 0.16, t0: 0.1, spread: 1.3 },
    {
      id: 'brainstem',
      label: 'ствол мозга',
      u: 0,
      v: -0.52,
      ru: 0.15,
      rv: 0.16,
      t0: -0.4,
      spread: 1.2,
    },
  ],
  sagittal: [
    {
      id: 'ventricles',
      label: 'желудочки',
      u: 0.02,
      v: 0.1,
      ru: 0.24,
      rv: 0.12,
      t0: 0.3,
      spread: 1.2,
      hollow: true,
    },
    {
      id: 'callosum',
      label: 'мозолистое тело',
      u: 0.04,
      v: 0.32,
      ru: 0.3,
      rv: 0.1,
      t0: 0.2,
      spread: 1.4,
    },
    {
      id: 'brainstem',
      label: 'ствол мозга',
      u: 0,
      v: -0.28,
      ru: 0.13,
      rv: 0.28,
      t0: -0.2,
      spread: 1.3,
    },
    {
      id: 'cerebellum',
      label: 'мозжечок',
      u: -0.58,
      v: -0.46,
      ru: 0.22,
      rv: 0.2,
      t0: -0.5,
      spread: 1.5,
    },
  ],
  coronal: [
    {
      id: 'ventricles',
      label: 'желудочки',
      u: 0,
      v: 0.14,
      ru: 0.22,
      rv: 0.2,
      t0: 0.35,
      spread: 1.2,
      hollow: true,
    },
    {
      id: 'callosum',
      label: 'мозолистое тело',
      u: 0,
      v: 0.36,
      ru: 0.3,
      rv: 0.08,
      t0: 0.25,
      spread: 1.4,
    },
    {
      id: 'thalamus_l',
      label: 'таламус слева',
      u: 0.22,
      v: -0.1,
      ru: 0.16,
      rv: 0.14,
      t0: 0.05,
      spread: 1.3,
    },
    {
      id: 'thalamus_r',
      label: 'таламус справа',
      u: -0.22,
      v: -0.1,
      ru: 0.16,
      rv: 0.14,
      t0: 0.05,
      spread: 1.3,
    },
  ],
}

/** Ниже этого проявления структура на срезе не рисуется: не «пыль» полупрозрачных пятен. */
export const SLICE_STRUCTURE_MIN_ALPHA = 0.12

/** Структуры схемы среза, видимые на текущем срезе (фикстура слоя «Срезы MNI»). */
export function demoSliceStructures(plane: ProjectionPlane, sliceMm: number): MniSliceStructure[] {
  const t = sliceFraction(plane, sliceMm) * 2 - 1
  return DEMO_SLICE_LAYOUT[plane]
    .map((structure) => ({
      id: structure.id,
      label: structure.label,
      center: { u: structure.u, v: structure.v },
      radius: { u: structure.ru, v: structure.rv },
      alpha: Math.min(1, Math.max(0, 1 - Math.abs(t - structure.t0) / structure.spread)),
      hollow: structure.hollow === true,
    }))
    .filter((structure) => structure.alpha >= SLICE_STRUCTURE_MIN_ALPHA)
}
