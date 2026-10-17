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
import { bandVectorPx } from './bandColors'
import type { DipoleScanResult } from '@/shared/api/types'

/**
 * Тег полосы пакета (С1): диполь точки «эпоха × полоса» несёт свою полосу —
 * цвет (гамма red→violet) и масштаб длины вектора читаются из неё
 * (`shared/lib/bandColors.ts`). У точек одиночного расчёта тега нет: они
 * рисуются прежними токенами темы и амплитудной длиной луча.
 */
export type DipoleBandTag = {
  /** Стабильный ключ полосы (`alpha`, `custom:8-12`, …) — адрес в пакете */
  key: string
  /** Подпись полосы для UI (та же, что в чипах/таблице) */
  label: string
  /** Границы полосы, Гц */
  bandHz: number[]
  /** Цвет полосы (`bandColor`) — точки, векторы и шлейф этой полосы */
  color: string
}

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
  /** Расстояние до ближайшей структуры, мм (шаг 1.4); `null` — координат/атласа нет */
  structureDistanceMm: number | null
  /** Расстояние до ближайшего узла поля Бродмана, мм (шаг 1.4) */
  areaDistanceMm: number | null
  /** Признак «вне мозга» (`brainmask`, шаг 1.4): `null` — маска недоступна */
  outsideBrain: boolean | null
  /**
   * Сколько диполей стоит в этом узле сетки (поправка ручной проверки, 18.09.2026).
   *
   * Быстрый расчёт ищет позицию перебором узлов, поэтому несколько эпох часто
   * выбирают один и тот же узел, и их кольца рисуются ровно друг на друге. Число
   * заполняет `withOverlapCounts` по **видимому** слою (после порогов отображения),
   * и по нему
   * считается размер кольца и заливка (`dipoleDotVisual`); `1`/`undefined` — узел
   * занят одним диполем.
   */
  overlapCount?: number
  /**
   * Полоса пакета (С1): цвет точки/вектора и масштаб длины луча. `null`/нет —
   * одиночный расчёт: прежние токены темы и длина по амплитуде.
   */
  band?: DipoleBandTag | null
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
 *
 * `band` — тег полосы пакета (С1): точки набора получают его целиком, и слои
 * рисуют их в цвете полосы с полосной длиной вектора. Без тега (одиночный
 * расчёт) отрисовка прежняя.
 */
export function dipoleLayerFromScan(result: DipoleScanResult, band?: DipoleBandTag | null): DipoleLayer {
  const points: DipolePoint[] = []
  for (const point of result.points ?? []) {
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
      brodmannArea: point.brodmann_area ?? null,
      structure: point.anatomical_structure ?? null,
      structureDistanceMm: point.structure_distance_mm ?? null,
      areaDistanceMm: point.brodmann_distance_mm ?? null,
      outsideBrain: point.outside_brain ?? null,
      band: band ?? null,
    })
  }
  return { points, source: 'result' }
}

/**
 * Пороги отображения диполей на проекциях (оба — параметры **отображения**).
 *
 * Основной — `minGofPercent` (отбор по GOF, %): безразмерная доля объяснённой
 * дисперсии. Дополнительный — `minAmplitudeNaM` (момент диполя, нА·м):
 * опционная фильтрация по абсолютной величине. Настоящий «КД» (критерий
 * годности, `kd_passed`) — составной вердикт анализа С0, он живёт в
 * `dipole_points`/паспорте и к этим полям отношения не имеет.
 */
export type DisplayThresholds = {
  /** Минимальный GOF, % (0 — порог выключен) */
  minGofPercent: number
  /** Минимальный момент диполя, нА·м (0 — порог выключен) */
  minAmplitudeNaM: number
}

/** Оба порога выключены: ничего не скрывать. */
export const NO_THRESHOLDS: DisplayThresholds = { minGofPercent: 0, minAmplitudeNaM: 0 }

/**
 * Точка проходит пороги отображения (оба условия «И»; нулевой порог не фильтрует).
 *
 * GOF в точке хранится 0…1, порог задаётся в процентах: сравнение идёт через
 * долю (`minGofPercent / 100`), чтобы float-сравнение не спотыкалось на
 * `0.6 * 100 = 60.000…1`.
 */
export function pointPassesThresholds(point: DipolePoint, thresholds: DisplayThresholds): boolean {
  return (
    point.gof >= thresholds.minGofPercent / 100
    && point.amplitudeNaM >= thresholds.minAmplitudeNaM
  )
}

/** Активны ли пороги (хотя бы один больше нуля). */
export function thresholdsActive(thresholds: DisplayThresholds): boolean {
  return thresholds.minGofPercent > 0 || thresholds.minAmplitudeNaM > 0
}

