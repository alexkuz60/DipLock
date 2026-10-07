/**
 * Тесты подписей полос «Нейромузыки»: сортировка комбо выбора сигнала по
 * возрастанию частоты (приёмка 07.10.2026).
 */
import { describe, expect, it } from 'vitest'
import { BAND_ORDER, bandLabel, sortBandsByFrequency } from './bandLabels'

describe('bandLabels — порядок полос в комбо «Сигнал»', () => {
  it('перемешанный список сортируется: δ → δ/θ → θ → α → β → γ → γ-high', () => {
    const shuffled = ['gamma', 'delta', 'high_gamma', 'alpha', 'theta', 'beta', 'delta_theta']
    expect(sortBandsByFrequency(shuffled)).toEqual([...BAND_ORDER])
  })

  it('отсортированный список не меняется, неизвестные ключи уходят в конец', () => {
    expect(sortBandsByFrequency([...BAND_ORDER])).toEqual([...BAND_ORDER])
    expect(sortBandsByFrequency(['weird', 'alpha', 'delta'])).toEqual(['delta', 'alpha', 'weird'])
    expect(bandLabel('weird')).toBe('weird')
  })
})