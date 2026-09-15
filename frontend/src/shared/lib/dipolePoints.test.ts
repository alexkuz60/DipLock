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
  VECTOR_MAX_PX,
  VECTOR_MIN_PX,
  demoDipoleLayer,
  dipoleLayerFromScan,
  dipoleLayerStatus,
  dipoleMarker,
  dipolePointTitle,
  dipoleVectorDirection,
  dipoleVectorLength,
  emptyDipoleLayer,
  hiddenByThreshold,
  thresholdDipoleLayer,
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