/**
 * Подпись активных порогов одной строкой («GOF ≥ 60 % · момент ≥ 200 нАм») —
 * пилюли и счётчики скрытых не должны выдумывать названия порогов по-своему.
 * Неактивные пороги в подпись не попадают; оба выключены — пустая строка.
 */
export function thresholdsLabel(thresholds: DisplayThresholds): string {
  const parts: string[] = []
  if (thresholds.minGofPercent > 0) parts.push(`GOF ≥ ${thresholds.minGofPercent} %`)
  if (thresholds.minAmplitudeNaM > 0) parts.push(`момент ≥ ${thresholds.minAmplitudeNaM} нАм`)
  return parts.join(' · ')
}

/**
 * Слой с порогами отображения: слабые по GOF и/или моменту диполи скрываются.
 *
 * Пороги — параметры **отображения**: они не меняют результат задачи (точки в
 * слое остаются теми же), поэтому счётчик скрытых точек возвращается отдельно,
 * и панель объясняет, что часть диполей не рисуется из-за порога.
 */
export function thresholdDipoleLayer(layer: DipoleLayer, thresholds: DisplayThresholds): DipoleLayer {
  if (!thresholdsActive(thresholds)) return layer
  return {
    points: layer.points.filter((point) => pointPassesThresholds(point, thresholds)),
    source: layer.source,
  }
}

