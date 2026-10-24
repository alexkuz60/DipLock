/**
 * Тесты чистой логики кадров радара «Эмо»: сетка слайдов (шаг окна FFT
 * 32000 сэмплов = 2/3 с), выбор индекса кадра и линейная интерполяция
 * лучей между слайдами (решение владельца 08.10.2026 — плавная анимация).
 */
import { describe, expect, it } from 'vitest'
import type { AudioEmoFrame } from '@/shared/api/types'
import { frameIndexAt, hopSeconds, interpolatedRays } from './emoRadar'

/** Шаг кадра: 32000 / 48000 = 2/3 с (сетка синхронизации с плеером). */
const HOP = 32000 / 48000

function frame(index: number, rays: number[]): AudioEmoFrame {
  return { t_sec: index * HOP, rays }
}

/** Три слайда с арифметической прогрессией лучей: k-й слайд = base + k·10. */
const FRAMES: AudioEmoFrame[] = [
  frame(0, [10, 20, 30, 40, 50, 60, 70]),
  frame(1, [20, 30, 40, 50, 60, 70, 80]),
  frame(2, [30, 40, 50, 60, 70, 80, 90]),
]

describe('emoRadar — сетка кадров', () => {
  it('hopSeconds: hop/fs; нулевые/некорректные значения → 0', () => {
    expect(hopSeconds(32000, 48000)).toBeCloseTo(2 / 3, 12)
    expect(hopSeconds(0, 48000)).toBe(0)
    expect(hopSeconds(32000, 0)).toBe(0)
    expect(hopSeconds(-1, 48000)).toBe(0)
  })

  it('frameIndexAt: floor(t/hop), зажатый в 0…count−1', () => {
    expect(frameIndexAt(0, HOP, 3)).toBe(0)
    expect(frameIndexAt(HOP - 1e-9, HOP, 3)).toBe(0)
    expect(frameIndexAt(HOP, HOP, 3)).toBe(1)
    expect(frameIndexAt(2 * HOP, HOP, 3)).toBe(2)
    expect(frameIndexAt(1000, HOP, 3)).toBe(2) // хвост — последний слайд
    expect(frameIndexAt(-5, HOP, 3)).toBe(0) // до начала — первый
    expect(frameIndexAt(0, HOP, 0)).toBe(0) // пусто — ноль
    expect(frameIndexAt(Number.NaN, HOP, 3)).toBe(0)
    expect(frameIndexAt(1, 0, 3)).toBe(0) // сетки нет
  })
})

describe('emoRadar — интерполяция лучей', () => {
  it('на границе слайда — точные лучи кадра', () => {
    expect(interpolatedRays(FRAMES, HOP, 0)).toEqual(FRAMES[0]?.rays)
    expect(interpolatedRays(FRAMES, HOP, HOP)).toEqual(FRAMES[1]?.rays)
    expect(interpolatedRays(FRAMES, HOP, 2 * HOP)).toEqual(FRAMES[2]?.rays)
  })

  it('внутри слайда — линейная интерполяция соседних кадров', () => {
    const midFirst = interpolatedRays(FRAMES, HOP, HOP / 2)
    expect(midFirst).toHaveLength(7)
    midFirst?.forEach((value, ray) => {
      expect(value).toBeCloseTo(15 + ray * 10, 6)
    })
    const midSecond = interpolatedRays(FRAMES, HOP, 1.5 * HOP)
    midSecond?.forEach((value, ray) => {
      expect(value).toBeCloseTo(25 + ray * 10, 6)
    })
  })

  it('до первого/после последнего кадра — крайние слайды (хвост держится)', () => {
    expect(interpolatedRays(FRAMES, HOP, -1)).toEqual(FRAMES[0]?.rays)
    expect(interpolatedRays(FRAMES, HOP, 1000)).toEqual(FRAMES[2]?.rays)
    expect(interpolatedRays(FRAMES, HOP, Number.NaN)).toEqual(FRAMES[0]?.rays)
  })

  it('нет кадров либо нет сетки — null', () => {
    expect(interpolatedRays([], HOP, 0)).toBeNull()
    expect(interpolatedRays(FRAMES, 0, 0)).toBeNull()
    expect(interpolatedRays(FRAMES, Number.NaN, 0)).toBeNull()
  })

  it('интерполяция не выходит за границы лучей соседних кадров', () => {
    const partial = interpolatedRays(
      [frame(0, [0, 100, 50, 50, 50, 50, 50]), frame(1, [100, 0, 50, 50, 50, 50, 50])],
      HOP,
      HOP / 3,
    )
    partial?.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    })
  })
})
