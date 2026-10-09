/**
 * Тесты темп-коррекции радара «Эмо» (спецификация владельца 09.10.2026,
 * `docs/rules/neuromusic.md` §«Эмо», «Темп-коррекция»): шкала оси Y
 * (логарифм от 2, 60/120/240), коэффициент Kr = sin(π/2·|y|), пофреймовый
 * ряд темпа из оценок VAMP (усреднение/hold) и его интерполяция,
 * коррекция радиусов по квадрантам с условной нормализацией.
 */
import { describe, expect, it } from 'vitest'
import type { AudioTempoSegment } from '@/shared/api/types'
import {
  TEMPO_CENTER_BPM,
  TEMPO_MAX_BPM,
  TEMPO_MIN_BPM,
  formatTempoBpm,
  frameTempos,
  interpolatedTempo,
  tempoCorrectedRays,
  tempoKr,
  tempoY,
} from './tempoCorrection'

/** Оценка темпа — сокращение для контрольных треков. */
const est = (tSec: number, bpm: number): AudioTempoSegment => ({ t_sec: tSec, bpm })

describe('tempoY — проекция темпа на ось Y (логарифм от 2)', () => {
  it('якоря шкалы: 60 → −1, 120 → 0, 240 → +1', () => {
    expect(TEMPO_MIN_BPM).toBe(60)
    expect(TEMPO_CENTER_BPM).toBe(120)
    expect(TEMPO_MAX_BPM).toBe(240)
    expect(tempoY(60)).toBeCloseTo(-1, 12)
    expect(tempoY(120)).toBe(0)
    expect(tempoY(240)).toBeCloseTo(1, 12)
  })

  it('середина по логарифму: 90 → log2(0.75), 180 → log2(1.5)', () => {
    expect(tempoY(90)).toBeCloseTo(Math.log2(0.75), 12)
    expect(tempoY(180)).toBeCloseTo(Math.log2(1.5), 12)
  })

  it('вне 60…240 зажимается к границам; мусор → 0', () => {
    expect(tempoY(30)).toBeCloseTo(-1, 12)
    expect(tempoY(480)).toBeCloseTo(1, 12)
    expect(tempoY(0)).toBe(0)
    expect(tempoY(-100)).toBe(0)
    expect(tempoY(Number.NaN)).toBe(0)
    expect(tempoY(null)).toBe(0)
    expect(tempoY(undefined)).toBe(0)
  })
})

describe('tempoKr — «синус метки»: sin(π/2 · |y|)', () => {
  it('якоря: 60 → 1, 120 → 0, 240 → 1', () => {
    expect(tempoKr(60)).toBeCloseTo(1, 12)
    expect(tempoKr(120)).toBe(0)
    expect(tempoKr(240)).toBeCloseTo(1, 12)
  })

  it('промежуточные: 90 → ≈0.607, 180 → ≈0.796 (симметрия по |y|)', () => {
    expect(tempoKr(90)).toBeCloseTo(Math.sin((Math.PI / 2) * Math.abs(Math.log2(0.75))), 12)
    expect(tempoKr(180)).toBeCloseTo(Math.sin((Math.PI / 2) * Math.abs(Math.log2(1.5))), 12)
    expect(tempoKr(90)).toBeCloseTo(0.6067, 3)
    expect(tempoKr(180)).toBeCloseTo(0.7948, 3)
    // Симметрия: Kr зависит только от |y| (60 и 240 — по 1, 90 и 180 — по |y| ≠).
    expect(tempoKr(80)).toBeCloseTo(tempoKr(180), 12)
  })
})

describe('frameTempos — темп каждого кадра из оценок VAMP', () => {
  const frames = (count: number, hop = 1) =>
    Array.from({ length: count }, (_, index) => ({ t_sec: index * hop }))

  it('усреднение: несколько оценок в диапазоне кадра → одно значение', () => {
    const track = [est(0, 120), est(0.3, 100), est(1.5, 90)]
    // Кадр 0: [0, 1) → среднее 120 и 100 = 110; кадр 1: [1, 2) → 90.
    expect(frameTempos(track, frames(2), 1)).toEqual([110, 90])
  })

  it('hold: кадр без оценок держит предыдущее значение; до первой — null', () => {
    const track = [est(2.2, 140)]
    // Кадры 0 и 1 без оценок до первой → null; кадры 2+ — hold 140.
    expect(frameTempos(track, frames(5), 1)).toEqual([null, null, 140, 140, 140])
  })

  it('пустой/отсутствующий трек → все null; длина ряда = длина frames', () => {
    expect(frameTempos(null, frames(3), 1)).toEqual([null, null, null])
    expect(frameTempos([], frames(3), 1)).toEqual([null, null, null])
    expect(frameTempos([est(0, 120)], [], 1)).toEqual([])
    expect(frameTempos([est(0, 120)], frames(4), 0)).toEqual([null, null, null, null])
  })

  it('оценка на границе кадра принадлежит следующему диапазону [t, t+hop)', () => {
    const track = [est(1, 120)]
    // Кадр 0: [0, 1) — пусто (до первой оценки); кадр 1: [1, 2) → 120.
    expect(frameTempos(track, frames(3), 1)).toEqual([null, 120, 120])
  })
})

