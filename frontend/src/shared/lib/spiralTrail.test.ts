/**
 * Тесты математики затухающего шлейфа спиральных витков (срез 3.11).
 *
 * Главное обещание слоя: шлейф кончика луча `pos(t) + L·Q(t)` вдоль slerp-дуги
 * (**отображение интерполяции**, не измерение) показывает только **завершённые**
 * витки не позже текущей эпохи, гаснет с возрастом (окно — как у шлейфа кадра),
 * а знак поворота — «вид на экране проекции» (в 3D — относительно вертикальной
 * оси). Фолбэки «нет вращения» не должны выдумывать направление.
 */
import { describe, expect, it } from 'vitest'
import {
  SPIRAL_MAX_ARCS,
  SPIRAL_SAMPLES_PER_ARC,
  arcSense3d,
  arcSenseOnPlane,
  spiralTipLengthPx,
  spiralTipsMm,
  spiralTipsPx,
  spiralTrailArcs,
} from './spiralTrail'
import {
  dipoleVectorDirection,
  dipoleVectorLength,
  type DisplayThresholds,
  type DipolePoint,
} from './dipolePoints'
import { PROJECTION_SCALE, projectPoint } from './mriProjections'
import { TRAIL_ALPHA_HEAD, TRAIL_WINDOW_MS } from './playback'

/** Точка эпохи с предсказуемыми координатами (по образцу `playback.test.ts`). */
function point(epochIndex: number, overrides: Partial<DipolePoint> = {}): DipolePoint {
  return {
    id: `${epochIndex}-100`,
    epochIndex,
    timeMs: 100,
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 1, y: 0, z: 0 },
    amplitudeNaM: 10,
    gof: 0.9,
    brodmannArea: 'BA17-lh',
    structure: 'таламус (слева)',
    structureDistanceMm: 0.4,
    areaDistanceMm: 0.6,
    outsideBrain: false,
    ...overrides,
  }
}

