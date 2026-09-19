/**
 * Точки диполей и векторы их моментов в проекциях мозга (срез 3.1, пустой слой).
 *
 * Слой пока **пустой по замыслу**: UI фазы 3 не считает диполи сам, а расчёт
 * (`docs/ui.md` §12, находки F17–F19) — следующий срез вместе с кнопкой запуска.
 * Поэтому панель показывает «диполей: 0» и честную подсказку «расчёт не
 * подключён», а не имитацию результата: тип точки и её связь с MNI уже описаны,
 * чтобы подключение расчёта было сменой источника данных, а не переписыванием
 * отрисовки.
 *
 * Модуль чистый (без DOM и zustand): точки рисует `sections/dipoles/MriProjection.tsx`,
 * оверлей векторов — там же, DOM-слоем поверх canvas.
 */
import {
  PLANE_AXES,
  PLANE_HORIZONTAL_SIGN,
  PLANE_VERTICAL_SIGN,
  PROJECTION_PADDING,
  PROJECTION_SCALE,
  projectPoint,
  type MniPoint2,
  type MniVector,
  type PixelPoint,
  type ProjectionPlane,
} from './mriProjections'
import { mulberry32 } from './demoSignal'
import type { DipoleScanResult } from '@/shared/api/types'

/** Лучший диполь эпохи: позиция в MNI, момент (вектор) и метрики качества. */
export type DipolePoint = {
  /** Ключ React: `эпоха-точка` (в контракте API — `epoch_index` + `time_ms`) */
  id: string
  epochIndex: number
  timeMs: number
  /** Позиция в MNI после `head_to_mni`, мм */
  position: MniVector
  /**
   * Ориентация диполя — три компоненты момента (А·м), задаёт направление
   * вектора на проекциях: рисуется от позиции точки, длина — по амплитуде.
   */
  orientation: MniVector
  /** Амплитуда момента, нА·м (в UI — нАм, как в таблице локализации) */
  amplitudeNaM: number
  /** Goodness of fit диполя, 0…1 */
  gof: number
  /** Поле Бродмана лучшей точки (`null` — не определено) */
  brodmannArea: string | null
  /**
   * Анатомическая структура по MNI-координате (`aparc+aseg`, тот же атлас, что и
   * контуры срезов). `null` — координаты/метки нет: подпись не выдумывается.
   */
  structure: string | null
  /**
   * Сколько диполей стоит в этом узле сетки (поправка ручной проверки, 18.09.2026).
   *
   * Быстрый расчёт ищет позицию перебором узлов, поэтому несколько эпох часто
   * выбирают один и тот же узел, и их кольца рисуются ровно друг на друге. Число
   * заполняет `withOverlapCounts` по **видимому** слою (после порога «КД»), и по нему
   * считается размер кольца и заливка (`dipoleDotVisual`); `1`/`undefined` — узел
   * занят одним диполем.
   */
  overlapCount?: number
}

/** Слой диполей: точки + флаг источника («результат задачи» или фикстура). */
export type DipoleLayer = {
  points: DipolePoint[]
  source: 'demo' | 'result'
}

/**
 * Пустой слой — состояние до расчёта: `source: 'result'` (данных нет, а не
 * фикстура разработки), `points: []`. Единая точка правды для панели и её счётчиков.
 */
export function emptyDipoleLayer(): DipoleLayer {
  return { points: [], source: 'result' }
}

/** Текст о состоянии слоя: панель не должна выглядеть «сломанной» без расчёта. */
export function dipoleLayerStatus(layer: DipoleLayer): string {
  if (layer.points.length === 0) return 'Расчёт диполей не подключён — слой пуст'
  return `Точек диполей: ${layer.points.length}`
}

/**
 * Слой диполей из результата быстрого расчёта (срез 3.4).
 *
 * Точки без MNI (`mni_coords === null`, fsaverage недоступен) в слой **не
 * попадают**: проекции рисуют MNI-координаты, и «нарисовать» точку в системе
 * головы значило бы показать её не там. Такие точки сообщаются предупреждением
 * задачи, а не подменой координат.
 */
