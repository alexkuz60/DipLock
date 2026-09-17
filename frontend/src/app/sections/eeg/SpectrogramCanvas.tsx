/**
 * Нижняя половина раздела «ЭЭГ»: спектрограмма канала на canvas.
 *
 * Рисуется **по числам** с сервера (`SpectrogramGrid`): палитра, окно дБ и
 * сглаживание — параметры просмотра, поэтому их правка не делает запросов и не
 * пересчитывает STFT. Пиксели красит `ImageData` с таблицей цветов палитры
 * (`paletteLut`), а не `fillRect` на клетку: сетка бывает 257 × 5000, и поштучная
 * заливка была бы в разы дороже.
 *
 * Масштаб по времени:
 * * «Связано» — спектрограмма показывает то же окно, что и трек: ритм и форма
 *   сигнала читаются на одном отрезке;
 * * «Обзор» — вся запись целиком: у зума трека своя задача, у обзора — своя.
 * Переключение — только просмотр, сетка та же.
 *
 * Перетаскивание **правой линейки** меняет окно частот (масштаб), клик по
 * области отвечает на два вопроса сразу: время уходит в **общий курсор** (та же
 * вертикаль, что на треке), а частота — в **линию частоты** этой половины с
 * значением в правом столбце. Двойной клик снимает обе метки.
 *
 * В «обзоре» окно половины шире окна трека, поэтому видимый на треке отрезок
 * обведён **рамкой** (`windowFrame` + `drawWindowFrame`): приглушено то, чего на
 * треке не видно, а внутри рамки стоит общий курсор — выбранная на ЭЭГ позиция.
 */
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { TimeWindow } from '@/shared/lib/viewerMath'
import type { ArtifactZone } from '@/shared/lib/viewerLayers'
import {
  dbToUnit,
  paletteLut,
  smoothSpectrogram,
  timeIndexRange,
  type EegPaletteId,
  type SpectrogramGrid,
} from '@/shared/lib/eegSpectrogram'
import {
  formatHzTick,
  fmaxToY,
  freqTicks,
  plotLeftPx,
  plotRightPx,
  plotTimeAtX,
  plotTimeX,
  plotWidthPx,
  timeInWindow,
  windowFrame,
  yToFreq,
} from '@/shared/lib/eegView'
import {
  canvasScale,
  canvasTheme,
  drawArtifactZones,
  drawCursor,
  drawEmptyMessage,
  drawFreqMarker,
  drawGridLines,
  drawLeftLabel,
  drawValueAxis,
  drawWindowFrame,
  putImageDataAt,
  setupCanvas,
} from './eegCanvas'

export type SpectrogramCanvasProps = {
  /** Сетка расчёта (null — спектрограмма ещё не посчитана) */
  grid: SpectrogramGrid | null
  /** Окно времени трека */
  window: TimeWindow
  /** Показывать всю запись («обзор») или следовать окну трека («связано») */
  overview: boolean
  palette: EegPaletteId
  /** Окно дБ отображения относительно потолка шкалы расчёта */
  dbRangeDb: [number, number]
  smoothMs: number
  smoothBins: number
  /** Видимое окно частот, Гц (null — вся сетка) */
  freqWindow: [number, number] | null
  /** Рисовать ли линии сетки поверх картинки */
  lines: boolean
  /**
   * Зоны артефактов поверх картинки: мощность не показывает артефакт — глаз
   * должен видеть, что всплеск на треке пришёлся на то же время (срез 5+)
   */
  zones?: ArtifactZone[]
  width: number
  height: number
  /** Время общего курсора, с (null — курсора нет) */
  cursorSec: number | null
  /** Частота маркера-горизонтали, Гц (null — маркера нет) */
  markerHz: number | null
  /** Клик по области: время — в общий курсор, частота — в маркер половины */
  onPick: (timeSec: number, freqHz: number | null) => void
  /** Двойной клик: снять и курсор, и маркер */
  onClear: () => void
  /** Перетаскивание правой линейки: смещение вниз по вертикали, px */
  onFreqDrag: (dyPx: number) => void
}

