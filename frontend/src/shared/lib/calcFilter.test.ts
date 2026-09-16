/**
 * Тесты формы фильтров расчёта (срез 3.6).
 *
 * Проверяется главное свойство формы: **в задачу уходит полоса**, а пресеты
 * лишь выбирают её. Поэтому тесты держат три вещи: диапазоны ритмов берутся из
 * метаданных сервера (и не выдумываются, если ритма там нет), полоса приводится
 * к разумному виду (порядок, округление, зажим, «пустая» полоса = без фильтра), а
 * выбранный пресет **выводится** из полосы — подпись не может разойтись с
 * запросом.
 */
import { describe, expect, it } from 'vitest'
import {
  BANDWIDTH_RANGE,
  SINGLE_FREQ_RANGE,
  bandForPreset,
  filterBandText,
  filterPresetIsValid,
  filterPresetLabel,
  filterPresetOf,
  filterPresetOptions,
  filterSummary,
  normalizeFilterBand,
  normalizeNotchHz,
  notchFromOption,
  notchOptionValue,
  presetBand,
  singleFreqBand,
  type CalcFilterParams,
} from './calcFilter'

/** Диапазоны ритмов так, как их отдаёт `/meta` (фикстура бэкенда). */
const FREQ_BANDS: Record<string, number[]> = {
  delta: [1, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta: [13, 30],
  gamma: [30, 40],
}

function filterParams(overrides: Partial<CalcFilterParams> = {}): CalcFilterParams {
  return {
    filterPreset: 'custom',
    filterBandHz: [1, 40],
    notchHz: null,
    singleFreqHz: 7.83,
    bandwidthHz: 0.5,
    ...overrides,
  }
}

describe('форма фильтров расчёта', () => {
  it('собирает пресеты ритмов из метаданных сервера', () => {
    const options = filterPresetOptions(FREQ_BANDS)

    expect(options.map((option) => option.value)).toEqual([
      'band_1_40',
      'delta',
      'theta',
      'alpha',
      'beta',
      'gamma',
      'single',
      'custom',
      'none',
    ])
    // Подпись несёт границы с сервера: «α — альфа 8–13 Гц», а не «альфа» без чисел
    expect(options.find((option) => option.value === 'alpha')?.label).toBe('α — альфа 8–13 Гц')
    expect(options.find((option) => option.value === 'alpha')?.band).toEqual([8, 13])
  })

  it('не выдумывает диапазон ритма, которого нет в конфиге сервера', () => {
    const options = filterPresetOptions({ alpha: [8, 13] })

    expect(options.map((option) => option.value)).toEqual([
      'band_1_40',
      'alpha',
      'single',
      'custom',
      'none',
    ])
    // Полосы пресета нет — пресет не «работает по памяти», а просто отсутствует
    expect(presetBand('delta', { alpha: [8, 13] })).toBeNull()
    expect(presetBand('alpha', { alpha: [8, 13] })).toEqual([8, 13])
  })

  it('приводит полосу к порядку, округлению и границам контролов', () => {
    expect(normalizeFilterBand([13, 8])).toEqual([8, 13])
    expect(normalizeFilterBand([8.04, 12.96])).toEqual([8, 13])
    expect(normalizeFilterBand([-5, 200])).toEqual([0.1, 100])
    // Пустая полоса — это «без фильтра»: фильтр нулевой ширины задача не примет
    expect(normalizeFilterBand([8, 8])).toBeNull()
    expect(normalizeFilterBand([Number.NaN, 10])).toBeNull()
    expect(normalizeFilterBand(null)).toBeNull()
    expect(normalizeFilterBand([])).toBeNull()
  })

  it('считает полосу одиночной частоты как f ± bw/2', () => {
    expect(singleFreqBand(7.83, 0.5)).toEqual([7.6, 8.1])
    expect(singleFreqBand(7.83, 1)).toEqual([7.3, 8.3])
    // Частота и ширина зажаты своими границами: полоса не уходит в отрицательные
    const clampedLow = singleFreqBand(0.1, 10)
    expect(clampedLow?.[0]).toBe(0.1)
    expect(clampedLow?.[1]).toBeLessThanOrEqual(SINGLE_FREQ_RANGE[1])
    // Слишком узкая ширина не превращает полосу в пустую (фильтр «0 Гц»)
    expect(singleFreqBand(7.83, 0.001)).toEqual([7.8, 7.9])
    expect(BANDWIDTH_RANGE[0]).toBeLessThan(BANDWIDTH_RANGE[1])
  })

  it('выводит пресет из полосы, а не из «выбранного ранее»', () => {
    const presetOf = (band: [number, number] | null) =>
      filterPresetOf(filterParams({ filterBandHz: band }), FREQ_BANDS)

    expect(presetOf(null)).toBe('none')
    expect(presetOf([1, 40])).toBe('band_1_40')
    expect(presetOf([8, 13])).toBe('alpha')
    expect(presetOf([7.6, 8.1])).toBe('single')
    // Ни ритм, ни одиночная частота: полосу задали руками
    expect(presetOf([5, 20])).toBe('custom')
  })

  it('выбор пресета даёт его полосу, а поля «одиночной» и «своей» помнятся', () => {
    const params = filterParams()
    expect(bandForPreset(params, 'alpha', FREQ_BANDS)).toEqual([8, 13])
    expect(bandForPreset(params, 'band_1_40', FREQ_BANDS)).toEqual([1, 40])
    expect(bandForPreset(params, 'none', FREQ_BANDS)).toBeNull()
    expect(bandForPreset(params, 'single', FREQ_BANDS)).toEqual([7.6, 8.1])

    // «Свой диапазон» открывается на текущей полосе; от «без фильтра» — на 1–40
    expect(bandForPreset(filterParams({ filterBandHz: [5, 20] }), 'custom', FREQ_BANDS)).toEqual([
      5, 20,
    ])
    expect(bandForPreset(filterParams({ filterBandHz: null }), 'custom', FREQ_BANDS)).toEqual([
      1, 40,
    ])
  })

  it('держит сетевой фильтр только на 50 и 60 Гц', () => {
    expect(normalizeNotchHz(50)).toBe(50)
    expect(normalizeNotchHz(60)).toBe(60)
    // Ближайшее известное значение: список и состояние не разъезжаются
    expect(normalizeNotchHz(55)).toBe(50)
    expect(normalizeNotchHz(0)).toBeNull()
    expect(normalizeNotchHz(null)).toBeNull()

    expect(notchOptionValue(60)).toBe('60')
    expect(notchOptionValue(null)).toBe('none')
    expect(notchFromOption('50')).toBe(50)
    expect(notchFromOption('none')).toBeNull()
  })

  it('описывает в итоге именно то, что уйдёт в задачу', () => {
    const alpha: Pick<CalcFilterParams, 'filterPreset' | 'filterBandHz'> = {
      filterPreset: 'alpha',
      filterBandHz: [8, 13],
    }
    expect(filterSummary(filterParams({ ...alpha, notchHz: 50 }), FREQ_BANDS)).toBe(
      'α — альфа 8–13 Гц · сетевой фильтр 50 Гц',
    )
    expect(
      filterSummary(filterParams({ filterPreset: 'single', filterBandHz: [7.6, 8.1] }), FREQ_BANDS),
    ).toBe('одиночная частота 7.83 Гц (полоса 7.6–8.1 Гц, ширина 0.5 Гц) · без сетевого фильтра')
    expect(
      filterSummary(filterParams({ filterPreset: 'none', filterBandHz: null }), FREQ_BANDS),
    ).toBe('без полосового фильтра · без сетевого фильтра')
    expect(
      filterSummary(filterParams({ filterPreset: 'custom', filterBandHz: [5, 20] }), FREQ_BANDS),
    ).toBe('свой диапазон 5–20 Гц · без сетевого фильтра')
  })

  it('печатает в итоге полосу, а не «обещанные» числа из названия ритма', () => {
    // Диапазоны ритмов на сервере изменились после сохранения выбора: подпись
    // показывает фактические границы расчёта, а не старые числа из подписи пункта
    expect(
      filterSummary(filterParams({ filterPreset: 'alpha', filterBandHz: [8, 12] }), FREQ_BANDS),
    ).toBe('α — альфа 8–12 Гц · без сетевого фильтра')
  })

  it('отличает пресет от значения из localStorage, которого не знает', () => {
    expect(filterPresetIsValid('alpha')).toBe(true)
    expect(filterPresetIsValid('none')).toBe(true)
    expect(filterPresetIsValid('band_1_40')).toBe(true)
    expect(filterPresetIsValid('gamma_2')).toBe(false)
    expect(filterPresetIsValid('')).toBe(false)
  })

  it('подписывает полосу и пресет для панели', () => {
    expect(filterBandText([1, 40])).toBe('1–40 Гц')
    expect(filterBandText(null)).toBe('без фильтра')
    expect(filterBandText([8.5, 13])).toBe('8.5–13 Гц')
    expect(filterPresetLabel('gamma', FREQ_BANDS)).toBe('γ — гамма 30–40 Гц')
  })
})