export function dipoleLayerFromScan(result: DipoleScanResult): DipoleLayer {
  const points: DipolePoint[] = []
  for (const point of result.points) {
    const coords = point.mni_coords
    if (!coords || coords.length !== 3) continue
    const [x, y, z] = coords
    if (![x, y, z].every(Number.isFinite)) continue
    points.push({
      id: `${point.epoch_index}-${Math.round(point.time_ms)}`,
      epochIndex: point.epoch_index,
      timeMs: point.time_ms,
      position: { x, y, z },
      orientation: {
        x: point.moment[0] ?? 0,
        y: point.moment[1] ?? 0,
        z: point.moment[2] ?? 0,
      },
      amplitudeNaM: point.amplitude_nam,
      gof: point.gof,
      brodmannArea: point.brodmann_area,
      structure: point.anatomical_structure,
    })
  }
  return { points, source: 'result' }
}

/**
 * Слой с порогом по моменту «КД ≥ X нАм»: слабые диполи скрываются.
 *
 * Порог — параметр **отображения**: он не меняет результат задачи (точки в слое
 * остаются теми же), поэтому счётчик скрытых точек возвращается отдельно, и
 * панель объясняет, что часть диполей не рисуется из-за порога.
 */
export function thresholdDipoleLayer(layer: DipoleLayer, minAmplitudeNaM: number): DipoleLayer {
  if (!(minAmplitudeNaM > 0)) return layer
  return {
    points: layer.points.filter((point) => point.amplitudeNaM >= minAmplitudeNaM),
    source: layer.source,
  }
}

/** Сколько точек скрыто порогом (для пояснения в панели). */
export function hiddenByThreshold(layer: DipoleLayer, minAmplitudeNaM: number): number {
  if (!(minAmplitudeNaM > 0)) return 0
  return layer.points.filter((point) => point.amplitudeNaM < minAmplitudeNaM).length
}

/**
 * Прирост **диаметра** кольца позиции на каждый диполь в одном узле сетки, px
 * (поправка ручной проверки, 18.09.2026).
 *
 * Быстрый расчёт ищет позицию перебором узлов, поэтому несколько эпох могут выбрать
 * один узел — раньше их кольца рисовались ровно друг на друге, и «в узле три
 * диполя» выглядело как один. Теперь размер кольца читает кратность узла: Ø 6 px для
 * одиночного, +2 px на каждый следующий. Силу диполя по-прежнему кодирует луч
 * (`dipoleRayVisual`), а не кольцо — иначе две разные величины спорили бы за один
 * визуальный канал.
 */
export const DIPOLE_DOT_GROWTH_PX = 2

/**
 * Заливка включается, когда диаметр упёрся в предел (`2 · grid_mm`): дальше кратность
 * читается плотностью заливки. 0.25 — «в узле больше диполей, чем влезает в размер»;
 * выше предел не поднимается, чтобы заливка не превратилась в сплошное пятно.
 */
export const OVERLAP_FILL_MIN_OPACITY = 0.25

/** Прирост заливки на «лишний» диполь: от `OVERLAP_FILL_MIN_OPACITY` до 1. */
export const OVERLAP_FILL_GROWTH = 0.75

/** Ключ позиции для поиска совпадений: миллиметры с точностью 0.001. */
function positionKey(position: MniVector): string {
  return `${position.x.toFixed(3)}|${position.y.toFixed(3)}|${position.z.toFixed(3)}`
}

/**
 * Проставить точкам число диполей в их узле (`overlapCount`).
 *
 * Считается по **видимому** слою (после порога «КД ≥»): кольцо не должно обещать
 * диполи, скрытые порогом. Функция чистая: координаты, порядок и сами точки не
 * меняются, добавляется только производное число; узел с одним диполем остаётся с
 * `1`. Если совпадений нет, возвращается тот же объект слоя.
 */
