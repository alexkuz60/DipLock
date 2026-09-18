/**
 * Тесты математики кадра воспроизведения (срез 3.7).
 *
 * Проверяется то, на чём держится обещание «интерполяция — отображение, а не
 * измерение»: эпоха и доля считаются по сетке нарезки с зажимом, кадр между
 * соседними эпохами интерполируется (позиция — по прямой, направление — по дуге),
 * а в эпохе без диполя кадр остаётся **пустым**, а не «дотягивается» от соседа.
 */
import { describe, expect, it } from 'vitest'
import {
  ANATOMY_UNKNOWN_TEXT,
  DEFAULT_PLAYBACK_SPEED,
  PLAYBACK_SPEEDS,
  TRAIL_ALPHA_HEAD,
  TRAIL_ALPHA_MIN,
  TRAIL_MAX_SEGMENTS,
  anatomyChangeText,
  anatomyText,
  canPlayback,
  clampEpochIndex,
  epochAtTime,
  epochFraction,
  interpolatedPoint,
  lerp,
  nextAnatomyChange,
  normalizePlaybackSpeed,
  playbackDurationMs,
  playbackSummary,
  pointByEpoch,
  slerpUnit,
  trailSegments,
} from './playback'
import type { DipolePoint } from './dipolePoints'
import { dipoleScanResultFixture } from '@/test/fixtures'

/** Точка эпохи с предсказуемыми координатами: кадр интерполируется по числам. */
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
    ...overrides,
  }
}

