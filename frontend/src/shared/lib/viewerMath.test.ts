/** Тесты математики вьюера: окна, дискретный зум, min/max-огибающая. */
import { describe, expect, it } from 'vitest'
import {
  anchoredCenter,
  clampCenter,
  envelopeOf,
  fullWindow,
  panByPixels,
  pointsBudget,
  windowCenter,
  zoomWindow,
} from '@/shared/lib/viewerMath'

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

describe('min/max-огибающая', () => {
  it('без прореживания возвращает исходные отсчёты окна', () => {
    const data = new Float32Array([0, 1, 2, 3, 4, 5])
    const env = envelopeOf(data, 100, { t0: 0.01, t1: 0.04 }, 10)

    expect(env.decimated).toBe(false)
    expect(Array.from(env.min)).toEqual([1, 2, 3])
    expect(Array.from(env.max)).toEqual([1, 2, 3])
    expect(env.times[0]).toBeCloseTo(0.01)
  })

  it('сохраняет пики артефактов при грубом зуме (главное требование)', () => {
    // 10 000 отсчётов нулей с одним пиком 150 мкВ посередине
    const data = new Float32Array(10_000)
    data[5_000] = 150
    data[4_999] = -120

    const env = envelopeOf(data, 1000, { t0: 0, t1: 10 }, 100)

    expect(env.decimated).toBe(true)
    expect(env.times.length).toBe(100)
    // пик не потерян: глобальный максимум и минимум попали в огибающую
    expect(Math.max(...env.max)).toBe(150)
    expect(Math.min(...env.min)).toBe(-120)
    // остальные корзины — нули
    expect(env.max.filter((v) => v === 0).length).toBe(99)
  })

  it('покрывает окно без пропусков и не выходит за данные', () => {
    const data = new Float32Array(10_000).map((_, i) => i)
    const env = envelopeOf(data, 1000, { t0: 2, t1: 7 }, 200)

    expect(env.times.length).toBe(200)
    expect(env.min[0]).toBe(2_000)
    expect(env.max[199]).toBe(6_999)
    // монотонные времена
    for (let i = 1; i < env.times.length; i++) {
      expect(env.times[i]).toBeGreaterThan(env.times[i - 1])
    }
  })

  it('пустое окно не падает', () => {
    const env = envelopeOf(new Float32Array(0), 1000, { t0: 0, t1: 1 }, 100)
    expect(env.times.length).toBe(0)
    expect(env.decimated).toBe(false)
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
