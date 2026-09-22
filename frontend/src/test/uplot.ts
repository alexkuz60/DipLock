/**
 * Доступ к чартам uPlot, созданным в тестах.
 *
 * Реальный uPlot в jsdom не поднимается (matchMedia + canvas), поэтому мок
 * объявлен в `vitest.setup.ts`, а здесь — типизированный доступ к инстансам.
 */
import type { Mock } from 'vitest'

export type MockUPlotChart = {
  /** Опции, переданные конструктору: проверка хуков отрисовки (ноль, уровень). */
  options: { hooks?: Record<string, unknown[]> } & Record<string, unknown>
  setData: Mock
  setScale: Mock
  setSize: Mock
  destroy: Mock
  /** Обратимая пара «canvas-пиксели ↔ мкВ» (300 − x): прямая и обратная обязаны совпадать. */
  posToVal: Mock
  valToPos: Mock
}

export function uplotCharts(): MockUPlotChart[] {
  return (globalThis as unknown as { __uplotCharts: MockUPlotChart[] }).__uplotCharts
}
