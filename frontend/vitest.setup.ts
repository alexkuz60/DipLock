/**
 * Настройка jsdom для Vitest: матчеры jest-dom + изоляция между тестами.
 */
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * jsdom не реализует ResizeObserver, а вьюер треков измеряет им ширину области.
 * Заглушка сразу сообщает ширину, иначе чарты в тестах не создаются.
 */
class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    callback(
      [{ contentRect: { width: 1024 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

/** Созданные в тестах чарты uPlot (доступны тестам через `uplotCharts()`). */
declare global {
  var __uplotCharts: { destroy: () => void }[]
}

const chartInstances: { destroy: () => void }[] = []
globalThis.__uplotCharts = chartInstances

/**
 * uPlot не работает в jsdom: его модуль при импорте обращается к matchMedia и
 * рисует в 2D-контексте canvas. Мок сохраняет контракт (setData/setScale/
 * setSize/destroy), а тесты проверяют данные, которые в него уходят.
 */
vi.mock('uplot', () => ({
  default: class MockUPlot {
    setData = vi.fn()
    setScale = vi.fn()
    setSize = vi.fn()
    destroy = vi.fn()
    constructor() {
      chartInstances.push(this)
    }
  },
}))
vi.mock('uplot/dist/uPlot.min.css', () => ({}))

afterEach(() => {
  chartInstances.length = 0
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
