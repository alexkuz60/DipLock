/**
 * Доступ к чартам uPlot, созданным в тестах.
 *
 * Реальный uPlot в jsdom не поднимается (matchMedia + canvas), поэтому мок
 * объявлен в `vitest.setup.ts`, а здесь — типизированный доступ к инстансам.
 */
import type { Mock } from 'vitest'

export type MockUPlotChart = {
  setData: Mock
  setScale: Mock
  setSize: Mock
  destroy: Mock
}

export function uplotCharts(): MockUPlotChart[] {
  return (globalThis as unknown as { __uplotCharts: MockUPlotChart[] }).__uplotCharts
}
