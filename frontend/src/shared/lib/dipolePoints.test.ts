/**
 * Тесты слоя диполей (срез 3.1, точки из результата — 3.4).
 *
 * Проверяется контракт отрисовки (направление вектора в плоскости среза, зажим
 * длины, «торец» — момент вдоль нормали, детерминированность фикстуры) и переход
 * результата задачи в слой: точки без MNI не рисуются, а порог «КД ≥» фильтрует
 * **отображение**, не меняя результат.
 */
import { describe, expect, it } from 'vitest'
import { PROJECTION_SCALE, projectPoint } from './mriProjections'
import { dipoleScanResultFixture } from '@/test/fixtures'
import {
  ARROW_LENGTH_MAX_PX,
  DIPOLE_DOT_RADIUS_PX,
  DIPOLE_DOT_STROKE_PX,
  DIPOLE_FRAME_HALO_RADIUS_PX,
  DIPOLE_FRAME_HALO_STROKE_PX,
  DIPOLE_RAY_STROKE_PX,
  DOT_HIT_RADIUS_PX,
  FORCE_FULL_NAM,
  FRAME_DIM_OPACITY,
  TRAIL_STROKE_PX,
  MARKER_OPACITY_MIN,
  DIPOLE_DOT_GROWTH_PX,
  OVERLAP_FILL_MIN_OPACITY,
  VECTOR_MAX_PX,
  VECTOR_MIN_PX,
  demoDipoleLayer,
  dipoleArrowHead,
  dipoleDotVisual,
  dipoleForceFraction,
  dipoleLayerFromScan,
  dipoleLayerStatus,
  dipoleMarker,
  dipolePointTitle,
  dipoleRayVisual,
  dipoleVectorDirection,
  dipoleVectorLength,
  emptyDipoleLayer,
  hiddenByThreshold,
  atlasLabel,
  atlasLabels,
  thresholdDipoleLayer,
  withOverlapCounts,
  dipoleNodeSiblings,
  dipoleNodeTitle,
  UNKNOWN_ATLAS_LABEL,
  type DipoleLayer,
  type DipoleMarker,
  type DipolePoint,
} from './dipolePoints'

const POINT: DipolePoint = {
  id: '0-1',
  epochIndex: 0,
  timeMs: 40,
  position: { x: 20, y: -10, z: 30 },
  orientation: { x: 0.6, y: 0.8, z: 0 },
  amplitudeNaM: 40,
  gof: 0.92,
  brodmannArea: 'BA17',
  structure: 'таламус (слева)',
}

