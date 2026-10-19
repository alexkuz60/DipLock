/**
 * Тесты полосной гаммы пакета (п.1, 17.10.2026 + правка цветов 19.10.2026):
 * якорные цвета каталога и длины векторов, обратно зависимые от частот полос.
 *
 * Проверяется то, на чём держится читаемость мультиполосной анимации: одна и та
 * же полоса всегда одного цвета (цвет — адрес полосы на фигуре), δ/θ —
 * оранжевый, θ — жёлтый, γ — синий, но светлее низких полос (видны на тёмном
 * фоне), дельта — самый длинный красный вектор, высокая гамма — самый короткий
 * фиолетовый, а «свои» диапазоны получают детерминированный цвет по границам.
 */
import { describe, expect, it } from 'vitest'
import {
  BAND_COLOR_SATURATION,
  BAND_GAMMA_HZ_HI,
  BAND_GAMMA_HZ_LO,
  BAND_HUE_ANCHORS,
  BAND_LIGHTNESS_HI,
  BAND_LIGHTNESS_LO,
  BAND_VECTOR_MAX_PX,
  BAND_VECTOR_MIN_PX,
  bandCenterHz,
  bandColor,
  bandPosition,
  bandVectorPx,
} from './bandColors'

/** Базовые полосы `freq_bands` из `core/config.py` — от дельты до высокой гаммы. */
const FREQ_BANDS: [string, number[]][] = [
  ['delta', [0.5, 2]],
  ['delta_theta', [2, 4]],
  ['theta', [4, 8]],
  ['alpha', [8, 16]],
  ['beta', [16, 32]],
  ['gamma', [32, 64]],
  ['high_gamma', [64, 128]],
]

/** Оттенок/светлота/насыщенность из строки `hsl(H, S%, L%)`. */
function hslOf(color: string): { hue: number; saturation: number; lightness: number } {
  const match = /^hsl\(([-\d.]+), ([\d.]+)%, ([\d.]+)%\)$/.exec(color)
  expect(match).not.toBeNull()
  return {
    hue: Number(match?.[1]),
    saturation: Number(match?.[2]),
    lightness: Number(match?.[3]),
  }
}

describe('полосная гамма пакета (цвета и длины векторов)', () => {
  it('ведёт позицию полосы по лог-частотной оси: дельта — 0, высокая гамма — 1', () => {
    expect(bandPosition([0.5, 2])).toBeCloseTo(0, 6)
    expect(bandPosition([64, 128])).toBeCloseTo(1, 6)
    // Монотонность по базовым полосам: каждая следующая — «правее» предыдущей
    for (let index = 1; index < FREQ_BANDS.length; index++) {
      expect(bandPosition(FREQ_BANDS[index][1])).toBeGreaterThan(
        bandPosition(FREQ_BANDS[index - 1][1]),
      )
    }
    // Вне гаммы позиция зажимается, а не «улетает»
    expect(bandPosition([0.01, 0.02])).toBe(0)
    expect(bandPosition([200, 400])).toBe(1)
  })

  it('красит каталожные полосы их целевыми цветами: δ/θ — оранжевый, θ — жёлтый, γ — синий светлее', () => {
    // Якоря гаммы стоят в центрах полос каталога — цвет ровно якоря
    expect(hslOf(bandColor([2, 4])).hue).toBeCloseTo(36, 6) // delta_theta — оранжевый
    expect(hslOf(bandColor([4, 8])).hue).toBeCloseTo(60, 6) // theta — жёлтый
    expect(hslOf(bandColor([32, 64])).hue).toBeCloseTo(215, 6) // gamma — синий
    // gamma — синий, но светлее низких полос (правка 19.10.2026: диполи на
    // тёмном фоне проекций читались хуже)
    expect(hslOf(bandColor([32, 64])).lightness).toBeGreaterThan(
      hslOf(bandColor([0.5, 2])).lightness,
    )
    expect(hslOf(bandColor([0.5, 2])).lightness).toBeCloseTo(BAND_LIGHTNESS_LO, 6)
    expect(hslOf(bandColor([64, 128])).lightness).toBeCloseTo(BAND_LIGHTNESS_HI, 6)
    // Вне гаммы светлота/оттенок зажимаются крайним якорем, а не «улетают»
    expect(hslOf(bandColor([0.01, 0.02])).hue).toBeCloseTo(0, 6)
    expect(hslOf(bandColor([200, 400])).hue).toBeCloseTo(275, 6)
  })

  it('ведёт оттенок монотонно по частоте и держит насыщенность постоянной', () => {
    // Оттенок растёт с частотой — полосы не «перемешиваются» в гамме
    for (let index = 1; index < FREQ_BANDS.length; index++) {
      expect(hslOf(bandColor(FREQ_BANDS[index][1])).hue).toBeGreaterThan(
        hslOf(bandColor(FREQ_BANDS[index - 1][1])).hue,
      )
    }
    // Якоря упорядочены и по частоте, и по оттенку — гамма монотонна везде
    for (let index = 1; index < BAND_HUE_ANCHORS.length; index++) {
      expect(BAND_HUE_ANCHORS[index][0]).toBeGreaterThan(BAND_HUE_ANCHORS[index - 1][0])
      expect(BAND_HUE_ANCHORS[index][1]).toBeGreaterThan(BAND_HUE_ANCHORS[index - 1][1])
    }
    // Насыщенность постоянная: полосы различаются оттенком и светлотой
    for (const [, bandHz] of FREQ_BANDS) {
      expect(hslOf(bandColor(bandHz)).saturation).toBe(BAND_COLOR_SATURATION)
    }
    // Детерминированность: цвет это адрес полосы, а не украшение
    expect(bandColor([8, 13])).toBe(bandColor([8, 13]))
  })

  it('даёт длину вектора, обратно зависимую от частот: delta — длиннее всех, high_gamma — короче', () => {
    expect(bandVectorPx([0.5, 2])).toBeCloseTo(BAND_VECTOR_MAX_PX, 6)
    expect(bandVectorPx([64, 128])).toBeCloseTo(BAND_VECTOR_MIN_PX, 6)
    for (let index = 1; index < FREQ_BANDS.length; index++) {
      expect(bandVectorPx(FREQ_BANDS[index][1])).toBeLessThan(
        bandVectorPx(FREQ_BANDS[index - 1][1]),
      )
    }
  })

  it('обходится с «своими» диапазонами и одиночной частотой по их центру', () => {
    // Функциональные ритмы и custom:от-до получают цвет/длину по своим границам
    expect(bandCenterHz([8, 13])).toBeCloseTo(10.5, 6)
    expect(bandColor([8, 13])).toBe(bandColor([9, 12]))
    // Одна граница (одиночная частота) — центр равен ей
    expect(bandCenterHz([10, 10])).toBeCloseTo(10, 6)
    expect(bandPosition([10, 10])).toBeCloseTo(bandPosition([9.5, 10.5]), 9)
    // Опоры гаммы согласованы с конфигом: центры delta и high_gamma
    expect(BAND_GAMMA_HZ_LO).toBeCloseTo(bandCenterHz([0.5, 2]), 6)
    expect(BAND_GAMMA_HZ_HI).toBeCloseTo(bandCenterHz([64, 128]), 6)
  })
})