describe('затухающий шлейф спиральных витков (срез 3.11)', () => {
  it('строит завершённые витки до текущей эпохи и гасит их с возрастом', () => {
    // Эпоха 2 отброшена: виток 1 → 3 — переход через разрыв (17.10.2026)
    const arcs = spiralTrailArcs([point(3), point(0), point(1)], 3, 1000)

    expect(arcs.map((arc) => arc.id)).toEqual(['single:0-1', 'single:1-3'])
    // Возраст — по новому концу витка: свежайший гаснет меньше всех
    expect(arcs[1].alpha).toBeCloseTo(TRAIL_ALPHA_HEAD, 6)
    expect(arcs[0].alpha).toBeCloseTo(TRAIL_ALPHA_HEAD * (1 - 2000 / TRAIL_WINDOW_MS), 6)
    expect(arcs[0].samples).toHaveLength(SPIRAL_SAMPLES_PER_ARC + 1)
    expect(arcs[0].samples[0].position).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('не тянет шлейф «в будущее» и обрывает его окном последних секунд', () => {
    const points = [point(0), point(1), point(5)]
    // Эпоха 1: измеренная точка 5 — впереди, это не история
    expect(spiralTrailArcs(points, 1, 1000).map((arc) => arc.id)).toEqual(['single:0-1'])

    // Эпоха 4, длина эпохи 3.2 с: возраст витка 0 → 1 (9.6 с) гаснет ниже
    // минимума — шлейф обрывается, а не дотягивается через всё окно
    const long = [point(0), point(1), point(2), point(3), point(4)]
    const arcs = spiralTrailArcs(long, 4, 3200)
    expect(arcs.map((arc) => arc.id)).toEqual(['single:1-2', 'single:2-3', 'single:3-4'])
  })

  it('держит бюджет шлейфа: свежайшие витки важнее полноты', () => {
    const points = Array.from({ length: 300 }, (_, index) => point(index))
    const arcs = spiralTrailArcs(points, 299, 50)

    expect(arcs).toHaveLength(SPIRAL_MAX_ARCS)
    expect(arcs[arcs.length - 1].id).toBe('single:298-299')
  })

  it('не рисует виток, чей хоть один конец слабее порогов отображения', () => {
    // GOF точки — доля 0…1, порог — в процентах (как в панели «GOF ≥ X %»)
    const thresholds: DisplayThresholds = { minGofPercent: 80, minAmplitudeNaM: 0 }
    const arcs = spiralTrailArcs([point(0), point(1, { gof: 0.5 }), point(2)], 2, 1000, thresholds)

    // Слабая точка 1 убирает оба смежных витка: шлейф не ведёт к скрытой точке
    expect(arcs).toEqual([])
  })

  it('кончики луча на проекции считаются формулой маркера, длина — по амплитуде якоря', () => {
    const arc = spiralTrailArcs(
      [
        point(0, { position: { x: 10, y: -20, z: 5 }, orientation: { x: 1, y: 0, z: 0 } }),
        point(1, { orientation: { x: 0, y: 1, z: 0 } }),
      ],
      1,
      1000,
    )[0]

    const tips = spiralTipsPx(arc, 'axial')
    const expected = projectPoint('axial', arc.samples[0].position)
    const direction = dipoleVectorDirection('axial', arc.samples[0].orientation)
    const vectorPx = dipoleVectorLength(10)

    expect(spiralTipLengthPx(arc)).toBe(vectorPx)
    expect(tips).toHaveLength(SPIRAL_SAMPLES_PER_ARC + 1)
    expect(tips[0].x).toBeCloseTo(expected.x + direction.u * vectorPx, 6)
    expect(tips[0].y).toBeCloseTo(expected.y - direction.v * vectorPx, 6)
  })

  it('кончики в 3D отстоят от позиции на длину луча в миллиметрах', () => {
    const arc = spiralTrailArcs(
      [
        point(0, { position: { x: 10, y: -20, z: 5 }, orientation: { x: 1, y: 0, z: 0 } }),
        point(1, { orientation: { x: 0, y: 1, z: 0 } }),
      ],
      1,
      1000,
    )[0]

    const tips = spiralTipsMm(arc)
    const tipMm = dipoleVectorLength(10) / PROJECTION_SCALE

    expect(tips[0].x).toBeCloseTo(10 + tipMm, 6)
    expect(tips[0].y).toBeCloseTo(-20, 6)
    expect(tips[0].z).toBeCloseTo(5, 6)
  })

  it('знак поворота на проекции — вид на её экране: CCW/CW и фолбэки «нет вращения»', () => {
    const arcOf = (from: DipolePoint['orientation'], to: DipolePoint['orientation']) =>
      spiralTrailArcs([point(0, { orientation: from }), point(1, { orientation: to })], 1, 1000)[0]

    // Аксиальная: «вверх» — перед (y), горизонталь развёрнута (слева правое
    // полушарие). Поворот «вверх» → «налево» — против часовой на экране
    expect(arcSenseOnPlane(arcOf({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }), 'axial')).toBe('ccw')
    expect(arcSenseOnPlane(arcOf({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 'axial')).toBe('cw')
    // Коронарная: «налево» (правое полушарие) → «вверх» — по часовой на экране
    expect(arcSenseOnPlane(arcOf({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), 'coronal')).toBe('cw')
    // Момент вдоль нормали среза на сагиттальной не виден — вращения нет
    expect(arcSenseOnPlane(arcOf({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 'sagittal')).toBe('none')
    // Совпадающие и противонаправленные Q: slerp держит первое направление
    expect(arcSenseOnPlane(arcOf({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 'axial')).toBe('none')
    expect(arcSenseOnPlane(arcOf({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }), 'axial')).toBe('none')
  })

  it('знак в 3D — относительно вертикальной оси (вид сверху), а не камеры', () => {
    const arcOf = (from: DipolePoint['orientation'], to: DipolePoint['orientation']) =>
      spiralTrailArcs([point(0, { orientation: from }), point(1, { orientation: to })], 1, 1000)[0]

    // Q (1,0,0) → (0,1,0): ось вращения «на нас» (правая рука, +z) — CCW
    expect(arcSense3d(arcOf({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }))).toBe('ccw')
    expect(arcSense3d(arcOf({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }))).toBe('cw')
    // Поворот в горизонтальной плоскости «в торец» виду сверху — знака нет
    expect(arcSense3d(arcOf({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }))).toBe('none')
  })
})
