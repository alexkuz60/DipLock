/**
 * Тесты отрисовки холстов раздела «ЭЭГ» (срез 5, поправки ручной проверки).
 *
 * Проверяется то, чего не видно на экране с масштабом 100 %: картинка спектрограммы
 * приходит в холст **в разрешении данных** и растягивается композитором (`drawRaster`
 * с `imageSmoothingEnabled = false`), а `putImageData` для этого не годится: он
 * **игнорирует** трансформацию контекста и не умеет масштаб — на экране с
 * `devicePixelRatio ≠ 1` картинка занимала бы лишь `1 / dpr` ширины области графика:
 * спектрограмма обрывалась бы до правой линейки, а её ось, курсор и маркер частоты
 * уезжали бы за край (ровно то, что было в ручной проверке среза 5). Размеры bitmap и
 * трансформация холста — по-прежнему `setupCanvas`, а растр и его масштабирование —
 * `drawRaster` (проверка добавлена срезом P1).
 *
 * Здесь же метки клика: линия частоты и линия уровня (у них общая реализация, поэтому
 * общая и подпись у столбца линеек), нулевая линия сигнала и рамка окна трека на
 * «обзоре» (приглушено всё, чего на треке не видно). Canvas в jsdom не рисуется,
 * поэтому контекст подменяется записью вызовов — как в `exportWindow.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import { EEG_LABEL_W, EEG_VALUE_W } from '@/shared/lib/eegView'
import type { ArtifactZone } from '@/shared/lib/viewerLayers'
import {
  ARTIFACT_STRIPE_PX,
  canvasScale,
  canvasTheme,
  drawArtifactZones,
  drawFreqMarker,
  drawLevelMarker,
  drawNullLine,
  drawRaster,
  drawValueAxis,
  drawWindowFrame,
  setupCanvas,
} from './eegCanvas'

type Calls = {
  setTransform: unknown[][]
  putImageData: unknown[][]
  drawImage: unknown[][]
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
    drawImage: [],
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
    drawImage: record('drawImage'),
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
    imageSmoothingEnabled: true,
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

  it('растягивает растр данных на область графика без сглаживания (P1)', () => {
    const { ctx, calls } = fakeContext()
    const scratchCtx = {
      createImageData: vi.fn((width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      })),
      putImageData: vi.fn(),
    }
    const scratch = { width: 0, height: 0, getContext: () => scratchCtx }
    const raster = { columns: 3, rows: 2, rgba: new Uint8ClampedArray(3 * 2 * 4).fill(7) }

    // Без готового посредника он создаётся сам: размер — по растру, а не по холсту
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(scratch as unknown as HTMLElement)
    const created = drawRaster(ctx, raster, EEG_LABEL_W, 1000, 300)
    createElement.mockRestore()

    expect(created).toBe(scratch)
    expect(scratch.width).toBe(3)
    expect(scratch.height).toBe(2)
    expect(scratchCtx.createImageData).toHaveBeenCalledWith(3, 2)
    // Масштабирует композитор: drawImage в область графика, ячейки не размываются
    expect(calls.drawImage).toEqual([[scratch, EEG_LABEL_W, 0, 1000, 300]])
    expect(ctx.imageSmoothingEnabled).toBe(false)
    // `putImageData` в сам холст не идёт: он бы положил растр 3 × 2 пикселя в угол
    expect(calls.putImageData).toEqual([])

    // Повторный вызов переиспользует холст: новый не создаётся
    const secondCreate = vi.spyOn(document, 'createElement')
    const again = drawRaster(ctx, raster, EEG_LABEL_W, 1000, 300, scratch as unknown as HTMLCanvasElement)
    expect(again).toBe(scratch)
    expect(secondCreate).not.toHaveBeenCalled()
    secondCreate.mockRestore()
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

  it('рисует зоны артефактов заливкой и полоской типа, обрезая их по области графика', () => {
    const { ctx, calls } = fakeContext()
    const theme = canvasTheme()
    // В jsdom CSS переменных нет — цвета берутся из fallback темы, а не пустыми
    expect(theme.artifacts.zscore_outlier).toBe('#ff7b72')

    const window = { t0: 5, t1: 15 }
    const plotWidth = 1200 - EEG_LABEL_W - EEG_VALUE_W
    const x = (time: number) => EEG_LABEL_W + ((time - window.t0) / 10) * plotWidth
    const zones: ArtifactZone[] = [
      // Началась до окна и тянется в него: левый край обрезан областью графика
      { id: 'z1', kind: 'peak_to_peak', onsetSec: 4, durationSec: 2, channels: [] },
      // Вне окна: рисовать нечего
      { id: 'z2', kind: 'flat_line', onsetSec: 40, durationSec: 1, channels: [] },
    ]

    drawArtifactZones(ctx, zones, window, 1200, 300, theme)

    const start = EEG_LABEL_W
    const width = x(6) - start
    expect(calls.fillRect).toEqual([
      [start, 0, width, 300], // заливка: фоном под сигналом
      [start, 0, width, ARTIFACT_STRIPE_PX], // полоска типа артефакта у верхнего края
    ])
  })

  it('не рисует зоны на вырожденной области графика и при пустом списке', () => {
    const { ctx, calls } = fakeContext()
    const theme = canvasTheme()
    const zone: ArtifactZone = {
      id: 'z1',
      kind: 'zscore_outlier',
      onsetSec: 1,
      durationSec: 1,
      channels: [],
    }

    drawArtifactZones(ctx, [], { t0: 0, t1: 10 }, 1200, 300, theme)
    drawArtifactZones(ctx, [zone], { t0: 0, t1: 10 }, EEG_LABEL_W + EEG_VALUE_W, 300, theme)

    expect(calls.fillRect).toEqual([])
  })
})