describe('кадр воспроизведения траектории', () => {
  it('держит скорости ×0.25…×4 и приводит чужое значение к ×1', () => {
    expect(PLAYBACK_SPEEDS).toEqual([0.25, 0.5, 1, 2, 4])
    expect(DEFAULT_PLAYBACK_SPEED).toBe(1)
    // Замедление — чтобы успеть прочитать подписи кадра (поправка ручной проверки)
    expect(normalizePlaybackSpeed(0.25)).toBe(0.25)
    expect(normalizePlaybackSpeed(0.5)).toBe(0.5)
    expect(normalizePlaybackSpeed(2)).toBe(2)
    // «Скорости ×3» в UI нет: значение из старого состояния не должно дойти до часов
    expect(normalizePlaybackSpeed(3)).toBe(1)
    expect(normalizePlaybackSpeed(Number.NaN)).toBe(1)
  })

  it('не запускает воспроизведение без точек и без сетки эпох', () => {
    expect(canPlayback(null)).toBe(false)
    expect(canPlayback(dipoleScanResultFixture({ points: [] }))).toBe(false)
    expect(canPlayback(dipoleScanResultFixture({ n_epochs_total: 0 }))).toBe(false)
    expect(canPlayback(dipoleScanResultFixture({ epoch_length_ms: 0 }))).toBe(false)
    expect(canPlayback(dipoleScanResultFixture())).toBe(true)
  })

  it('считает длительность воспроизведения по нарезке: ×1 — реальное время записи', () => {
    // test.edf: 261 эпоха по 500 мс ≈ 130.5 с
    expect(playbackDurationMs(500, 261)).toBe(130_500)
    expect(playbackDurationMs(0, 10)).toBe(0)
    expect(playbackDurationMs(500, 0)).toBe(0)
  })

  it('переводит время в номер эпохи с зажимом по сетке', () => {
    expect(epochAtTime(0, 500, 4)).toBe(0)
    expect(epochAtTime(499, 500, 4)).toBe(0)
    expect(epochAtTime(500, 500, 4)).toBe(1)
    expect(epochAtTime(1999, 500, 4)).toBe(3)
    // Часы могут «перелететь» конец записи: эпохи за сеткой нет
    expect(epochAtTime(100_000, 500, 4)).toBe(3)
    expect(epochAtTime(-50, 500, 4)).toBe(0)
    expect(epochAtTime(500, 0, 4)).toBe(0)
  })

  it('считает долю внутри эпохи, по которой идёт интерполяция', () => {
    expect(epochFraction(0, 500)).toBeCloseTo(0, 6)
    expect(epochFraction(250, 500)).toBeCloseTo(0.5, 6)
    expect(epochFraction(499, 500)).toBeCloseTo(0.998, 6)
    expect(epochFraction(500, 500)).toBeCloseTo(0, 6)
    expect(epochFraction(250, 0)).toBe(0)
  })

  it('зажимает шаг кадра в сетку нарезки', () => {
    expect(clampEpochIndex(-3, 4)).toBe(0)
    expect(clampEpochIndex(7, 4)).toBe(3)
    expect(clampEpochIndex(2.7, 4)).toBe(2)
    expect(clampEpochIndex(1, 0)).toBe(0)
    expect(clampEpochIndex(Number.NaN, 4)).toBe(0)
  })

  it('раскладывает точки по эпохам: у отброшенных эпох остаётся дыра', () => {
    const map = pointByEpoch([point(0), point(2)])
    expect(map.size).toBe(2)
    expect(map.get(2)?.epochIndex).toBe(2)
    // Эпоха 1 отброшена порогом: точки у неё нет, и кадр там будет пустым
    expect(map.has(1)).toBe(false)
  })

  it('интерполирует направление по дуге, а не по хорде', () => {
    // Середина дуги между (1,0,0) и (0,1,0) — единичный вектор под 45°: при
    // линейной интерполяции он был бы короче, и луч кадра «сжимался» бы
    const middle = slerpUnit({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5)
    expect(Math.hypot(middle.x, middle.y, middle.z)).toBeCloseTo(1, 6)
    expect(middle.x).toBeCloseTo(Math.SQRT1_2, 6)
    expect(middle.y).toBeCloseTo(Math.SQRT1_2, 6)
    expect(middle.z).toBeCloseTo(0, 6)

    // Почти совпадающие направления: формула дуги делила бы на ноль
    const same = slerpUnit({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5)
    expect(same.x).toBeCloseTo(1, 6)
    // Противонаправленные: дуга не определена — остаётся первое направление
    const opposite = slerpUnit({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, 0.5)
    expect(opposite.x).toBeCloseTo(1, 6)
    // Нулевой момент (диполь без направления) не «заражает» кадр нулём
    const fromZero = slerpUnit({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5)
    expect(fromZero.y).toBeCloseTo(1, 6)
    expect(lerp(0, 10, 0.25)).toBeCloseTo(2.5, 6)
  })

  it('интерполирует позицию, направление и амплитуду между соседними эпохами', () => {
    const map = pointByEpoch([
      point(0, { orientation: { x: 1, y: 0, z: 0 }, amplitudeNaM: 10 }),
      point(1, {
        position: { x: 10, y: -20, z: 30 },
        orientation: { x: 0, y: 1, z: 0 },
        amplitudeNaM: 30,
        id: '1-100',
      }),
    ])

    const frame = interpolatedPoint(map, 0, 0.5)

    expect(frame?.position).toEqual({ x: 5, y: -10, z: 15 })
    expect(frame?.amplitudeNaM).toBeCloseTo(20, 6)
    expect(frame?.orientation.x).toBeCloseTo(Math.SQRT1_2, 6)
    expect(frame?.orientation.y).toBeCloseTo(Math.SQRT1_2, 6)
    // Измеренные величины кадра берутся у своей эпохи, а не размываются: кадр
    // остаётся «эпохой N» с её временем пика, GOF и полем Бродмана
    expect(frame?.id).toBe('0-100')
    expect(frame?.epochIndex).toBe(0)
    expect(frame?.timeMs).toBe(100)
    expect(frame?.gof).toBe(0.9)
    expect(frame?.brodmannArea).toBe('BA17-lh')
  })

  it('на паузе и без следующей эпохи кадр равен измеренной точке', () => {
    const current = point(0, { amplitudeNaM: 42 })
    const map = pointByEpoch([current, point(1, { amplitudeNaM: 90 })])

    // Доля 0 — начало эпохи: показываем измерение, а не «полутон»
    expect(interpolatedPoint(map, 0, 0)).toBe(current)
    // Следующей эпохи нет (кадр на последней эпохе записи либо после разрыва)
    expect(interpolatedPoint(pointByEpoch([current]), 0, 0.5)).toBe(current)
  })

  it('оставляет кадр пустым в эпохе, где диполя не было', () => {
    // Эпоха 1 отброшена порогом: «протягивать» диполь через дыру в данных нельзя
    const map = pointByEpoch([point(0), point(2)])
    expect(interpolatedPoint(map, 1, 0.5)).toBeNull()
    expect(interpolatedPoint(map, 0, 0.5)).not.toBeNull()
    expect(interpolatedPoint(map, 3, 0.5)).toBeNull()
  })

  it('подписывает кадр эпохой, временем её начала и скоростью', () => {
    expect(playbackSummary(2, 261, 1.005, 2)).toBe('Кадр: эпоха 3 из 261 · 1.00 с · ×2')
    expect(playbackSummary(0, 4, 0, 1)).toBe('Кадр: эпоха 1 из 4 · 0.00 с · ×1')
  })

  /**
   * Шлейф траектории (срез 3.7): затухающий «хвост» из **измеренных** отрезков,
   * который показывает, каким путём диполь пришёл в текущий кадр.
   */
  it('держит окно шлейфа и гасит его от кадра к хвосту', () => {
    const points = pointByEpoch(Array.from({ length: 30 }, (_, index) => point(index)))

    // Нарезка 1000 мс: окно 10 с — это 10 отрезков к кадру эпохи 20
    const trail = trailSegments(points, 20, 1000)

    expect(trail).toHaveLength(10)
    expect(trail[0].id).toBe('10-11')
    expect(trail[trail.length - 1].id).toBe('19-20')
    // Примыкающий к кадру отрезок самый плотный, дальний — почти прозрачный
    expect(trail[trail.length - 1].alpha).toBeCloseTo(TRAIL_ALPHA_HEAD, 6)
    expect(trail[0].alpha).toBeCloseTo(TRAIL_ALPHA_HEAD * 0.1, 6)
    for (let index = 1; index < trail.length; index++) {
      expect(trail[index].alpha).toBeGreaterThan(trail[index - 1].alpha)
    }
    // Отрезки — между измеренными позициями соседних эпох, а не «от кадра»
    expect(trail[0].from).toEqual(points.get(10)?.position)
    expect(trail[0].to).toEqual(points.get(11)?.position)
  })

  it('начинает шлейф с первой эпохи и не тянется в прошлое за неё', () => {
    const points = pointByEpoch([point(0), point(1), point(2)])

    const trail = trailSegments(points, 2, 1000)

    expect(trail.map((segment) => segment.id)).toEqual(['0-1', '1-2'])
  })

  it('не тянет шлейф через разрыв: у эпохи без диполя отрезков нет', () => {
    // Эпоха 2 отброшена порогом: шлейф состоит из двух отрезков, а сквозного
    // скачка 1→3 (через эпоху, где диполя не было) в нём нет
    const points = pointByEpoch([point(0), point(1), point(3), point(4)])

    const trail = trailSegments(points, 4, 1000)

    expect(trail.map((segment) => segment.id)).toEqual(['0-1', '3-4'])
  })

  it('подчиняется порогу «КД», как облако и маркер кадра', () => {
    const points = pointByEpoch([point(0), point(1), point(2)])

    // Порог выше амплитуд всех точек — рисовать нечего
    expect(trailSegments(points, 2, 1000, 50)).toHaveLength(0)
    // Порог ниже — те же два отрезка
    expect(trailSegments(points, 2, 1000, 5)).toHaveLength(2)
  })

  it('ограничивает длину шлейфа и молчит без нарезки', () => {
    // Короткие эпохи: окно вместило бы сотни отрезков — их число ограничено
    const many = pointByEpoch(Array.from({ length: 200 }, (_, index) => point(index)))
    const trail = trailSegments(many, 150, 250)
    expect(trail.length).toBeLessThanOrEqual(TRAIL_MAX_SEGMENTS)
    // …и гаснет раньше окна: слишком старые отрезки уже прозрачны
    expect(trail[trail.length - 1].alpha).toBeCloseTo(TRAIL_ALPHA_HEAD, 6)
    expect(trail[0].alpha).toBeGreaterThanOrEqual(TRAIL_ALPHA_MIN)

    // Без длины эпохи и по одной точке шлейфа нет вовсе
    expect(trailSegments(many, 150, 0)).toEqual([])
    expect(trailSegments(pointByEpoch([point(0)]), 0, 1000)).toEqual([])
  })

  /**
   * Анатомия кадра (срез 3.7): структура и поле — метки **измеренной** точки
   * эпохи, поэтому «дальше» ищется по эпохам результата, а не по интерполяции.
   */
  it('находит ближайшую смену анатомии впереди: структура и поле — разные величины', () => {
    const points = new Map([
      [0, point(0)],
      [1, point(1)],
      [2, point(2, { structure: 'прецентральная извилина (слева)' })],
    ])

    // Поле у эпохи 2 то же (`BA17-lh` из хелпера), но структура изменилась — это смена
    expect(nextAnatomyChange(points, 0)).toEqual({
      epochIndex: 2,
      timeMs: 100,
      labels: { structure: 'прецентральная извилина (слева)', area: 'BA17-lh' },
    })
    expect(nextAnatomyChange(points, 1)).toMatchObject({ epochIndex: 2 })

    // Меняется только поле — тоже смена
    const areaOnly = new Map([
      [0, point(0)],
      [1, point(1, { brodmannArea: 'BA4-lh' })],
    ])
    expect(nextAnatomyChange(areaOnly, 0)).toMatchObject({
      epochIndex: 1,
      labels: { structure: 'таламус (слева)', area: 'BA4-lh' },
    })

    // «Не определено» — такая же величина, как название: переход в неё показывается
    const toUnknown = new Map([
      [0, point(0, { brodmannArea: 'unknown' })],
      [1, point(1)],
    ])
    expect(nextAnatomyChange(toUnknown, 0)).toMatchObject({
      epochIndex: 1,
      labels: { structure: 'таламус (слева)', area: 'BA17-lh' },
    })
  })

  it('не показывает смену через разрыв и в конце записи', () => {
    // Эпоха 1 отсутствует (отброшена нарезкой или у точки нет MNI): это разрыв в
    // данных, а не «переход» — протягивать через него нельзя, как и кадр
    const broken = new Map([
      [0, point(0)],
      [2, point(2, { structure: 'прецентральная извилина (слева)' })],
    ])
    expect(nextAnatomyChange(broken, 0)).toBeNull()
    // Метки не меняются до последней эпохи — смены нет
    expect(
      nextAnatomyChange(
        new Map([
          [0, point(0)],
          [1, point(1)],
        ]),
        0,
      ),
    ).toBeNull()
    // Эпохи, которой нет в карте точек, нет и у перехода
    expect(nextAnatomyChange(new Map([[0, point(0)]]), 3)).toBeNull()
  })

  it('подписывает анатомию словами: «не определена» вместо пустоты и прочерка', () => {
    expect(anatomyText({ structure: 'таламус (слева)', area: 'BA17-lh' })).toBe(
      'таламус (слева), BA17-lh',
    )
    expect(anatomyText({ structure: null, area: 'BA17-lh' })).toBe('BA17-lh')
    expect(anatomyText({ structure: null, area: null })).toBe(ANATOMY_UNKNOWN_TEXT)
    expect(
      anatomyChangeText({
        epochIndex: 51,
        timeMs: 26_000,
        labels: { structure: null, area: null },
      }),
    ).toBe(`дальше: эпоха 52 (26.000 с) → ${ANATOMY_UNKNOWN_TEXT}`)
  })
})
