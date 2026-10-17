/**
 * Тесты полосной гаммы пакета (п.1, 17.10.2026): цвета red→violet и длины
 * векторов, обратно зависимые от частот полос.
 *
 * Проверяется то, на чём держится читаемость мультиполосной анимации: одна и та
 * же полоса всегда одного цвета (цвет — адрес полосы на фигуре), дельта — самый
 * длинный красный вектор, высокая гамма — самый короткий ярко-фиолетовый, а
 * «свои» диапазоны получают детерминированный цвет по своим границам.
 */
import { describe, expect, it } from 'vitest'
import {
  BAND_COLOR_LIGHTNESS,
  BAND_COLOR_SATURATION,
  BAND_GAMMA_HZ_HI,
  BAND_GAMMA_HZ_LO,
  BAND_HUE_HI,
  BAND_HUE_LO,
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

/** Оттенок из строки `hsl(H, S%, L%)`. */
function hueOf(color: string): number {
  const match = /^hsl\(([-\d.]+), (\d+)%, (\d+)%\)$/.exec(color)
  expect(match).not.toBeNull()
  return Number(match?.[1])
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

  it('красит полосы гаммой от красного до ярко-фиолетового', () => {
    expect(hueOf(bandColor([0.5, 2]))).toBeCloseTo(BAND_HUE_LO, 6)
    expect(hueOf(bandColor([64, 128]))).toBeCloseTo(BAND_HUE_HI, 6)
    // Оттенок растёт с частотой — полосы не «перемешиваются» в гамме
    for (let index = 1; index < FREQ_BANDS.length; index++) {
      expect(hueOf(bandColor(FREQ_BANDS[index][1]))).toBeGreaterThan(
        hueOf(bandColor(FREQ_BANDS[index - 1][1])),
      )
    }
    // Яркость/насыщенность постоянные: различаются оттенком, а не светлотой
    for (const [, bandHz] of FREQ_BANDS) {
      expect(bandColor(bandHz)).toContain(`${BAND_COLOR_SATURATION}%, ${BAND_COLOR_LIGHTNESS}%`)
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