describe('слой диполей', () => {
  it('по умолчанию пуст и честно об этом сообщает', () => {
    const layer = emptyDipoleLayer()

    expect(layer).toEqual({ points: [], source: 'result' })
    expect(dipoleLayerStatus(layer)).toBe('Расчёт диполей не подключён — слой пуст')
    expect(dipoleLayerStatus(demoDipoleLayer(1, 3))).toBe('Точек диполей: 3')
  })

  it('берёт в вектор только компоненты, лежащие в плоскости среза', () => {
    // Аксиальная: видимы x и y (ось x на экране развёрнута)
    const axial = dipoleVectorDirection('axial', { x: 0.6, y: 0.8, z: 0 })
    expect(axial.u).toBeCloseTo(-0.6, 6)
    expect(axial.v).toBeCloseTo(0.8, 6)

    // Сагиттальная: видимы y и z, ось x — нормаль среза
    const sagittal = dipoleVectorDirection('sagittal', { x: 5, y: 0.8, z: 0.6 })
    expect(sagittal.v).toBeCloseTo(0.6, 6)
    expect(Math.hypot(sagittal.u, sagittal.v)).toBeCloseTo(1, 6)
  })

  it('не рисует луч, если момент направлен вдоль нормали среза', () => {
    const alongNormal = dipoleMarker('sagittal', { ...POINT, orientation: { x: 1, y: 0, z: 0 } })
    expect(alongNormal.end).toBeNull()
    expect(alongNormal.vectorPx).toBe(0)
    expect(alongNormal.at).toEqual(projectPoint('sagittal', POINT.position))

    const inPlane = dipoleMarker('sagittal', POINT)
    expect(inPlane.end).not.toBeNull()
    expect(inPlane.vectorPx).toBeGreaterThanOrEqual(VECTOR_MIN_PX)
  })

  it('зажимает длину вектора в разумные рамки', () => {
    expect(dipoleVectorLength(0)).toBe(VECTOR_MIN_PX)
    expect(dipoleVectorLength(1000)).toBe(VECTOR_MAX_PX)
    expect(dipoleVectorLength(20)).toBeGreaterThan(VECTOR_MIN_PX)
  })

  it('подписывает точку для тултипа: эпоха, MNI, структура, поле, амплитуда и GOF', () => {
    const title = dipolePointTitle(POINT)

    expect(title).toContain('Эпоха 1, 0.040 с')
    expect(title).toContain('MNI 20.0 / -10.0 / 30.0, таламус (слева), BA17')
    expect(title).toContain('40.0 нАм')
    expect(title).toContain('GOF 92.0 %')
    expect(dipolePointTitle({ ...POINT, brodmannArea: null })).not.toContain('BA17')
    // Без анатомии подпись не «дорисовывает» структуру: нет данных — нет слов
    const anonymous = dipolePointTitle({ ...POINT, structure: null, brodmannArea: null })
    expect(anonymous).toContain('MNI 20.0 / -10.0 / 30.0, 40.0 нАм')
  })

  it('снимает служебное «unknown» и пустые метки: «не определено» — это отсутствие данных', () => {
    // Сервер отдаёт поле строкой «unknown», когда поиск по ближайшему центру метки
    // не удался (`dipole_fitter._find_ba`): это не название поля, а «не посчитано»
    expect(atlasLabel(UNKNOWN_ATLAS_LABEL)).toBeNull()
    expect(atlasLabel(' unknown ')).toBeNull()
    expect(atlasLabel('')).toBeNull()
    expect(atlasLabel('   ')).toBeNull()
    expect(atlasLabel(null)).toBeNull()
    expect(atlasLabel(undefined)).toBeNull()
    expect(atlasLabel(' BA17-lh ')).toBe('BA17-lh')

    expect(atlasLabels({ structure: 'таламус (слева)', brodmannArea: 'unknown' })).toEqual({
      structure: 'таламус (слева)',
      area: null,
    })

    // В подписи точки «unknown» не появляется: остаются координаты, амплитуда и GOF
    const title = dipolePointTitle({ ...POINT, structure: 'unknown', brodmannArea: 'unknown' })
    expect(title).not.toContain('unknown')
    expect(title).toContain('MNI 20.0 / -10.0 / 30.0, 40.0 нАм')
  })

  it('даёт детерминированную фикстуру для отрисовки', () => {
    const layer = demoDipoleLayer(9, 4)

    expect(layer).toEqual(demoDipoleLayer(9, 4))
    expect(layer.points).toHaveLength(4)
    expect(layer.source).toBe('demo')
    expect(layer.points.map((point) => point.id)).toEqual(['0-0', '0-1', '0-2', '0-3'])
    expect(layer.points.every((point) => point.gof > 0.59 && point.gof <= 1)).toBe(true)
  })
})

/**
 * Кольцо позиции, оформление луча и наконечник (срез 3.5, поправка ручной
 * проверки): кольцо одно на всех диполей, сила видна по лучу, а стрелка не
 * «съедает» короткий луч.
 */