export function withOverlapCounts(layer: DipoleLayer): DipoleLayer {
  if (layer.points.length < 2) return layer
  const counts = new Map<string, number>()
  for (const point of layer.points) {
    const key = positionKey(point.position)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return {
    ...layer,
    points: layer.points.map((point) => ({
      ...point,
      overlapCount: counts.get(positionKey(point.position)) ?? 1,
    })),
  }
}

/**
 * Точки того же узла сетки (одна позиция MNI с точностью ключа), включая саму
 * точку (находка ручной проверки, 19.09.2026).
 *
 * Курсорный тултип проекции перечисляет эпохи узла: число «диполей в узле: N»
 * без их списка не отвечало на вопрос «какие именно эпохи» и оставляло
 * невнятным, для какой эпохи сработает «Уточнить».
 */
export function dipoleNodeSiblings(points: DipolePoint[], point: DipolePoint): DipolePoint[] {
  const key = positionKey(point.position)
  return points.filter((other) => positionKey(other.position) === key)
}

/** Геометрия кольца позиции: радиус и заливка по кратности узла. */
export type DipoleDotVisual = {
  /** Радиус кольца в единицах viewBox (экранный размер делится на масштаб фигуры) */
  radiusUnits: number
  /** Заливка внутренней области, 0…1: `0` — заливки нет */
  fillOpacity: number
  /** Кольцо упёрлось в предел `2 · grid_mm`: кратность показывает заливка */
  capped: boolean
}

/**
 * Кольцо позиции по кратности узла: Ø `6 + 2·(n − 1)` px, но не больше `2 · grid_mm`.
 *
 * Предел — центр соседнего узла сетки: кольцо не должно вылезать в соседнюю ячейку и
 * выглядеть как диполь «между узлами». Когда кратность не влезает в предел, диаметр
 * замирает, а число диполей показывает заливка — от `OVERLAP_FILL_MIN_OPACITY` (25 %)
 * и выше. Ниже базового экранного размера предел кольцо не опускает: при мелком шаге
 * сетки одиночный диполь не должен рисоваться мельче остальных.
 *
 * `gridMm <= 0` (результата нет) — предела нет, кольцо растёт как задано, заливки нет.
 */
export function dipoleDotVisual(
  overlapCount: number,
  gridMm: number,
  pxPerUnit: number,
): DipoleDotVisual {
  const scale = pxPerUnit > 0 ? pxPerUnit : 1
  const count = Number.isFinite(overlapCount) ? Math.max(1, Math.floor(overlapCount)) : 1
  // Экранные пиксели → единицы фигуры: Ø 6 px плюс 2 px на каждый диполь в узле
  const baseDiameter = (2 * DIPOLE_DOT_RADIUS_PX) / scale
  const growth = DIPOLE_DOT_GROWTH_PX / scale
  const rawDiameter = baseDiameter + growth * (count - 1)
  const maxDiameter = gridMm > 0 ? 2 * gridMm * PROJECTION_SCALE : Number.POSITIVE_INFINITY

  if (rawDiameter <= maxDiameter) {
    return { radiusUnits: rawDiameter / 2, fillOpacity: 0, capped: false }
  }
  // Сколько диполей влезает в предел: дальше растёт только заливка
  const maxCount = 1 + Math.max(0, Math.floor((maxDiameter - baseDiameter) / growth))
  const overflow = Math.max(1, count - maxCount)
  return {
    radiusUnits: Math.max(baseDiameter, maxDiameter) / 2,
    fillOpacity: Math.min(1, OVERLAP_FILL_MIN_OPACITY + (OVERLAP_FILL_GROWTH * overflow) / maxCount),
    capped: true,
  }
}

/** Масштаб вектора на проекции: пикселей на 1 нА·м момента. */
export const VECTOR_PX_PER_NA_M = 0.5

/** Вектор не короче этого (иначе точка без «луча» выглядит как артефакт отрисовки). */
export const VECTOR_MIN_PX = 7

/** Верхняя граница длины вектора: сильный диполь не должен закрывать всю проекцию. */
export const VECTOR_MAX_PX = 30

/** Длина вектора диполя в пикселях по амплитуде момента (с зажимом в разумные рамки). */
export function dipoleVectorLength(amplitudeNaM: number): number {
  const raw = Math.abs(amplitudeNaM) * VECTOR_PX_PER_NA_M
  return Math.min(VECTOR_MAX_PX, Math.max(VECTOR_MIN_PX, raw))
}

/** Амплитуда, при которой маркер «полный»: сильнее — уже не растёт, нАм. */
export const FORCE_FULL_NAM = 100

/**
 * Сила диполя как доля шкалы отображения, 0…1.
 *
 * Сила = амплитуда момента (нА·м). Шкала **зажата сверху** (`FORCE_FULL_NAM`):
 * одиночный выброс в 10 раз больше остальных иначе растянул бы шкалу, и все
 * остальные диполи выглядели бы одинаково мелкими — по картинке нельзя было бы
 * сравнить их силу. Выше насыщения маркер не растёт, но и не врёт: он просто
 * «самый сильный».
 */
export function dipoleForceFraction(amplitudeNaM: number): number {
  if (!Number.isFinite(amplitudeNaM)) return 0
  return Math.min(1, Math.abs(amplitudeNaM) / FORCE_FULL_NAM)
}

/**
 * Кольцо позиции диполя — фиксированный **экранный** размер (поправка ручной
 * проверки): диаметр 6 px и штрих 2 px при любом размере окна браузера. Фигура
 * SVG растягивается по ширине колонки (`width: 100%`), поэтому компонент делит
 * эти пиксели на текущий масштаб `renderedWidth / viewBox.width` — размер кольца
 * на экране не зависит ни от масштаба фигуры, ни от силы диполя.
 */
export const DIPOLE_DOT_RADIUS_PX = 3
export const DIPOLE_DOT_STROKE_PX = 2

/**
 * Толщина луча момента — тоже фиксированный **экранный** размер (поправка ручной
 * проверки): 2 px при любом размере окна, как штрих кольца позиции. Толщина силу
 * не кодирует: при плотном облаке точек «жирные» лучи сливались бы в пятно, а
 * силу диполя и без них видно по длине и плотности луча.
 */
export const DIPOLE_RAY_STROKE_PX = 2
/**
 * Маркер кадра воспроизведения (срез 3.7): кольцо позиции остаётся обычным (Ø 6
 * px — размер позиции менять нельзя), а «выбранный сейчас» кадр отмечает **гало**
 * — тонкое кольцо большего радиуса. Так кадр отличается от кликового выделения,
 * не нарушая правило «все позиции — одинаковые кольца».
 */
export const DIPOLE_FRAME_HALO_RADIUS_PX = 7
export const DIPOLE_FRAME_HALO_STROKE_PX = 2
/**
 * Штрих шлейфа траектории: 2 px по экрану — как у луча момента. Шлейф — это
 * история того же диполя, поэтому его линии живут в той же «толщине», а не в
 * своей собственной: разные толщины у родственных элементов читаются как разные
 * сущности.
 */
export const TRAIL_STROKE_PX = 2
/**
 * Приглушение облака точек в режиме кадра: смотреть движение и видеть, что именно
 * движется, можно, только когда остальные точки не спорят с маркером за внимание.
 * Выделенный кликом диполь не приглушается — это осознанный выбор пользователя.
 *
 * Значение — прозрачность, во столько раз «слабее» обычной: 0.3 = 0.2 × 1.5
 * (поправка ручной проверки — облако под анимацией должно читаться, а не
 * угадываться; но и не конкурировать с кадром, поэтому выше `MARKER_OPACITY_MIN`
 * оно не поднимается).
 */
export const FRAME_DIM_OPACITY = 0.3
/** Слабый диполь всё равно виден: прозрачность луча ниже этой не опускается. */
export const MARKER_OPACITY_MIN = 0.35
/**
 * Радиус хит-зоны выделения, px: попасть в кольцо диаметром 6 px мышью трудно,
 * а выделение диполя — основной способ «выбрать точку» в разделе.
 */
export const DOT_HIT_RADIUS_PX = 9

/** Оформление луча момента по силе диполя: толщина фиксирована, силу кодирует плотность. */
export type DipoleRayVisual = {
  /** Непрозрачность луча, 0…1 */
  opacity: number
}

/**
 * Отрисовка луча по силе диполя: сильнее — плотнее и длиннее, слабее —
 * прозрачнее. Толщина у всех лучей одна (`DIPOLE_RAY_STROKE_PX`): «жирные» лучи
 * сливались бы в пятно при плотном облаке точек.
 */
export function dipoleRayVisual(amplitudeNaM: number): DipoleRayVisual {
  const force = dipoleForceFraction(amplitudeNaM)
  return { opacity: MARKER_OPACITY_MIN + force * (1 - MARKER_OPACITY_MIN) }
}

/**
 * Проекция вектора момента на плоскость проекции: направление в нормализованных
 * осях фигуры (u — горизонталь, v — вертикаль).
 *
 * Берутся только две компоненты момента, лежащие в плоскости среза; компонента
 * вдоль нормали среза направление луча не меняет — поэтому на проекции видны
 * именно две её оси, а не «сплющенный» 3D-вектор.
 */
export function dipoleVectorDirection(plane: ProjectionPlane, orientation: MniVector): MniPoint2 {
  const [horizontal, vertical] = PLANE_AXES[plane]
  const u = PLANE_HORIZONTAL_SIGN[plane] * orientation[horizontal]
  const v = PLANE_VERTICAL_SIGN[plane] * orientation[vertical]
  const norm = Math.hypot(u, v)
  if (norm < 1e-9) return { u: 0, v: 0 }
  return { u: u / norm, v: v / norm }
}

/**
 * Маркер диполя на проекции: точка в пикселях, конец вектора и длина луча.
 *
 * Наконечник стрелки посчитан **здесь, а не тегом `<marker>` SVG**: размер
 * `<marker>` задаётся один на всю проекцию, поэтому у короткого луча (слабый
 * диполь) стрелка накрывала бы весь луч и «съедала» направление, а у длинного
 * выглядела бы точкой. Длина наконечника берётся от длины луча и зажата в рамки.
 */
export type DipoleMarker = {
  /** Позиция диполя на фигуре, px */
  at: PixelPoint
  /** Конец вектора направления (вершина наконечника), px (`null` — момент вдоль нормали среза) */
  end: PixelPoint | null
  /** Конец штриха луча: наконечник начинается отсюда (не «протыкает» его) */
  shaftEnd: PixelPoint | null
  /** Вершины треугольника наконечника (вершина + два крыла), px */
  head: PixelPoint[] | null
  /** Длина луча, px */
  vectorPx: number
}

/**
 * Доля длины луча, уходящая под наконечник, и границы его длины, px.
 *
 * Наконечник **вдвое меньше** прежнего (поправка ручной проверки, 18.09.2026: 4…9 px → 2…4.5 px):
 * при плотном облаке точек крупные залитые треугольники сливались в сплошной комок, и направление
 * момента читалось хуже, чем по самому лучу. Ширина крыльев считается от длины (`half`), поэтому
 * вдвое меньшая длина даёт вдвое меньший габарит по обеим осям.
 */
export const ARROW_LENGTH_RATIO = 0.38
export const ARROW_LENGTH_MIN_PX = 2
export const ARROW_LENGTH_MAX_PX = 4.5

/**
 * Наконечник вектора: залитый треугольник на конце луча плюс укороченный штрих.
 *
 * Размер наконечника **вдвое меньше** прежнего (поправка ручной проверки, 18.09.2026: 4…9 px →
 * 2…4.5 px): при плотном облаке точек крупные треугольники сливались в сплошной комок, и уменьшение
 * габарита решило это без отказа от заливки (заливка возвращена — ручная проверка). Вершина остаётся
 * концом луча, крылья — по сторонам (порядок точек: `[вершина, левое крыло, правое крыло]`).
 *
 * `vectorPx <= 0` — направления нет (момент вдоль нормали среза): наконечника и
 * штриха тоже нет, компонент рисует точку кольцом.
 */
export function dipoleArrowHead(
  at: PixelPoint,
  end: PixelPoint,
  vectorPx: number,
): { shaftEnd: PixelPoint; head: PixelPoint[] } | null {
  if (!(vectorPx > 0)) return null
  const ux = (end.x - at.x) / vectorPx
  const uy = (end.y - at.y) / vectorPx
  const length = Math.min(
    ARROW_LENGTH_MAX_PX,
    Math.max(ARROW_LENGTH_MIN_PX, vectorPx * ARROW_LENGTH_RATIO),
    vectorPx,
  )
  const half = length * 0.34
  const baseX = end.x - ux * length
  const baseY = end.y - uy * length
  return {
    shaftEnd: { x: baseX, y: baseY },
    head: [
      end,
      { x: baseX - uy * half, y: baseY + ux * half },
      { x: baseX + uy * half, y: baseY - ux * half },
    ],
  }
}

/**
 * Маркер диполя на плоскости: позиция точки плюс вектор направления момента.
 *
 * `null` в `end` — момент направлен перпендикулярно срезу: на этой проекции
 * диполь видно «в торец», и стрелка была бы нулевой длины и читалась бы как
 * ошибка. Компонент рисует такую точку кольцом без луча.
 */
export function dipoleMarker(
  plane: ProjectionPlane,
  point: DipolePoint,
  padding = PROJECTION_PADDING,
): DipoleMarker {
  const at = projectPoint(plane, point.position, padding)
  const direction = dipoleVectorDirection(plane, point.orientation)
  const vectorPx = dipoleVectorLength(point.amplitudeNaM)
  if (direction.u === 0 && direction.v === 0) {
    return { at, end: null, shaftEnd: null, head: null, vectorPx: 0 }
  }
  const end: PixelPoint = {
    x: at.x + direction.u * vectorPx,
    // Экранная вертикаль инвертирована: +v направлен вверх, а y растёт вниз
    y: at.y - direction.v * vectorPx,
  }
  const arrow = dipoleArrowHead(at, end, vectorPx)
  return {
    at,
    end,
    shaftEnd: arrow?.shaftEnd ?? end,
    head: arrow?.head ?? null,
    vectorPx,
  }
}

/**
 * Служебная метка сервера «не определено»: `dipole_fitter._find_ba` возвращает её
 * строкой, когда поле не нашлось. Подписывать ею UI нельзя — «unknown» читалось бы
 * как название поля Бродмана.
 */
export const UNKNOWN_ATLAS_LABEL = 'unknown'

/**
 * Метка анатомии из результата: пустая строка и служебное `unknown` — это
 * **отсутствие** метки (`null`), а не измеренная величина.
 *
 * Нормализация одна на все подписи (тултипы проекций, строка анатомии кадра,
 * таблица локализации): иначе «не посчитано» выглядело бы по-разному в разных
 * местах — в одном «unknown», в другом «—».
 */
export function atlasLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed || trimmed.toLowerCase() === UNKNOWN_ATLAS_LABEL) return null
  return trimmed
}

