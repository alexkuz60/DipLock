import { describe, expect, it } from 'vitest'
import { mainsChart, mainsLevelsText } from './mainsChart'
import { mainsFixture } from '@/test/fixtures'

describe('mainsChart (геометрия SVG сетевого фона)', () => {
  it('строит polyline и симметричный диапазон вокруг нуля', () => {
    const mains = mainsFixture()
    const geometry = mainsChart(mains)

    expect(geometry.points.length).toBeGreaterThan(0)
    expect(geometry.xDomain[0]).toBe(mains.start_sec)
    const [lo, hi] = geometry.yDomain
    expect(lo).toBeCloseTo(-hi)
    expect(Math.abs(lo)).toBeGreaterThanOrEqual(1) // минимум ±1 мкВ
    expect(geometry.xTicks).toHaveLength(4)
    expect(geometry.yTicks).toHaveLength(3)
  })

  it('декадимация min/max сохраняет экстремум волны', () => {
    const values: number[] = []
    const times: number[] = []
    for (let i = 0; i < 5000; i++) {
      times.push(i / 500)
      values.push(Math.sin(i / 40))
    }
    values[1234] = -42 // явный экстремум в середине
    const geometry = mainsChart(
      { trace_times_sec: times, trace_uv: values, start_sec: 0, duration_sec: 10 },
      320,
      110,
      480,
    )

    expect(geometry.yDomain[1]).toBeGreaterThanOrEqual(42)
    // −42 — на нижней границе шкалы: y = height·(1 − (42+46.2)/92.4) = 105.0
    expect(geometry.points).toContain(',105.0')
  })

  it('пустая трасса не рисует точек, но держит домены', () => {
    const geometry = mainsChart({
      trace_times_sec: [],
      trace_uv: [],
      start_sec: 0,
      duration_sec: 5,
    })

    expect(geometry.points).toBe('')
    expect(geometry.xDomain).toEqual([0, 5])
    expect(geometry.yTicks).toHaveLength(0)
  })

  it('mainsLevelsText подписьывает дБ, «не измерено» — нулём', () => {
    expect(mainsLevelsText({ freqs_hz: [50, 100], level_db: [18.4, 0] })).toBe(
      '50 Гц +18.4 дБ · 100 Гц 0 дБ',
    )
  })
})
