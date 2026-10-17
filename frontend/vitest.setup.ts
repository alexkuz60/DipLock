/**
 * Настройка jsdom для Vitest: матчеры jest-dom + изоляция между тестами.
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import type { MockUPlotChart } from './src/test/uplot'

/**
 * Таймаут `findBy*`/`waitFor` (дефолт Testing Library — 1 с) поднят до 10 с:
 * под нагрузкой `vitest-coverage` в CI ожидание мок-ответа `/meta` + ре-рендер
 * не укладывалось в секунду и тест падал «Unable to find…» (флейк 17.10.2026,
 * AppShell «аккордеоны EDF»). Потолок остаётся ниже `testTimeout` 15 с
 * (`vitest.config.ts`): реально зависший поиск виден, а не маскируется.
 */
configure({ asyncUtilTimeout: 10_000 })

/**
 * jsdom не реализует ResizeObserver, а вьюер треков меряет им ширину области треков
 * (высота развёрнутого — фикс ×8, её замерять не нужно). Заглушка сразу
 * сообщает размер, иначе чарты в тестах не создаются.
 */
class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    callback(
      [{ contentRect: { width: 1024, height: 600 } } as unknown as ResizeObserverEntry],
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
  var __uplotCharts: MockUPlotChart[]
}

const chartInstances: MockUPlotChart[] = []
globalThis.__uplotCharts = chartInstances

/**
 * uPlot не работает в jsdom: его модуль при импорте обращается к matchMedia и
 * рисует в 2D-контексте canvas. Мок сохраняет контракт (setData/setScale/
 * setSize/destroy), а тесты проверяют данные, которые в него уходят.
 *
 * `posToVal`/`valToPos` — обратимая пара «canvas-пиксели ↔ мкВ» (300 − x):
 * прямая и обратная обязаны совпадать, иначе линия уровня уедет от клика.
 * Статика `pxRatio` = 1, `options` запоминаются для проверки хуков отрисовки
 * (нулевая линия развёрнутого трека).
 */
vi.mock('uplot', () => ({
  default: class MockUPlot {
    static pxRatio = 1
    options: MockUPlotChart['options']
    setData = vi.fn()
    setScale = vi.fn()
    setSize = vi.fn()
    destroy = vi.fn()
    posToVal = vi.fn((pos: number) => 300 - pos)
    valToPos = vi.fn((val: number) => 300 - val)
    constructor(options?: MockUPlotChart['options']) {
      this.options = options ?? {}
      chartInstances.push(this as unknown as MockUPlotChart)
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
