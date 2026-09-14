/**
 * Тесты слоя диполей (срез 3.1): пустой слой, векторы моментов и маркеры.
 *
 * Точки пока не приходят из расчёта, поэтому проверяется контракт отрисовки:
 * направление вектора в плоскости среза, зажим длины, «торец» (момент вдоль
 * нормали) и детерминированность фикстуры для тестов.
 */
import { describe, expect, it } from 'vitest'
import { PROJECTION_PADDING, PROJECTION_SIZE, projectPoint } from './mriProjections'
import {
  VECTOR_MAX_PX,
  VECTOR_MIN_PX,
  demoDipoleLayer,
  dipoleLayerStatus,
  dipoleMarker,
  dipolePointTitle,
  dipoleVectorDirection,
  dipoleVectorLength,
  emptyDipoleLayer,
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
    expect(alongNormal.at).toEqual(
      projectPoint('sagittal', POINT.position, PROJECTION_SIZE, PROJECTION_PADDING),
    )

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
