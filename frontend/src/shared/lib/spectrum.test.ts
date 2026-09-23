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
  bandInFreqWindow,
  bandLabel,
  bandRangeLabel,
  clampFreqWindow,
  formatPower,
  freqRange,
  freqWindowLabel,
  histogramBars,
  normalizeFreqWindow,
  psdPolyline,
  psdScale,
  rangeSummary,
  spectrumMetrics,
  spectrumQueryOf,
  spectrumQueryString,
  spectrumSummary,
  spectrumWithinWindow,
  topomapUrl,
} from './spectrum'

const QUERY = {
  filterBandHz: [1, 40] as [number, number],
  notchHz: 50,
  epochLengthMs: 1000,
}

function band(overrides: Partial<SpectrumBandOut> = {}): SpectrumBandOut {
  return {
    name: 'alpha',
    fmin: 8,
    fmax: 13,
    power_uv2: 12.5,
    relative_power: 0.55,
    median_power_uv2: 12.2,
    q25_power_uv2: 11.0,
    q75_power_uv2: 13.4,
    topomap_url: '/api/v1/recordings/rec-1/spectrum/topomap/alpha.png',
    ...overrides,
  }
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
    freqs: [1, 10, 40],
    psd_mean_uv2: [1, 100, 2],
    bands: [band()],
    iaf_hz: 10.2,
    theta_beta_ratio: 0.78,
    theta_alpha_beta_ratio: 3.56,
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
      'band_min=1&band_max=40&notch_hz=50&epoch_length_ms=1000',
    )
    expect(spectrumQueryString({ ...QUERY, filterBandHz: null, notchHz: null })).toBe(
      'epoch_length_ms=1000',
    )
  })

  it('в URL топокарты кладёт параметры расчёта и версию ассета', () => {
    const url = topomapUrl(spectrum(), band(), QUERY)

    expect(url).toBe(
      '/api/v1/recordings/rec-1/spectrum/topomap/alpha.png?band_min=1&band_max=40&notch_hz=50&epoch_length_ms=1000&v=abc123',
    )
    // Смена фильтра меняет URL — браузер не подставит картинку прошлого расчёта
    expect(topomapUrl(spectrum(), band(), { ...QUERY, filterBandHz: [4, 8] })).toContain(
      'band_min=4&band_max=8',
    )
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
    const points = psdPolyline([1, 10, 40], [1, 100, 2], 100, 50)
      .split(' ')
      .map((pair) => pair.split(',').map(Number))

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
    const query = spectrumQueryOf(
      spectrum({ epoch_length_ms: 500, notch_hz: 60, filter_band_hz: [4, 8] }),
    )

    expect(query).toEqual({
      filterBandHz: [4, 8],
      notchHz: 60,
      epochLengthMs: 500,
    })
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
    expect(rangeSummary({ filterBandHz: null, epochLengthMs: 2000 })).toBe(
      'без фильтра · эпоха 2000 мс',
    )
  })
})

/**
 * Окно частот (срез 3.5) — параметр **просмотра**: оно срезает уже посчитанные
 * числа, зажимается в частоты текущего расчёта и не меняет масштаб логарифма.
 */