describe('отрисовка маркера диполя (срез 3.5)', () => {
  it('зажимает силу сверху: одиночный выброс не растягивает шкалу', () => {
    expect(dipoleForceFraction(0)).toBe(0)
    expect(dipoleForceFraction(-50)).toBe(0.5)
    expect(dipoleForceFraction(FORCE_FULL_NAM)).toBe(1)
    // Выше «полной» силы маркер не растёт: иначе все прочие диполи выглядели бы
    // одинаково мелкими, и по картинке нельзя было бы сравнить их силу
    expect(dipoleForceFraction(FORCE_FULL_NAM * 10)).toBe(1)
    expect(dipoleForceFraction(Number.NaN)).toBe(0)
  })

  it('держит геометрию маркера фиксированной: кольцо Ø 6 px, штрихи 2 px — при любой силе', () => {
    // Поправка ручной проверки: кольцо не зависит ни от амплитуды, ни от масштаба
    // фигуры (компенсация масштаба — в компоненте), сила диполя читается по лучу
    expect(DIPOLE_DOT_RADIUS_PX * 2).toBe(6)
    expect(DIPOLE_DOT_STROKE_PX).toBe(2)
    expect(DIPOLE_RAY_STROKE_PX).toBe(2)
    // Хит-зона шире кольца: иначе в маркер диаметром 6 px мышью не попасть
    expect(DOT_HIT_RADIUS_PX).toBeGreaterThan(DIPOLE_DOT_RADIUS_PX)
  })

  it('держит маркер кадра отличимым от выделения и не спорит с размером кольца', () => {
    // Гало кадра шире кольца позиции: размер кольца не меняем (правило «все
    // позиции — одинаковые кольца»), а «сейчас» отмечаем вторым кольцом
    expect(DIPOLE_FRAME_HALO_RADIUS_PX).toBeGreaterThan(DIPOLE_DOT_RADIUS_PX)
    expect(DIPOLE_FRAME_HALO_STROKE_PX).toBe(2)
    // Приглушение облака: точки видны, но не спорят с маркером за внимание.
    // 0.3 = 0.2 × 1.5 — поправка ручной проверки (облако под анимацией читается)
    expect(FRAME_DIM_OPACITY).toBeCloseTo(0.2 * 1.5, 5)
    expect(FRAME_DIM_OPACITY).toBeLessThan(MARKER_OPACITY_MIN)
    // Шлейф — история того же диполя: одна толщина с лучом момента, а не своя
    expect(TRAIL_STROKE_PX).toBe(DIPOLE_RAY_STROKE_PX)
  })

  it('плотнит луч по силе: слабый — бледный, сильный — плотный; толщина у всех одна', () => {
    const weak = dipoleRayVisual(0)
    const middle = dipoleRayVisual(FORCE_FULL_NAM / 2)
    const strong = dipoleRayVisual(FORCE_FULL_NAM * 2)

    // Нулевая амплитуда — нижняя граница шкалы: луч ещё виден, но самый бледный
    expect(weak.opacity).toBeCloseTo(MARKER_OPACITY_MIN, 6)
    expect(strong.opacity).toBeCloseTo(1, 6)
    // Насыщение: выше «полной» силы плотность не растёт (см. dipoleForceFraction)
    expect(strong).toEqual(dipoleRayVisual(FORCE_FULL_NAM))
    expect(middle.opacity).toBeGreaterThan(weak.opacity)
    expect(middle.opacity).toBeLessThan(strong.opacity)
    // Толщина в оформлении луча не участвует: она одна на все лучи (см. константу)
    expect(strong).not.toHaveProperty('vectorStroke')
  })

  it('строит наконечник от длины луча, а не «одним размером на проекцию»', () => {
    const short = dipoleMarker('axial', {
      ...POINT,
      amplitudeNaM: 20,
      orientation: { x: 1, y: 0, z: 0 },
    })
    const long = dipoleMarker('axial', {
      ...POINT,
      amplitudeNaM: 1000,
      orientation: { x: 1, y: 0, z: 0 },
    })

    expect(short.head).not.toBeNull()
    expect(long.head).not.toBeNull()
    /**
     * Длина наконечника по оси луча: расстояние от вершины до середины основания
     * (крылья отстоят в стороны, и hypotenuse дал бы «длину» больше зажатой).
     */
    const axisLength = (head: NonNullable<DipoleMarker['head']>) =>
      Math.hypot(head[0].x - (head[1].x + head[2].x) / 2, head[0].y - (head[1].y + head[2].y) / 2)

    // Вершина наконечника — конец луча, основание — ближе к точке
    expect(short.head?.[0]).toEqual(short.end)
    expect(axisLength(short.head!)).toBeLessThanOrEqual(short.vectorPx)
    // Наконечник зажат: на длинном луче он не растёт вместе с ним бесконечно
    expect(axisLength(long.head!)).toBeLessThanOrEqual(ARROW_LENGTH_MAX_PX + 1e-9)
    expect(axisLength(long.head!)).toBeGreaterThan(axisLength(short.head!))
    // Штрих луча короче луча: наконечник стоит на его конце, а не «проткнут» им
    expect(short.shaftEnd).not.toEqual(short.end)
    const toAt = (point: { x: number; y: number }) =>
      Math.hypot(point.x - short.at.x, point.y - short.at.y)
    expect(toAt(short.shaftEnd!)).toBeLessThan(short.vectorPx)
  })

  it('не строит наконечник без направления: момент вдоль нормали среза', () => {
    const alongNormal = dipoleMarker('sagittal', { ...POINT, orientation: { x: 1, y: 0, z: 0 } })

    expect(alongNormal.end).toBeNull()
    expect(alongNormal.head).toBeNull()
    expect(alongNormal.shaftEnd).toBeNull()
    expect(dipoleArrowHead({ x: 0, y: 0 }, { x: 5, y: 0 }, 0)).toBeNull()
  })
})

