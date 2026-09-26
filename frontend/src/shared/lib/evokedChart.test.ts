/** Геометрия графика ERP (шаг 2.7): чистая математика SVG без DOM. */
import { describe, expect, it } from 'vitest'
import { evokedChart } from '@/shared/lib/evokedChart'

describe('evokedChart', () => {
  const times = [-0.2, -0.1, 0, 0.1, 0.2]

  it('каждой точке волны соответствует точка полилинии', () => {
    const geometry = evokedChart(times, [0, 1, 2, 1, 0])
    expect(geometry.polyline.split(' ')).toHaveLength(times.length)
  })

  it('линия стимула стоит на t=0 внутри графика', () => {
    const geometry = evokedChart(times, [0, 1, 2, 1, 0])
    const [firstX] = geometry.polyline.split(',')[0]!.split(',').map(Number) as [number]
    const lastX = Number(geometry.polyline.split(' ').at(-1)!.split(',')[0])
    expect(geometry.zeroX).toBeGreaterThan(firstX)
    expect(geometry.zeroX).toBeLessThan(lastX)
  })

  it('шкала Y симметрична вокруг нуля и подписана', () => {
    const geometry = evokedChart(times, [0, 5, -10, 5, 0])
    const labels = geometry.yTicks.map((tick) => tick.label)
    expect(labels).toContain('0')
    expect(labels.some((label) => label.startsWith('+'))).toBe(true)
    expect(labels.some((label) => label.startsWith('-'))).toBe(true)
  })

  it('пустые данные не роняют геометрию', () => {
    const geometry = evokedChart([], [])
    expect(geometry.polyline).toBe('')
    expect(Number.isFinite(geometry.zeroX)).toBe(true)
  })
})