describe('окно частот FFT-графика (срез 3.5)', () => {
  const FREQS = [1, 4, 8, 10, 13, 30, 40]
  const PSD = [1, 2, 6, 12, 4, 2, 1]

  it('приводит ввод пользователя к паре «от … до» и отбрасывает мусор', () => {
    expect(normalizeFreqWindow([13, 8])).toEqual([8, 13])
    expect(normalizeFreqWindow([8.04, 12.96])).toEqual([8, 13])
    expect(normalizeFreqWindow(null)).toBeNull()
    expect(normalizeFreqWindow([Number.NaN, 10])).toBeNull()
    expect(normalizeFreqWindow([0, Number.POSITIVE_INFINITY])).toBeNull()
  })

  it('зажимает окно в измеренный диапазон и без окна показывает весь спектр', () => {
    // Окно живёт в предпочтениях просмотра и переживает смену записи: чужое окно
    // не должно показать пустой график вместо всего посчитанного спектра
    expect(clampFreqWindow(FREQS, null)).toEqual([1, 40])
    expect(clampFreqWindow(FREQS, [8, 13])).toEqual([8, 13])
    expect(clampFreqWindow(FREQS, [-50, 500])).toEqual([1, 40])
    expect(clampFreqWindow(FREQS, [30, 100])).toEqual([30, 40])
    expect(clampFreqWindow([], [8, 13])).toEqual([0, 1])
  })

  it('срезает частоты и мощности вместе, не сдвигая их друг относительно друга', () => {
    const alpha = spectrumWithinWindow(FREQS, PSD, [8, 13])

    expect(alpha.freqs).toEqual([8, 10, 13])
    // Мощность берётся по тем же индексам, что и частота: 6, 12, 4 — а не «первые три»
    expect(alpha.power).toEqual([6, 12, 4])
    // Без окна массивы уходят как есть (ни одной копии «на всякий случай»)
    expect(spectrumWithinWindow(FREQS, PSD, null)).toEqual({ freqs: FREQS, power: PSD })
    // Окно уже измеренной частоты — честный пустой результат, а не подмена на весь спектр
    expect(spectrumWithinWindow(FREQS, PSD, [5, 7]).freqs).toEqual([])
  })

  it('держит масштаб логарифма по всему спектру: пики не «прыгают» при сужении окна', () => {
    const scale = psdScale(PSD)
    const full = psdPolyline(FREQS, PSD, 100, 50, 2, scale)
    const alpha = spectrumWithinWindow(FREQS, PSD, [8, 13])
    const zoomed = psdPolyline(alpha.freqs, alpha.power, 100, 50, 2, scale)
    const yAt = (points: string, index: number) => Number(points.split(' ')[index].split(',')[1])

    // Точка альфа-пика (12 мкВ²/Гц) в полном спектре и в окне — на одной высоте
    expect(yAt(zoomed, 1)).toBeCloseTo(yAt(full, 3), 6)

    // Окно, в которое максимум спектра не попал: без общего масштаба δ-пик
    // «подтянулся» бы к верху области, и окно выглядело бы «как весь спектр»
    const delta = spectrumWithinWindow(FREQS, PSD, [1, 4])
    const deltaScaled = psdPolyline(delta.freqs, delta.power, 100, 50, 2, scale)
    const deltaNaive = psdPolyline(delta.freqs, delta.power, 100, 50)
    expect(yAt(deltaNaive, 1)).toBeLessThan(yAt(deltaScaled, 1))
    // Масштаб один на оба графика: δ в окне и δ в полном спектре совпадают по высоте
    expect(yAt(deltaScaled, 1)).toBeCloseTo(yAt(full, 1), 6)
  })

  it('подписывает окно и считает, какие ритмы в него попали', () => {
    expect(freqWindowLabel(null, [1, 40])).toBe('Весь диапазон: 1–40 Гц')
    expect(freqWindowLabel([8, 13], [1, 40])).toBe('Показано 8–13 Гц из 1–40 Гц')

    expect(bandInFreqWindow({ fmin: 8, fmax: 13 }, null)).toBe(true)
    expect(bandInFreqWindow({ fmin: 8, fmax: 13 }, [8, 13])).toBe(true)
    // Полосы, лежащие за границей окна, не «прилипают» к нему: δ заканчивается на 4
    expect(bandInFreqWindow({ fmin: 1, fmax: 4 }, [8, 13])).toBe(false)
    expect(bandInFreqWindow({ fmin: 13, fmax: 30 }, [8, 13])).toBe(false)
  })

  it('помечает полосы гистограммы, попавшие в окно, но нормирует по всему спектру', () => {
    const bands = [
      band({ name: 'alpha', fmin: 8, fmax: 13, power_uv2: 10 }),
      band({ name: 'beta', fmin: 13, fmax: 30, power_uv2: 5 }),
    ]
    const bars = histogramBars(bands, [8, 13])

    expect(bars.map((bar) => bar.inRange)).toEqual([true, false])
    // Нормировка — по всем диапазонам, даже вне окна: иначе высота столбиков
    // зависела бы от выбранного окна, и сравнить ритмы было бы нельзя
    expect(bars[0].ratio).toBe(1)
    expect(bars[1].ratio).toBe(0.5)
    expect(histogramBars(bands).every((bar) => bar.inRange)).toBe(true)
  })
})

test('spectrumMetrics форматирует IAF и θ/β-индексы, пропуская null (N16)', () => {
  expect(spectrumMetrics(spectrum())).toEqual(['IAF 10.2 Гц', 'θ/β 0.78', '(θ+α)/β 3.56'])
  expect(
    spectrumMetrics(
      spectrum({ iaf_hz: null, theta_beta_ratio: null, theta_alpha_beta_ratio: null }),
    ),
  ).toEqual([])
})