/**
 * Анатомия точки — структура `aparc+aseg` и поле Бродмана — в нормализованном
 * виде. Величины остаются **разными** (`structure` и `area`): первая читается из
 * объёма по координате, второе — производная разметка коры, и сливать их в одну
 * строку внутри этой функции нельзя.
 */
export function atlasLabels(point: {
  structure: string | null
  brodmannArea: string | null
}): { structure: string | null; area: string | null } {
  return { structure: atlasLabel(point.structure), area: atlasLabel(point.brodmannArea) }
}

/**
 * Подпись точки для тултипа: эпоха, время, координаты, структура, амплитуда, GOF
 * и — когда кратность узла посчитана (`withOverlapCounts`) — число диполей в узле:
 * в быстром режиме несколько эпох часто выбирают один узел, и по этой подписи видно,
 * почему кольцо крупнее или залито.
 */
export function dipolePointTitle(point: DipolePoint): string {
  const [x, y, z] = [point.position.x, point.position.y, point.position.z]
  // Структура атласа и поле Бродмана — разные величины: первая читается из
  // объёма `aparc+aseg` по координате, второе — производная разметка коры.
  // Обе подписываются, иначе «где диполь» выглядело бы одним и тем же вопросом.
  // «unknown» и пустые строки — не метки, их снимает `atlasLabels`.
  const { structure, area } = atlasLabels(point)
  const anatomy = [structure, area].filter(Boolean).join(', ')
  const suffix = anatomy ? `, ${anatomy}` : ''
  const overlap =
    point.overlapCount === undefined ? '' : `, диполей в узле: ${point.overlapCount}`
  return `Эпоха ${point.epochIndex + 1}, ${(point.timeMs / 1000).toFixed(3)} с: MNI ${x.toFixed(1)} / ${y.toFixed(1)} / ${z.toFixed(1)}${suffix}, ${point.amplitudeNaM.toFixed(1)} нАм, GOF ${(point.gof * 100).toFixed(1)} %${overlap}`
}

