/**
 * Нижняя половина раздела «ЭЭГ»: спектрограмма канала на canvas.
 *
 * Рисуется **по числам** с сервера (`SpectrogramGrid`): палитра, окно дБ и
 * сглаживание — параметры просмотра, поэтому их правка не делает запросов и не
 * пересчитывает STFT. Картинка собирается в **разрешении данных**
 * (`spectrogramRaster`: строка — частота, столбец — окно STFT) и растягивается на
 * область графика композитором (`drawRaster`), а не набирается попиксельно в
 * разрешении холста: работа пропорциональна сетке, а не площади экрана. Растр
 * кэшируется по своим входам, поэтому движение курсора перерисовывает только
 * оверлеи (`docs/rules/frontend-perf.md`).
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
  paletteLut,
  smoothSpectrogram,
  spectrogramRaster,
  type EegPaletteId,
  type SpectrogramGrid,
  type SpectrogramRaster,
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
import { perfCount, perfSpan } from '@/shared/lib/perf'
import {
  canvasScale,
  canvasTheme,
  drawArtifactZones,
  drawCursor,
  drawEmptyMessage,
  drawFreqMarker,
  drawGridLines,
  drawLeftLabel,
  drawRaster,
  drawValueAxis,
  drawWindowFrame,
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

/**
 * Входы растровой картинки: от них зависит содержимое растра, и только они.
 *
 * Курсор, маркер частоты, линии сетки и рамка окна в этот набор **не входят**:
 * это оверлеи, они рисуются поверх готового растра. Поэтому движение курсора
 * больше не пересобирает картинку (правило — `docs/rules/frontend-perf.md`).
 */
type RasterInputs = {
  smooth: SpectrogramGrid
  palette: EegPaletteId
  t0: number
  t1: number
  fmin: number
  fmax: number
  dbLow: number
  dbHigh: number
  maxColumns: number
  maxRows: number
}

/** Совпали ли входы растра: сравнение по числам и по ссылке на сетку. */
function sameRasterInputs(left: RasterInputs, right: RasterInputs): boolean {
  return (
    left.smooth === right.smooth &&
    left.palette === right.palette &&
    left.t0 === right.t0 &&
    left.t1 === right.t1 &&
    left.fmin === right.fmin &&
    left.fmax === right.fmax &&
    left.dbLow === right.dbLow &&
    left.dbHigh === right.dbHigh &&
    left.maxColumns === right.maxColumns &&
    left.maxRows === right.maxRows
  )
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
  /**
   * Кэш растра и холст-посредник (правило `docs/rules/frontend-perf.md`):
   * картинка пересобирается только при смене своих входов, а оверлеи (курсор,
   * маркер частоты, сетка, рамка) рисуются поверх готового растра.
   */
  const rasterRef = useRef<{ inputs: RasterInputs; raster: SpectrogramRaster } | null>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
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

    /*
      Пиксели набираются **в разрешении данных**, а не в разрешении холста:
      растр сетки (строка — частота, столбец — окно STFT) рисуется через
      `drawImage`, и каждая его ячейка становится прямоугольником. Бюджет —
      размер области в bitmap-пикселях: растр не может быть больше холста, и
      прореживание плотной сетки остаётся прежним (`docs/rules/frontend-perf.md`).
    */
    const scale = canvasScale()
    const maxColumns = Math.max(1, Math.round(plotWidth * scale))
    const maxRows = Math.max(1, Math.round(height * scale))
    const inputs: RasterInputs = {
      smooth,
      palette,
      t0: shownWindow.t0,
      t1: shownWindow.t1,
      fmin,
      fmax,
      dbLow: dbRangeDb[0],
      dbHigh: dbRangeDb[1],
      maxColumns,
      maxRows,
    }
    // Растр пересобирается только при смене своих входов: движение курсора и
    // перетаскивание маркера частоты перерисовывают оверлеи поверх готовой картинки
    const cached = rasterRef.current
    let raster: SpectrogramRaster
    if (cached && sameRasterInputs(cached.inputs, inputs)) {
      raster = cached.raster
    } else {
      perfCount('eeg.raster.rebuild')
      raster = perfSpan('eeg.raster.build', () =>
        spectrogramRaster(smooth, shownWindow, [fmin, fmax], dbRangeDb, lut, maxColumns, maxRows),
      )
      rasterRef.current = { inputs, raster }
    }
    scratchRef.current = perfSpan('eeg.raster.paint', () =>
      drawRaster(ctx, raster, left, plotWidth, height, scratchRef.current),
    )

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
    palette,
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

