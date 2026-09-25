/**
 * Геометрия графика АЧХ (шаг 2.5): чистая функция — тестируется без DOM.
 */
import { describe, expect, it } from 'vitest'
import { CHART_MIN_DB, filterPassportText, responseChart } from './filterResponseChart'
import { filterResponseFixture } from '@/test/fixtures'

function xsOf(points: string): number[] {
  return points
    .split(' ')
    .filter(Boolean)
    .map((pair) => Number(pair.split(',')[0]))
}

describe('responseChart', () => {
  it('широкую полосу показывает целиком с запасом на обрезы', () => {
    const geometry = responseChart(filterResponseFixture())
    expect(geometry.xDomain[0]).toBe(0)
    expect(geometry.xDomain[1]).toBeGreaterThan(40)
    expect(geometry.xDomain[1]).toBeLessThan(250)
    expect(geometry.passband).not.toBeNull()
    expect(geometry.passband!.width).toBeGreaterThan(10)
    // 50 Гц в домене — метка notch есть
    expect(geometry.notchMarks).toHaveLength(1)
    expect(geometry.notchMarks[0]).toBeGreaterThan(0)
    expect(geometry.notchMarks[0]).toBeLessThan(geometry.width)
  })

  it('узкую полосу разворачивает на экран', () => {
    const geometry = responseChart(
      filterResponseFixture({ band_hz: [7.58, 8.08], notch_freqs: [] }),
    )
    const span = geometry.xDomain[1] - geometry.xDomain[0]
    expect(span).toBeLessThan(5) // 5.58…10.08, а не 0…250
    expect(geometry.xDomain[0]).toBeCloseTo(5.58, 1)
    // Точки только внутри домена: хвосты общей сетки не рисуются через кадр
    const xs = xsOf(geometry.points)
    expect(xs.length).toBeGreaterThan(5)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThanOrEqual(geometry.width)
  })

  it('сетка дБ прижимает глубокие провалы к полу, но полосу не трогает', () => {
    const geometry = responseChart(filterResponseFixture())
    const yTicks = geometry.yTicks.map((tick) => tick.label)
    expect(yTicks).toContain('0')
    expect(yTicks).toContain('-60')
    expect(geometry.yDomain[0]).toBe(CHART_MIN_DB)
  })
})

describe('filterPassportText', () => {
  it('FIR называет метод, ядро и краевой буфер (N11/N12)', () => {
    const text = filterPassportText(filterResponseFixture())
    expect(text).toContain('FIR')
    expect(text).toContain('ядро 3.30 с')
    expect(text).toContain('краевой буфер ±1.65 с')
    expect(text).toContain('notch: 50 Гц')
  })

  it('IIR честно сообщает, что края не режутся', () => {
    const text = filterPassportText(
      filterResponseFixture({
        method: 'iir',
        filter_length_sec: null,
        edge_buffer_sec: 0,
        l_trans_bandwidth_hz: null,
        h_trans_bandwidth_hz: null,
        band_hz: [7.58, 8.08],
        notch_freqs: [],
      }),
    )
    expect(text).toContain('IIR')
    expect(text).toContain('края не режутся')
    expect(text).not.toMatch(/ядро \d/) // длины ядра у IIR контракт не даёт
  })
})