/**
 * Подпись узла для курсорного тултипа проекции: точка под курсором плюс список
 * **всех** эпох узла (находка ручной проверки, 19.09.2026: «диполей в узле: 3»
 * с одной эпохой в подписи читалось как противоречие). Список отсортирован по
 * номеру эпохи; одиночный узел — обычная подпись точки.
 */
export function dipoleNodeTitle(point: DipolePoint, siblings: DipolePoint[]): string {
  const base = dipolePointTitle(point)
  if (siblings.length < 2) return base
  const epochs = siblings
    .map((sibling) => sibling.epochIndex + 1)
    .sort((a, b) => a - b)
    .join(', ')
  return `${base} (эпохи узла: ${epochs})`
}

/**
 * Фикстура слоя диполей — **только для проверки отрисовки** (тесты и отладка
 * компонента). В UI слой остаётся пустым (`emptyDipoleLayer`): раздел не
 * имитирует расчёт, точки появятся из результата задачи (следующий срез фазы 3).
 *
 * Точки детерминированы (mulberry32 по сиду) и лежат рядом с именованными
 * срезами, чтобы их было видно на всех трёх проекциях.
 */
export function demoDipoleLayer(seed = 42, count = 6): DipoleLayer {
  const rand = mulberry32(seed)

  const points: DipolePoint[] = []
  for (let index = 0; index < count; index++) {
    const position: MniVector = {
      x: Math.round((rand() * 60 - 30) * 10) / 10,
      y: Math.round((rand() * 70 - 45) * 10) / 10,
      z: Math.round((rand() * 60 - 10) * 10) / 10,
    }
    const amplitudeNaM = 10 + rand() * 60
    points.push({
      id: `${0}-${index}`,
      epochIndex: 0,
      timeMs: index * 20,
      position,
      orientation: { x: rand() - 0.5, y: rand() - 0.5, z: rand() - 0.5 },
      amplitudeNaM: Math.round(amplitudeNaM * 10) / 10,
      gof: Math.round((0.6 + rand() * 0.39) * 1000) / 1000,
      brodmannArea: null,
      structure: null,
    })
  }
  return { points, source: 'demo' }
}
