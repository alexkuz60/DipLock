/**
 * Тесты арифметики спектра и топокарт (срез 3.4).
 *
 * Проверяется контракт с сервером: URL топокарты несёт параметры **того же**
 * расчёта и версию ассета (иначе браузер покажет картинку прошлого фильтра),
 * неизмеренная мощность — «—», а не «0,00», а логарифмическая шкала PSD не
 * «схлопывает» слабые ритмы в прямую линию.
 */
import { describe, expect, it } from 'vitest'
import type { SpectrumBandOut, SpectrumResult } from '@/shared/api/types'
import {
  bandLabel,
  bandRangeLabel,
  formatPower,
  freqRange,
  histogramBars,
  psdPolyline,
  rangeSummary,
  spectrumQueryOf,
  spectrumQueryString,
  spectrumSummary,
  topomapUrl,
} from './spectrum'

const QUERY = { filterBandHz: [1, 40] as [number, number], notchHz: 50, epochLengthMs: 1000, rejectThresholdUv: 150 }

function band(overrides: Partial<SpectrumBandOut> = {}): SpectrumBandOut {
  return { name: 'alpha', fmin: 8, fmax: 13, power_uv2: 12.5, topomap_url: '/api/v1/recordings/rec-1/spectrum/topomap/alpha.png', ...overrides }
}

function spectrum(overrides: Partial<SpectrumResult> = {}): SpectrumResult {
  return {
    recording_id: 'rec-1',
    channels: ['Fp1', 'Fp2'],
    missed_channels: [],
    sfreq: 500,
    epoch_length_ms: 1000,
    n_epochs: 5,
    n_fft: 256,
    filter_band_hz: [1, 40],
    notch_hz: 50,
    reject_threshold_uv: 150,
    freqs: [1, 10, 40],
    psd_mean_uv2: [1, 100, 2],
    bands: [band()],
    topomap_version: 'abc123',
    warnings: [],
    duration_sec_calc: 0.4,
    ...overrides,
  }
}

describe('спектр по диапазонам', () => {
  it('подписывает ритмы по-русски, а неизвестный ключ показывает как есть', () => {
    expect(bandLabel('alpha')).toContain('альфа')
    expect(bandLabel('omega')).toBe('omega')
    expect(bandRangeLabel(band())).toBe('8–13 Гц')
  })

  it('собирает строку запроса топокарты из параметров расчёта', () => {
    expect(spectrumQueryString(QUERY)).toBe(
      'band_min=1&band_max=40&notch_hz=50&epoch_length_ms=1000&reject_threshold_uv=150',
    )
    expect(spectrumQueryString({ ...QUERY, filterBandHz: null, notchHz: null })).toBe(
      'epoch_length_ms=1000&reject_threshold_uv=150',
    )
  })

  it('в URL топокарты кладёт параметры расчёта и версию ассета', () => {
    const url = topomapUrl(spectrum(), band(), QUERY)

    expect(url).toBe(
      '/api/v1/recordings/rec-1/spectrum/topomap/alpha.png?band_min=1&band_max=40&notch_hz=50&epoch_length_ms=1000&reject_threshold_uv=150&v=abc123',
    )
    // Смена фильтра меняет URL — браузер не подставит картинку прошлого расчёта
    expect(topomapUrl(spectrum(), band(), { ...QUERY, filterBandHz: [4, 8] })).toContain('band_min=4&band_max=8')
  })

  it('не выдумывает URL, если сервер картинку не построил', () => {
    expect(topomapUrl(spectrum(), band({ topomap_url: null }), QUERY)).toBeNull()
  })

  it('показывает «—» вместо нуля, когда мощность не измерена', () => {
    expect(formatPower(12.345)).toBe('12.35')
    expect(formatPower(null)).toBe('—')
    expect(formatPower(undefined)).toBe('—')
    expect(formatPower(Number.NaN)).toBe('—')
  })

  it('нормирует полосы гистограммы по максимальной мощности', () => {
    const bars = histogramBars([
      band({ name: 'alpha', power_uv2: 10 }),
      band({ name: 'beta', power_uv2: 5 }),
      band({ name: 'gamma', power_uv2: null }),
    ])

    expect(bars.map((bar) => bar.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(bars[0].ratio).toBe(1)
    expect(bars[1].ratio).toBe(0.5)
    expect(bars[2].missing).toBe(true)
    expect(bars[2].ratio).toBe(0)
  })

  it('рисует PSD ломаной линией в габаритах 2D-области', () => {
    const points = psdPolyline([1, 10, 40], [1, 100, 2], 100, 50).split(' ').map((pair) => pair.split(',').map(Number))

    expect(points).toHaveLength(3)
    // Левая точка — у левого края, правая — у правого
    expect(points[0][0]).toBeCloseTo(2, 5)
    expect(points[2][0]).toBeCloseTo(98, 5)
    // Максимум PSD поднят вверх: меньший y = выше точка
    expect(points[1][1]).toBeLessThan(points[0][1])
    expect(points[1][1]).toBeLessThan(points[2][1])
    // Логарифм: слабые ритмы не «схлопываются» в нижнюю границу
    expect(points[2][1]).toBeLessThan(50)
  })

  it('не падает на несовпадающих массивах и коротком сигнале', () => {
    expect(psdPolyline([1], [1], 100, 50)).toBe('')
    expect(psdPolyline([1, 2, 3], [1, 2], 100, 50)).toBe('')
  })

  it('берёт параметры для URL топокарт из самого результата, а не из настроек', () => {
    // Смена длины эпохи после расчёта не должна менять URL картинки: картинка
    // относится к тому расчёту, чьи числа показаны рядом (и к своему ETag).
    const query = spectrumQueryOf(spectrum({ epoch_length_ms: 500, notch_hz: 60, filter_band_hz: [4, 8] }))

    expect(query).toEqual({ filterBandHz: [4, 8], notchHz: 60, epochLengthMs: 500, rejectThresholdUv: 150 })
    expect(spectrumQueryOf(spectrum({ filter_band_hz: null })).filterBandHz).toBeNull()
    // Битые/короткие массивы полосы не превращаются в «диапазон из одного числа»
    expect(spectrumQueryOf(spectrum({ filter_band_hz: [1] })).filterBandHz).toBeNull()
  })

  it('берёт пределы частотной оси из фактических частот расчёта', () => {
    expect(freqRange([1, 4, 40])).toEqual([1, 40])
    expect(freqRange([])).toEqual([0, 1])
  })

  it('подписывает результат спектра параметрами своего расчёта', () => {
    expect(spectrumSummary(spectrum())).toBe('Спектр: 1–40 Гц · эпоха 1000 мс · окно 256 · эпох 5')
    // Без фильтра подпись честно это сообщает, а не «молчит» о полосе
    expect(spectrumSummary(spectrum({ filter_band_hz: null }))).toBe(
      'Спектр: без фильтра · эпоха 1000 мс · окно 256 · эпох 5',
    )
  })

  it('подписывает параметры расчёта для панели', () => {
    expect(rangeSummary(QUERY)).toBe('1–40 Гц · эпоха 1000 мс')
    expect(rangeSummary({ filterBandHz: null, epochLengthMs: 2000 })).toBe('без фильтра · эпоха 2000 мс')
  })
})
