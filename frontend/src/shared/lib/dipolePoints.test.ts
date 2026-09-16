/**
 * Тесты слоя диполей (срез 3.1, точки из результата — 3.4).
 *
 * Проверяется контракт отрисовки (направление вектора в плоскости среза, зажим
 * длины, «торец» — момент вдоль нормали, детерминированность фикстуры) и переход
 * результата задачи в слой: точки без MNI не рисуются, а порог «КД ≥» фильтрует
 * **отображение**, не меняя результат.
 */
import { describe, expect, it } from 'vitest'
import { projectPoint } from './mriProjections'
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
  VECTOR_MAX_PX,
  VECTOR_MIN_PX,
  demoDipoleLayer,
  dipoleArrowHead,
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
  thresholdDipoleLayer,
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

  it('подписывает точку для тултипа: эпоха, MNI, поле, амплитуда и GOF', () => {
    const title = dipolePointTitle(POINT)

    expect(title).toContain('Эпоха 1, 0.040 с')
    expect(title).toContain('MNI 20.0 / -10.0 / 30.0, BA17')
    expect(title).toContain('40.0 нАм')
    expect(title).toContain('GOF 92.0 %')
    expect(dipolePointTitle({ ...POINT, brodmannArea: null })).not.toContain('BA17')
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

  it('держит геометрию маркера фиксированной: кольцо Ø 10 px, штрихи 2 px — при любой силе', () => {
    // Поправка ручной проверки: кольцо не зависит ни от амплитуды, ни от масштаба
    // фигуры (компенсация масштаба — в компоненте), сила диполя читается по лучу
    expect(DIPOLE_DOT_RADIUS_PX * 2).toBe(10)
    expect(DIPOLE_DOT_STROKE_PX).toBe(2)
    expect(DIPOLE_RAY_STROKE_PX).toBe(2)
    // Хит-зона шире кольца: иначе в маркер диаметром 10 px мышью не попасть
    expect(DOT_HIT_RADIUS_PX).toBeGreaterThan(DIPOLE_DOT_RADIUS_PX)
  })

  it('держит маркер кадра отличимым от выделения и не спорит с размером кольца', () => {
    // Гало кадра шире кольца позиции: размер кольца не меняем (правило «все
    // позиции — одинаковые кольца»), а «сейчас» отмечаем вторым кольцом
    expect(DIPOLE_FRAME_HALO_RADIUS_PX).toBeGreaterThan(DIPOLE_DOT_RADIUS_PX)
    expect(DIPOLE_FRAME_HALO_STROKE_PX).toBe(2)
    // Приглушение облака: точки видны, но не спорят с маркером за внимание
    expect(FRAME_DIM_OPACITY).toBeGreaterThan(0)
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