describe('результат расчёта в слой проекций (срез 3.4)', () => {
  it('переносит точки MNI, а точки без MNI в слой не попадают', () => {
    const layer = dipoleLayerFromScan(dipoleScanResultFixture())

    // В фикстуре четыре точки, одна из них без MNI (fsaverage недоступен)
    expect(layer.source).toBe('result')
    expect(layer.points).toHaveLength(3)
    expect(layer.points[0].position).toEqual({ x: 12, y: -34.5, z: 18 })
    expect(layer.points[0].amplitudeNaM).toBe(60)
    expect(layer.points[0].gof).toBe(0.91)
    expect(layer.points[0].orientation).toEqual({ x: 0, y: 1, z: 0 })
    expect(layer.points[0].brodmannArea).toBe('BA17-lh')
  })

  it('строит маркер проекции из точки результата (позиция + вектор)', () => {
    const layer = dipoleLayerFromScan(dipoleScanResultFixture())
    const marker = dipoleMarker('axial', layer.points[0])

    // Момент вдоль y — в плоскости среза, значит луч есть
    expect(marker.end).not.toBeNull()
    expect(dipolePointTitle(layer.points[0])).toContain('60.0 нАм')
  })

  it('порог «КД ≥» фильтрует слой, но не выдумывает «ноль»', () => {
    const layer = dipoleLayerFromScan(dipoleScanResultFixture())

    const filtered = thresholdDipoleLayer(layer, 60)
    expect(filtered.points.map((point) => point.amplitudeNaM)).toEqual([60, 90])
    expect(hiddenByThreshold(layer, 60)).toBe(1)

    // Нулевой порог ничего не скрывает и возвращает тот же объект слоя
    expect(thresholdDipoleLayer(layer, 0)).toBe(layer)
    expect(hiddenByThreshold(layer, 0)).toBe(0)
  })
})

/**
 * Кратность узла в отрисовке (поправка ручной проверки, 18.09.2026).
 *
 * Быстрый расчёт ищет позицию перебором узлов сетки, поэтому несколько эпох часто
 * выбирают один узел — раньше их кольца ложились друг на друга, и «в узле три диполя»
 * выглядело как один. Теперь размер кольца читает кратность узла (Ø 6 + 2·(n − 1) px)
 * до предела `2 · grid_mm` (центр соседнего узла), а дальше кратность показывает
 * заливка. Координаты, векторы и анимация не меняются — это проверяется отдельно.
 */