describe('interpolatedTempo — плавный темп между слайдами', () => {
  const frames = (count: number, hop = 1) =>
    Array.from({ length: count }, (_, index) => ({ t_sec: index * hop }))

  it('линейная интерполяция между слайдами, хвосты держатся', () => {
    const tempos = [100, 140]
    expect(interpolatedTempo(tempos, frames(2), 1, 0)).toBe(100)
    expect(interpolatedTempo(tempos, frames(2), 1, 0.5)).toBe(120)
    expect(interpolatedTempo(tempos, frames(2), 1, 1)).toBe(140)
    expect(interpolatedTempo(tempos, frames(2), 1, 5)).toBe(140) // хвост
    expect(interpolatedTempo(tempos, frames(2), 1, -1)).toBe(100) // до первого
  })

  it('null-значения: слайд до первой оценки — null (без коррекции)', () => {
    const frames3 = frames(3)
    expect(interpolatedTempo([null, 120, 120], frames3, 1, 0)).toBeNull() // from null
    expect(interpolatedTempo([null, 120, 120], frames3, 1, 1)).toBe(120) // первый слайд с оценкой
    expect(interpolatedTempo([null, null, 120], frames3, 1, 0.5)).toBeNull()
    expect(interpolatedTempo([120, 120, null], frames3, 1, 1.5)).toBe(120) // to null → from
    expect(interpolatedTempo([120, null, null], frames3, 1, 1.5)).toBeNull() // from null
    expect(interpolatedTempo([], frames3, 1, 0)).toBeNull()
  })
})

describe('tempoCorrectedRays — коррекция радиусов по квадрантам', () => {
  // Углы вершин как у графика (без поворота): границы 7 сегментов.
  const angles7 = Array.from(
    { length: 7 },
    (_, index) => Math.PI / 2 + Math.PI / 7 + index * ((2 * Math.PI) / 7),
  )
  const flat = Array.from({ length: 7 }, () => 40)

  it('темп < 120: нижние квадранты (θ ≥ π) удлиняются на Kr, верхние нет', () => {
    const corrected = tempoCorrectedRays(flat, angles7, 60) // Kr = 1
    angles7.forEach((angle, index) => {
      const isLower = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) >= Math.PI
      expect(corrected[index]).toBeCloseTo(isLower ? 80 : 40, 6)
    })
  })

  it('темп > 120: верхние квадранты (θ < π) удлиняются на Kr, нижние нет', () => {
    const corrected = tempoCorrectedRays(flat, angles7, 240) // Kr = 1
    angles7.forEach((angle, index) => {
      const isLower = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) >= Math.PI
      expect(corrected[index]).toBeCloseTo(isLower ? 40 : 80, 6)
    })
  })

  it('квадрант определяется углом после поворота: сдвиг π меняет половину', () => {
    // Поворот на π переворачивает круг: те же значения → другая половина.
    const plain = tempoCorrectedRays(flat, angles7, 60)
    const rotated = tempoCorrectedRays(
      flat,
      angles7.map((angle) => angle + Math.PI),
      60,
    )
    angles7.forEach((_, index) => {
      expect(rotated[index]).toBeCloseTo(plain[index] === 80 ? 40 : 80, 6)
    })
  })

  it('темп = 120 → Kr = 0, без изменений; null/мусор → копия без изменений', () => {
    expect(tempoCorrectedRays(flat, angles7, 120)).toEqual(flat)
    expect(tempoCorrectedRays(flat, angles7, null)).toEqual(flat)
    expect(tempoCorrectedRays(flat, angles7, Number.NaN)).toEqual(flat)
  })

  it('условная нормализация: превышение 100 → деление на max; без превышения — как есть', () => {
    const loud = Array.from({ length: 7 }, () => 70)
    // 70 · 2 = 140 > 100 → все делятся на 1.4: 140 → 100, 70 → 50.
    const corrected = tempoCorrectedRays(loud, angles7, 60)
    angles7.forEach((angle, index) => {
      const isLower = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) >= Math.PI
      expect(corrected[index]).toBeCloseTo(isLower ? 100 : 50, 6)
    })
    expect(Math.max(...corrected)).toBeCloseTo(100, 6)
    // Без превышения (20 → 40/20) значения не пересчитываются.
    const quiet = Array.from({ length: 7 }, () => 20)
    const mild = tempoCorrectedRays(quiet, angles7, 60)
    angles7.forEach((angle, index) => {
      const isLower = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) >= Math.PI
      expect(mild[index]).toBeCloseTo(isLower ? 40 : 20, 6)
    })
  })

describe('formatTempoBpm — темп текстом для счётчика «Темп»', () => {
  it('один десятичный знак, запятая как разделитель; неопределённый темп — «—»', () => {
    expect(formatTempoBpm(120.44)).toBe('120,4 bpm')
    expect(formatTempoBpm(100)).toBe('100,0 bpm')
    expect(formatTempoBpm(12.34)).toBe('12,3 bpm')
    expect(formatTempoBpm(null)).toBe('—')
    expect(formatTempoBpm(undefined)).toBe('—')
    expect(formatTempoBpm(Number.NaN)).toBe('—')
    expect(formatTempoBpm(0)).toBe('—')
    expect(formatTempoBpm(-5)).toBe('—')
  })
})
})