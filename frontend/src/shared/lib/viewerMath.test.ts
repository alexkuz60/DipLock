/** Тесты математики вьюера: окна, дискретный зум, min/max-огибающая кадра. */
import { describe, expect, it } from 'vitest'
import {
  anchoredCenter,
  clampCenter,
  frameEnvelope,
  fullWindow,
  panByPixels,
  pointsBudget,
  timeToX,
  windowCenter,
  xToTime,
  zoomWindow,
} from '@/shared/lib/viewerMath'

/** Кадр: линейно растущие времена и огибающая min/max по каналу. */
function frame(nPoints: number, durationSec: number, valueOf: (i: number) => [number, number]) {
  const times = new Float32Array(nPoints)
  const min = new Float32Array(nPoints)
  const max = new Float32Array(nPoints)
  for (let i = 0; i < nPoints; i++) {
    times[i] = ((i + 0.5) * durationSec) / nPoints
    const [lo, hi] = valueOf(i)
    min[i] = lo
    max[i] = hi
  }
  return { times, min, max }
}

describe('временные окна', () => {
  it('fullWindow — вся запись', () => {
    expect(fullWindow(130.72)).toEqual({ t0: 0, t1: 130.72 })
  })

  it('zoomWindow центрируется и зажимается в границы записи', () => {
    expect(zoomWindow(100, 4, 50)).toEqual({ t0: 37.5, t1: 62.5 })
    // центр у края — окно не выходит за 0
    expect(zoomWindow(100, 4, 0)).toEqual({ t0: 0, t1: 25 })
    expect(zoomWindow(100, 4, 100)).toEqual({ t0: 75, t1: 100 })
    // factor=1 — вся запись независимо от центра
    expect(zoomWindow(100, 1, 42)).toEqual({ t0: 0, t1: 100 })
  })

  it('clampCenter не даёт окну вылезти за запись', () => {
    expect(clampCenter(2, 20, 100)).toBe(10)
    expect(clampCenter(98, 20, 100)).toBe(90)
    expect(clampCenter(50, 20, 100)).toBe(50)
    // окно шире записи — центр всегда середина
    expect(clampCenter(7, 200, 100)).toBe(50)
  })

  it('panByPixels: тянем вправо — окно едет в прошлое, с зажимом', () => {
    const window = { t0: 40, t1: 60 } // ширина 20 с, 1000 px → 0.02 с/px
    expect(panByPixels(50, 100, window, 1000, 100)).toBe(48)
    expect(panByPixels(50, -100, window, 1000, 100)).toBe(52)
    expect(panByPixels(50, 10_000, window, 1000, 100)).toBe(10) // зажат к началу
    expect(panByPixels(50, -10_000, window, 1000, 100)).toBe(90) // зажат к концу
  })

  it('anchoredCenter держит точку курсора на месте при зуме', () => {
    // окно 0..100, курсор на 75 % (t=75), новая ширина 25 → новое окно 56.25..81.25
    const center = anchoredCenter(75, 0.75, 25, 100)
    expect(center).toBeCloseTo(68.75)
    // зажим в границы: t0 = 2 − 0.3·25 = −5.5 → окно прижато к началу
    expect(anchoredCenter(2, 0.3, 25, 100)).toBe(12.5)
    // без зажима: курсор t=1 на 1 % окна шириной 25 → t0=0.75, центр 13.25
    expect(anchoredCenter(1, 0.01, 25, 100)).toBeCloseTo(13.25)
  })
})

describe('min/max-огибающая кадра', () => {
  it('без прореживания возвращает корзины окна как есть', () => {
    // 6 корзин по 0.1 с: времена 0.05, 0.15, …, 0.55
    const { times, min, max } = frame(6, 0.6, (i) => [i, i + 0.5])
    const env = frameEnvelope(times, min, max, { t0: 0.1, t1: 0.4 }, 10)

    expect(env.decimated).toBe(false)
    expect(Array.from(env.min)).toEqual([1, 2, 3])
    expect(Array.from(env.max)).toEqual([1.5, 2.5, 3.5])
    expect(env.times[0]).toBeCloseTo(0.15)
  })

  it('сохраняет пики артефактов при агрегации (главное требование)', () => {
    // 10 000 корзин нулей с пиком 150 / провалом −120
    const { times, min, max } = frame(10_000, 10, (i) =>
      i === 5_000 ? [-120, 150] : [0, 0],
    )

    const env = frameEnvelope(times, min, max, { t0: 0, t1: 10 }, 100)

    expect(env.decimated).toBe(true)
    expect(env.times.length).toBe(100)
    // пик не потерян: глобальный max/min попали в огибающую
    expect(Math.max(...env.max)).toBe(150)
    expect(Math.min(...env.min)).toBe(-120)
    // остальные корзины — нули
    expect(Array.from(env.max).filter((value) => value === 0).length).toBe(99)
  })

  it('отбирает корзины окна и не выходит за кадр', () => {
    const nPoints = 1_000
    const { times, min, max } = frame(nPoints, 1, (i) => [i, i])
    const env = frameEnvelope(times, min, max, { t0: 0.2, t1: 0.7 }, 5_000)

    expect(env.times.length).toBe(500)
    expect(env.max[0]).toBe(200)
    expect(env.max[env.max.length - 1]).toBe(699)
    // монотонные времена
    for (let i = 1; i < env.times.length; i++) {
      expect(env.times[i]).toBeGreaterThan(env.times[i - 1])
    }
  })

  it('пустое окно не падает', () => {
    const { times, min, max } = frame(0, 0, () => [0, 0])
    const env = frameEnvelope(times, min, max, { t0: 0, t1: 1 }, 100)
    expect(env.times.length).toBe(0)
    expect(env.decimated).toBe(false)
  })

  it('окно за пределами кадра возвращает пустую огибающую', () => {
    const { times, min, max } = frame(10, 1, (i) => [i, i])
    const env = frameEnvelope(times, min, max, { t0: 5, t1: 6 }, 100)
    expect(env.times.length).toBe(0)
  })
})

describe('бюджет точек', () => {
  it('два раза ширина области, но не меньше 64', () => {
    expect(pointsBudget(1920)).toBe(3840)
    expect(pointsBudget(10)).toBe(64)
  })
})

describe('windowCenter', () => {
  it('середина окна', () => {
    expect(windowCenter({ t0: 10, t1: 30 })).toBe(20)
  })
})

describe('время ↔ пиксели окна', () => {
  const window = { t0: 10, t1: 30 } // 20 с на 1000 px → 0.02 с/px

  it('timeToX кладёт края окна на края области', () => {
    expect(timeToX(10, window, 1000)).toBe(0)
    expect(timeToX(30, window, 1000)).toBe(1000)
    expect(timeToX(20, window, 1000)).toBe(500)
    // Время до окна даёт отрицательный пиксель — вызывающий сам решает, обрезать
    expect(timeToX(5, window, 1000)).toBe(-250)
  })

  it('xToTime — обратная к timeToX', () => {
    expect(xToTime(0, window, 1000)).toBe(10)
    expect(xToTime(1000, window, 1000)).toBe(30)
    expect(xToTime(250, window, 1000)).toBeCloseTo(15, 9)
    expect(xToTime(timeToX(17.5, window, 1000), window, 1000)).toBeCloseTo(17.5, 9)
  })

  it('вырожденные окно и ширина не дают NaN/Infinity', () => {
    expect(timeToX(5, { t0: 5, t1: 5 }, 1000)).toBe(0)
    expect(xToTime(100, { t0: 5, t1: 5 }, 1000)).toBe(5)
    expect(xToTime(100, window, 0)).toBe(10)
  })
})