describe('кратность узла в отрисовке (поправка 18.09.2026)', () => {
  const GRID_MM = 5
  /** Предел диаметра для этого шага: 2 · gridMm · PROJECTION_SCALE, единиц фигуры. */
  const LIMIT_UNITS = 2 * GRID_MM * PROJECTION_SCALE

  /** Слой из трёх точек: две выбрали один узел сетки, третья — свой. */
  function overlappedLayer(): DipoleLayer {
    return {
      source: 'result',
      points: [
        { ...POINT, id: '0-40' },
        { ...POINT, id: '1-140' },
        { ...POINT, id: '2-60', position: { x: 60, y: 10, z: -20 } },
      ],
    }
  }

  it('проставляет число диполей в узле и не меняет сами точки', () => {
    const layer = withOverlapCounts(overlappedLayer())

    expect(layer.points.map((point) => point.overlapCount)).toEqual([2, 2, 1])
    // Порядок и координаты — из результата: кратность только добавлена
    expect(layer.points.map((point) => point.id)).toEqual(['0-40', '1-140', '2-60'])
    expect(layer.points[0].position).toEqual(POINT.position)
  })

  it('одну точку не трогает: считать нечего', () => {
    const single: DipoleLayer = { source: 'result', points: [{ ...POINT, id: 'a' }] }
    expect(withOverlapCounts(single)).toBe(single)
  })

  it('растит диаметр кольца на 2 px за каждый диполь в узле', () => {
    // Масштаб 1:1 (в jsdom нет раскладки): единицы фигуры совпадают с пикселями экрана
    expect(dipoleDotVisual(1, GRID_MM, 1)).toMatchObject({
      radiusUnits: DIPOLE_DOT_RADIUS_PX,
      fillOpacity: 0,
      capped: false,
    })
    const pair = dipoleDotVisual(2, GRID_MM, 1)
    const triple = dipoleDotVisual(3, GRID_MM, 1)
    expect(pair.radiusUnits).toBe(DIPOLE_DOT_RADIUS_PX + DIPOLE_DOT_GROWTH_PX / 2)
    expect(triple.radiusUnits).toBe(DIPOLE_DOT_RADIUS_PX + DIPOLE_DOT_GROWTH_PX)
    expect(triple.capped).toBe(false)
    expect(triple.fillOpacity).toBe(0)
  })

  it('держит экранный размер при другом масштабе фигуры', () => {
    // Фигура растянута вдвое: те же пиксели экрана — это вдвое меньше единиц фигуры
    const pair = dipoleDotVisual(2, 0, 2)
    expect(pair.radiusUnits).toBe(2)
    // В экранных пикселях радиус тот же: 2 единицы × 2 = 4 px (Ø 8 px = 6 + 2)
    expect(pair.radiusUnits * 2).toBe(DIPOLE_DOT_RADIUS_PX + DIPOLE_DOT_GROWTH_PX / 2)
    expect(dipoleDotVisual(3, 0, 2).radiusUnits).toBe(2.5)
  })

  it('не растёт шире 2 · grid_mm: дальше кратность читается заливкой', () => {
    const capped = dipoleDotVisual(6, GRID_MM, 1)

    expect(capped.capped).toBe(true)
    expect(capped.radiusUnits).toBe(LIMIT_UNITS / 2)
    expect(capped.fillOpacity).toBeGreaterThanOrEqual(OVERLAP_FILL_MIN_OPACITY)

    const more = dipoleDotVisual(11, GRID_MM, 1)
    expect(more.radiusUnits).toBe(LIMIT_UNITS / 2)
    expect(more.fillOpacity).toBeGreaterThan(capped.fillOpacity)
    expect(more.fillOpacity).toBeLessThanOrEqual(1)
  })

  it('без шага сетки предела нет: кольцо растёт по кратности', () => {
    const wide = dipoleDotVisual(12, 0, 1)

    expect(wide.capped).toBe(false)
    expect(wide.fillOpacity).toBe(0)
    expect(wide.radiusUnits).toBe(DIPOLE_DOT_RADIUS_PX + (11 * DIPOLE_DOT_GROWTH_PX) / 2)
  })

  it('не подменяет координаты: маркер не зависит от кратности', () => {
    const [first, second] = withOverlapCounts(overlappedLayer()).points

    expect(dipoleMarker('axial', first).at).toEqual(projectPoint('axial', first.position))
    // Точки одного узла стоят в одной точке: кратность видна кольцом, а не сдвигом
    expect(dipoleMarker('axial', second).at).toEqual(dipoleMarker('axial', first).at)
  })

  it('называет число диполей в тултипе, когда кратность посчитана', () => {
    const [first] = withOverlapCounts(overlappedLayer()).points

    expect(dipolePointTitle(first)).toContain('диполей в узле: 2')
    // Без кратности подпись не выдумывает число
    expect(dipolePointTitle(POINT)).not.toContain('диполей в узле')
  })
})

describe('курсорный тултип узла (находка ручной проверки, 19.09.2026)', () => {
  const at = (id: string, epochIndex: number): DipolePoint => ({
    ...POINT,
    id,
    epochIndex,
    overlapCount: 2,
  })

  it('dipoleNodeSiblings группирует точки одного узла, включая саму точку', () => {
    const a1 = at('a1', 2)
    const a2 = at('a2', 4)
    const other: DipolePoint = { ...at('b', 6), position: { x: 2, y: 0, z: 0 }, overlapCount: 1 }

    expect(dipoleNodeSiblings([a1, a2, other], a2).map((point) => point.id)).toEqual([
      'a1',
      'a2',
    ])
    expect(dipoleNodeSiblings([a1, a2, other], other).map((point) => point.id)).toEqual(['b'])
    expect(dipoleNodeSiblings([], a1)).toEqual([])
  })

  it('dipoleNodeTitle перечисляет все эпохи узла по возрастанию', () => {
    // Список сортируется: порядок точек в слое (порядок расчёта) — не порядок эпох
    const a1 = at('a1', 4)
    const a2 = at('a2', 2)

    const title = dipoleNodeTitle(a1, [a1, a2])
    expect(title).toContain('диполей в узле: 2')
    expect(title).toContain('эпохи узла: 3, 5')

    // Одиночный узел — обычная подпись точки без списка
    expect(dipoleNodeTitle(a1, [a1])).toBe(dipolePointTitle(a1))
  })
})