export function SpectrogramCanvas({
  grid,
  window,
  overview,
  palette,
  dbRangeDb,
  smoothMs,
  smoothBins,
  freqWindow,
  lines,
  zones = [],
  width,
  height,
  cursorSec,
  markerHz,
  onPick,
  onClear,
  onFreqDrag,
}: SpectrogramCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ mode: 'none' | 'axis'; y: number; moved: boolean }>({
    mode: 'none',
    y: 0,
    moved: false,
  })
  const lut = useMemo(() => paletteLut(palette), [palette])
  /** Сглаживание — «просмотр»: считается из уже полученных чисел (нет запросов) */
  const smooth = useMemo(
    () => (grid ? smoothSpectrogram(grid, smoothMs, smoothBins) : null),
    [grid, smoothMs, smoothBins],
  )
  /** Что именно показывает половина: своё окно или вся запись */
  const shownWindow = useMemo<TimeWindow>(() => {
    if (overview && smooth) {
      return { t0: smooth.times[0] ?? 0, t1: smooth.times[smooth.nTimes - 1] ?? 0 }
    }
    return window
  }, [overview, smooth, window])
  const shownFreq = useMemo<[number, number] | null>(
    () => freqWindow ?? (grid ? [grid.freqs[0] ?? 0, grid.fmaxHz] : null),
    [freqWindow, grid],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = setupCanvas(canvas, width, height)
    if (!ctx) return
    const theme = canvasTheme()
    const left = plotLeftPx()
    const right = plotRightPx(width)
    const plotWidth = Math.max(1, right - left)
    const fmin = shownFreq ? shownFreq[0] : 0
    const fmax = shownFreq ? shownFreq[1] : 1

    drawLeftLabel(ctx, [overview ? 'Обзор записи' : 'Окно трека', 'Гц ↓'], height, theme)
    drawValueAxis(ctx, freqTicks(fmin, fmax, height), width, theme, 'Гц')

    if (!smooth || smooth.nTimes === 0) {
      drawEmptyMessage(ctx, 'Спектрограмма не рассчитана', width, height, theme)
      return
    }

    const span = Math.max(1e-6, shownWindow.t1 - shownWindow.t0)
    const { from, to } = timeIndexRange(smooth.times, shownWindow)
    const rows = smooth.nFreqs
    const topFreq = Math.max(1e-6, smooth.freqs[rows - 1] as number)
    // Пиксели набираются в **разрешении холста**: `putImageData` не проходит через
    // трансформацию контекста (см. `putImageDataAt`), и картинка в CSS-пикселях
    // заняла бы лишь 1 / dpr ширины области графика.
    const scale = canvasScale()
    const bitmapWidth = Math.max(1, Math.round(plotWidth * scale))
    const bitmapHeight = Math.max(1, Math.round(height * scale))
    // Столбец картинки — ближайшее окно сетки: интерполяция по времени
    // «размывала бы» измеренный пик, а ширина окна уже выбрана в задаче.
    const image = ctx.createImageData(bitmapWidth, bitmapHeight)
    const data = image.data
    for (let y = 0; y < bitmapHeight; y++) {
      const frequency = yToFreq(y + 0.5, fmin, fmax, bitmapHeight)
      const rowIndex = Math.min(
        rows - 1,
        Math.max(0, Math.round((frequency / topFreq) * (rows - 1))),
      )
      for (let x = 0; x < bitmapWidth; x++) {
        const time = shownWindow.t0 + (x / bitmapWidth) * span
        const ratio = (time - (smooth.times[from] as number)) / span
        const column = Math.round(from + ratio * (to - from))
        const value =
          smooth.values[
            rowIndex * smooth.nTimes + Math.min(smooth.nTimes - 1, Math.max(0, column))
          ] ?? smooth.dbMin
        const unit = dbToUnit(value, dbRangeDb, smooth.dbMax)
        const colour = Math.round(unit * 255) * 3
        const target = (y * bitmapWidth + x) * 4
        data[target] = lut[colour] as number
        data[target + 1] = lut[colour + 1] as number
        data[target + 2] = lut[colour + 2] as number
        data[target + 3] = 255
      }
    }
    putImageDataAt(ctx, image, left, 0)

    // Зоны артефактов — поверх картинки: спектрограмма не отличает всплеск от
    // ритма, а зона показывает, что в это время сигнал был помечен детектором
    drawArtifactZones(ctx, zones, shownWindow, width, height, theme)

    if (lines) {
      drawGridLines(ctx, freqTicks(fmin, fmax, height).map((tick) => tick.y), left, right, theme)
    }
    // Рамка видимой части записи: в «обзоре» половина шире окна трека, и без рамки
    // не видно, какой отрезок открыт вверху. Когда окна совпадают, рамки нет —
    // её место занимает весь график (`windowFrame` возвращает null)
    const frame = windowFrame(window, shownWindow, width)
    if (frame) drawWindowFrame(ctx, frame, width, height, theme)
    if (cursorSec !== null && timeInWindow(cursorSec, shownWindow)) {
      drawCursor(ctx, plotTimeX(cursorSec, shownWindow, width), height, theme)
    }
    if (markerHz !== null && markerHz >= fmin && markerHz <= fmax) {
      // Частота — по той же шкале, что нарисована: `fmaxToY` обратна `yToFreq`
      drawFreqMarker(
        ctx,
        fmaxToY(markerHz, fmin, fmax, height),
        `${formatHzTick(markerHz)} Гц`,
        width,
        theme,
      )
    }
  }, [
    smooth,
    window,
    shownWindow,
    shownFreq,
    overview,
    dbRangeDb,
    lines,
    zones,
    width,
    height,
    cursorSec,
    markerHz,
    lut,
  ])

  /** Попадание в столбец значений справа (по нему — перетаскивание окна частот). */
  function insideValueAxis(clientX: number): boolean {
    const canvas = canvasRef.current
    if (!canvas) return false
    // Ширина — из пропа: холст отрисован ровно по нему (в jsdom раскладки нет)
    return clientX - canvas.getBoundingClientRect().left >= plotRightPx(width)
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    // Не-левая кнопка (или её отсутствие в окружении без PointerEvent) — не жест
    if (typeof event.button === 'number' && event.button !== 0) return
    if (insideValueAxis(event.clientX)) {
      dragRef.current = { mode: 'axis', y: event.clientY, moved: false }
      event.currentTarget.setPointerCapture?.(event.pointerId)
      return
    }
    dragRef.current = { mode: 'none', y: event.clientY, moved: false }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    if (drag.mode !== 'axis') return
    const dy = event.clientY - drag.y
    if (Math.abs(dy) > 3) drag.moved = true
    if (!drag.moved) return
    onFreqDrag(dy)
    dragRef.current = { ...drag, y: event.clientY }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current
    dragRef.current = { mode: 'none', y: 0, moved: false }
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (drag.mode === 'axis') return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const xPx = event.clientX - rect.left
    // Ширина области — из пропа: холст отрисован ровно по нему (в jsdom
    // раскладки нет, и геометрия не должна зависеть от `getBoundingClientRect`)
    const plotWidth = plotWidthPx(width)
    if (plotWidth <= 0 || xPx < plotLeftPx() || xPx > plotLeftPx() + plotWidth) return
    const fmin = shownFreq ? shownFreq[0] : null
    const fmax = shownFreq ? shownFreq[1] : null
    const yPx = Math.min(Math.max(event.clientY - rect.top, 0), height)
    // Частота — по той же шкале, что нарисована (`yToFreq` — обратная к `fmaxToY`);
    // без сетки маркера нет, но курсор по времени поставить можно
    const freqHz =
      fmin !== null && fmax !== null ? Math.round(yToFreq(yPx, fmin, fmax, height) * 10) / 10 : null
    onPick(plotTimeAtX(xPx, shownWindow, width), freqHz)
  }

  function handleDoubleClick() {
    // Двойной клик по области — снять и курсор, и маркер частоты (как у трека)
    onClear()
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="eeg-spectrogram-canvas"
      data-mode={overview ? 'overview' : 'linked'}
      className="block cursor-crosshair touch-none"
      style={{
        width: `${Math.max(1, Math.round(width))}px`,
        height: `${Math.max(1, Math.round(height))}px`,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    />
  )
}

