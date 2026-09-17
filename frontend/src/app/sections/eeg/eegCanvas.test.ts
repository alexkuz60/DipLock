/**
 * Тесты отрисовки холстов раздела «ЭЭГ» (срез 5, поправки ручной проверки).
 *
 * Проверяется то, чего не видно на экране с масштабом 100 %: `ctx.putImageData` —
 * единственная операция canvas, которая **игнорирует** трансформацию контекста,
 * поэтому пиксели спектрограммы обязаны набираться в разрешении холста и
 * вставляться при единичной трансформации. Без этого на экране с
 * `devicePixelRatio ≠ 1` картинка занимала лишь `1 / dpr` ширины области графика:
 * спектрограмма обрывалась до правой линейки, а её ось, курсор и маркер частоты
 * уезжали за край картинки — ровно то, что было в ручной проверке.
 *
 * Здесь же метки клика: линия частоты и линия уровня (у них общая реализация, поэтому
 * общая и подпись у столбца линеек), нулевая линия сигнала и рамка окна трека на
 * «обзоре» (приглушено всё, чего на треке не видно). Canvas в jsdom не рисуется,
 * поэтому контекст подменяется записью вызовов — как в `exportWindow.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { EEG_LABEL_W, EEG_VALUE_W } from '@/shared/lib/eegView'
import {
  canvasScale,
  canvasTheme,
  drawFreqMarker,
  drawLevelMarker,
  drawNullLine,
  drawValueAxis,
  drawWindowFrame,
  putImageDataAt,
  setupCanvas,
} from './eegCanvas'

type Calls = {
  setTransform: unknown[][]
  putImageData: unknown[][]
  moveTo: unknown[][]
  lineTo: unknown[][]
  fillRect: unknown[][]
  fillText: unknown[][]
  clearRect: unknown[][]
  rect: unknown[][]
  setLineDash: unknown[][]
}

/** Подменный 2D-контекст: пишет вызовы (canvas в jsdom не рисуется). */
function fakeContext(bitmapHeight = 200): {
  ctx: CanvasRenderingContext2D
  calls: Calls
  canvas: HTMLCanvasElement
} {
  const calls: Calls = {
    setTransform: [],
    putImageData: [],
    moveTo: [],
    lineTo: [],
    fillRect: [],
    fillText: [],
    clearRect: [],
    rect: [],
    setLineDash: [],
  }
  const record = (key: keyof Calls) =>
    vi.fn((...args: unknown[]) => {
      calls[key].push(args)
    })
  const canvas = {
    width: 0,
    height: bitmapHeight,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement
  const ctx = {
    canvas,
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    stroke: vi.fn(),
    measureText: vi.fn(() => ({ width: 30 })),
    setTransform: record('setTransform'),
    putImageData: record('putImageData'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    fillRect: record('fillRect'),
    fillText: record('fillText'),
    clearRect: record('clearRect'),
    rect: record('rect'),
    setLineDash: record('setLineDash'),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D
  return { ctx, calls, canvas }
}

/** В jsdom `devicePixelRatio` всегда 1 — подменяем его на время проверки. */
function withDevicePixelRatio(ratio: number, body: () => void): void {
  const own = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio })
  try {
    body()
  } finally {
    if (own) Object.defineProperty(window, 'devicePixelRatio', own)
    else delete (window as unknown as Record<string, unknown>).devicePixelRatio
  }
}

describe('холсты раздела «ЭЭГ»', () => {
  it('берёт масштаб холста из devicePixelRatio', () => {
    expect(canvasScale()).toBe(1)
    withDevicePixelRatio(1.25, () => expect(canvasScale()).toBe(1.25))
  })

  it('задаёт размеры холста в bitmap-пикселях и масштаб рисования', () => {
    withDevicePixelRatio(2, () => {
      const { ctx, calls, canvas } = fakeContext()
      expect(setupCanvas(canvas, 100, 50)).toBe(ctx)
      expect(canvas.width).toBe(200)
      expect(canvas.height).toBe(100)
      expect(calls.setTransform).toEqual([[2, 0, 0, 2, 0, 0]])
      // Чистим именно область в CSS-координатах, а не bitmap
      expect(calls.clearRect).toEqual([[0, 0, 100, 50]])
    })
  })

  it('вставляет пиксели в bitmap-координатах: putImageData не знает про трансформацию', () => {
    withDevicePixelRatio(1.25, () => {
      const { ctx, calls } = fakeContext()
      const image = { width: 892, height: 276 } as ImageData
      putImageDataAt(ctx, image, 76, 0)
      // Трансформация снята только на время вставки: иначе пиксели легли бы в CSS-координаты
      expect(calls.setTransform).toEqual([[1, 0, 0, 1, 0, 0]])
      // 76 × 1.25 = 95: картинка начинается там же, где область графика на холсте
      expect(calls.putImageData).toEqual([[image, 95, 0]])
    })
  })

  it('при масштабе 1 пиксели ложатся как есть', () => {
    const { ctx, calls } = fakeContext()
    putImageDataAt(ctx, { width: 10, height: 10 } as ImageData, 76, 0)
    expect(calls.putImageData[0]?.[1]).toBe(76)
    expect(calls.putImageData[0]?.[2]).toBe(0)
  })

  it('рисует маркер частоты линией через область графика и значением в столбце линеек', () => {
    const { ctx, calls } = fakeContext()
    const theme = canvasTheme()
    // Токен фона подписи: подпись не сливается с делениями частот под ней
    expect(theme.panel).toBe('#121a24')

    drawFreqMarker(ctx, 40.2, '12.5 Гц', 1200, theme)
    const lineY = 40.5 // линия — по пиксельной сетке, как у курсора
    expect(calls.moveTo).toEqual([[EEG_LABEL_W, lineY]])
    expect(calls.lineTo).toEqual([[1200 - EEG_VALUE_W, lineY]])
    expect(calls.fillRect).toEqual([[1200 - EEG_VALUE_W, lineY - 8, 30 + 14, 16]])
    expect(calls.fillText).toEqual([['12.5 Гц', 1200 - EEG_VALUE_W + 7, lineY]])
  })

  it('тянет вертикаль линейки на высоту холста в CSS-пикселях', () => {
    withDevicePixelRatio(1.25, () => {
      const { ctx, calls } = fakeContext(250) // bitmap-высота = 200 CSS × 1.25
      drawValueAxis(ctx, [{ value: 50, y: 20, label: '50' }], 1200, canvasTheme(), 'мкВ')
      expect(calls.lineTo[0]).toEqual([1200 - EEG_VALUE_W, 200])
    })
  })

  it('рисует линию уровня трека так же, как линию частоты: подпись в столбце линеек', () => {
    const { ctx, calls } = fakeContext()
    drawLevelMarker(ctx, 100, '27 мкВ', 1200, canvasTheme())
    // Линия — по пиксельной сетке (как у курсора), подпись — в столбце значений
    expect(calls.moveTo).toEqual([[EEG_LABEL_W, 100.5]])
    expect(calls.lineTo).toEqual([[1200 - EEG_VALUE_W, 100.5]])
    expect(calls.fillRect).toEqual([[1200 - EEG_VALUE_W, 100.5 - 8, 30 + 14, 16]])
    expect(calls.fillText).toEqual([['27 мкВ', 1200 - EEG_VALUE_W + 7, 100.5]])
  })

  it('ведёт нулевую линию пунктиром через область графика', () => {
    const { ctx, calls } = fakeContext()
    // Середина трека — там же, где деление «0» линейки: шкала одна
    drawNullLine(ctx, 138, 1200, canvasTheme())
    expect(calls.moveTo).toEqual([[EEG_LABEL_W, 138.5]])
    expect(calls.lineTo).toEqual([[1200 - EEG_VALUE_W, 138.5]])
    // Пунктир отличает опорную линию от сплошных линий сетки (аргумент — массив)
    expect(calls.setLineDash).toEqual([[[5, 4]]])
  })

  it('приглушает всё вне рамки окна трека и подписывает саму рамку', () => {
    const { ctx, calls } = fakeContext()
    drawWindowFrame(ctx, { x0: 400, x1: 700 }, 1200, 300, canvasTheme())
    // Приглушение — по обе стороны рамки: внутри картинка остаётся полной
    expect(calls.fillRect).toEqual([
      [EEG_LABEL_W, 0, 400 - EEG_LABEL_W, 300],
      [700, 0, 1200 - EEG_VALUE_W - 700, 300],
    ])
    expect(calls.rect).toEqual([[400.5, 0.5, 299, 299]])
    expect(calls.fillText).toEqual([['окно трека', 405, 10]])
  })

  it('не подписывает узкую рамку: текст в неё не влезает', () => {
    const { ctx, calls } = fakeContext()
    drawWindowFrame(ctx, { x0: 400, x1: 460 }, 1200, 300, canvasTheme())
    expect(calls.fillText).toEqual([])
  })
})