/** Сколько точек скрыто порогами (для пояснения в панели). */
export function hiddenByThreshold(layer: DipoleLayer, thresholds: DisplayThresholds): number {
  if (!thresholdsActive(thresholds)) return 0
  return layer.points.filter((point) => !pointPassesThresholds(point, thresholds)).length
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
 * Ключ узла для кратности: позиция **внутри своей полосы** (С1). Точки разных
 * полос стоят в одном узле сетки независимо (это разные измерения одного
 * места), и их кольца не должны сливаться в одно «мульти-полосное» число.
 */
function nodeKey(point: DipolePoint): string {
  return `${point.band?.key ?? ''}@${positionKey(point.position)}`
}

/**
 * Проставить точкам число диполей в их узле (`overlapCount`).
 *
 * Считается по **видимому** слою (после порогов отображения) и **внутри полосы**
 * точки (см. `nodeKey`): кольцо не должно обещать диполи, скрытые порогом, и
 * сливать узлы разных полос пакета. Функция чистая: координаты, порядок и сами
 * точки не меняются, добавляется только производное число; узел с одним диполем
 * остаётся с `1`. Если совпадений нет, возвращается тот же объект слоя.
 */
export function withOverlapCounts(layer: DipoleLayer): DipoleLayer {
  if (layer.points.length < 2) return layer
  const counts = new Map<string, number>()
  for (const point of layer.points) {
    const key = nodeKey(point)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return {
    ...layer,
    points: layer.points.map((point) => ({
      ...point,
      overlapCount: counts.get(nodeKey(point)) ?? 1,
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

/** Длина вектора диполя в пикселях: полосный масштаб × амплитуда, с зажимом в разумные рамки. */
export function dipoleVectorLength(
  amplitudeNaM: number,
  bandHz: readonly number[] | null = null,
): number {
  const raw = Math.abs(amplitudeNaM) * VECTOR_PX_PER_NA_M
  // Полоса пакета (С1) задаёт масштаб/максимум (дельта — длиннее всех, высокая
  // гамма — короче всех, `bandVectorPx`), амплитуда — долю этого масштаба
  // (гибрид 17.10.2026: в облаке слабый диполь короче своего полосного
  // максимума). Нормировка амплитуды — прежняя линейная шкала одиночного
  // расчёта (`VECTOR_PX_PER_NA_M` от `VECTOR_MAX_PX`), чтобы один и тот же
  // момент выглядел одинаково в обоих режимах.
  if (bandHz && bandHz.length >= 2) {
    const scale = bandVectorPx(bandHz)
    return Math.min(scale, Math.max(VECTOR_MIN_PX, (raw / VECTOR_MAX_PX) * scale))
  }
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
 * Наконечник стрелы: **один размер для всех полос** — залитый треугольник
 * `DIPOLE_ARROW_PX` (~4 px, поправка владельца 17.10.2026).
 *
 * Раньше длина наконечника росла от длины луча (0.38 × длина, зажим 2…4.5 px):
 * на длинных дельта-векторах пакета стрелка смотрелась «шипом», а на коротких
 * гамма-векторах съедала весь луч. Теперь габарит стрелы один, а полосу несёт
 * её **цвет** (`DipoleRayVisual`/`point.band.color`); длина луча остаётся
 * полосной. Ширина крыльев считается от длины (`half = 0.34 × length`).
 */
export const DIPOLE_ARROW_PX = 4

/**
 * Наконечник вектора: залитый треугольник на конце луча плюс укороченный штрих.
 *
 * Размер **фиксирован** (`DIPOLE_ARROW_PX`, ~4 px — один для всех полос,
 * поправка владельца 17.10.2026): габарит стрелы не зависит от длины луча, а
 * полосу несёт её цвет. Вершина остаётся концом луча, крылья — по сторонам
 * (порядок точек: `[вершина, левое крыло, правое крыло]`). Длиной стрелы
 * укорачивается штрих (`shaftEnd`), поэтому луч не «протыкает» свой наконечник.
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
  const length = Math.min(DIPOLE_ARROW_PX, vectorPx)
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
 * Длина луча — `dipoleVectorLength` (полосный масштаб × амплитуда), либо явный
 * `vectorLengthPx` (кадр анимации: фиксированная полосная длина — поток читается
 * ровнее, когда его векторы не «дышат» по амплитуде). Наконечник стрелы — один
 * размер для всех полос (`DIPOLE_ARROW_PX`).
 *
 * `null` в `end` — момент направлен перпендикулярно срезу: на этой проекции
 * диполь видно «в торец», и стрелка была бы нулевой длины и читалась бы как
 * ошибка. Компонент рисует такую точку кольцом без луча.
 */
export function dipoleMarker(
  plane: ProjectionPlane,
  point: DipolePoint,
  padding = PROJECTION_PADDING,
  vectorLengthPx?: number,
): DipoleMarker {
  const at = projectPoint(plane, point.position, padding)
  const direction = dipoleVectorDirection(plane, point.orientation)
  const vectorPx =
    vectorLengthPx ?? dipoleVectorLength(point.amplitudeNaM, point.band?.bandHz ?? null)
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
  structureDistanceMm?: number | null
  areaDistanceMm?: number | null
  outsideBrain?: boolean | null
}): PointAttribution {
  return {
    structure: atlasLabel(point.structure),
    area: atlasLabel(point.brodmannArea),
    structureDistanceMm: point.structureDistanceMm ?? null,
    areaDistanceMm: point.areaDistanceMm ?? null,
    outsideBrain: point.outsideBrain ?? null,
  }
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
  // Анатомия одной строкой с расстояниями и «вне мозга» (шаг 1.4).
  const anatomy = attributionText(atlasLabels(point), '')
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
      structureDistanceMm: null,
      areaDistanceMm: null,
      outsideBrain: null,
    })
  }
  return { points, source: 'demo' }
}


/** Итог атрибуции точки (шаг 1.4): метки (уже `atlasLabel`) + расстояния + «вне мозга». */
export type PointAttribution = {
  structure: string | null
  area: string | null
  structureDistanceMm: number | null
  areaDistanceMm: number | null
  outsideBrain: boolean | null
}

/**
 * Порог «точного попадания» в ячейку атласа, мм: до него расстояние не
 * подписывается («~0 мм» — это не измерение, а сетка 1 мм).
 */
export const ATTRIBUTION_EXACT_MM = 1

/**
 * Метка с расстоянием (шаг 1.4): «X» при точном попадании (≤ `ATTRIBUTION_EXACT_MM`)
 * и «около X ~N мм» дальше — N до целого (сетка атласа 1 мм). Потолка расстояния
 * нет (замер 23.09.2026, `docs/history.md`): чем дальше узел, тем честнее подпись.
 */
export function labelWithDistance(name: string, distanceMm: number | null): string {
  if (distanceMm === null || !Number.isFinite(distanceMm) || distanceMm <= ATTRIBUTION_EXACT_MM) {
    return name
  }
  return `около ${name} ~${Math.round(distanceMm)} мм`
}

/**
 * Подпись точки вне мозга (шаг 1.4): «вне мозга (~N мм до X)» вместо выдуманной
 * атрибуции (метка ближайшего узла у точки за пределами мозга — не измерение).
 * Без структуры/расстояния форма короткая: «вне мозга» / «вне мозга (до X)».
 */
export function outsideBrainText(
  structure: string | null,
  structureDistanceMm: number | null,
): string {
  if (!structure) return 'вне мозга'
  if (structureDistanceMm === null || !Number.isFinite(structureDistanceMm)) {
    return `вне мозга (до ${structure})`
  }
  return `вне мозга (~${Math.round(structureDistanceMm)} мм до ${structure})`
}

/**
 * Анатомия точки одной строкой (тултипы проекций, строка кадра): «около X ~N мм,
 * …» или «вне мозга (~N мм до X)». `fallback` — полное отсутствие анатомии
 * («анатомия не определена» в строке кадра, пусто в тултипе).
 */
export function attributionText(attribution: PointAttribution, fallback: string): string {
  if (attribution.outsideBrain) {
    return outsideBrainText(attribution.structure, attribution.structureDistanceMm)
  }
  const parts = [
    attribution.structure
      ? labelWithDistance(attribution.structure, attribution.structureDistanceMm)
      : null,
    attribution.area ? labelWithDistance(attribution.area, attribution.areaDistanceMm) : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(', ') : fallback
}
