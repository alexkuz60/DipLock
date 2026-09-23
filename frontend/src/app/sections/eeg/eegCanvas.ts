/**
 * Отрисовка половин раздела «ЭЭГ» на canvas: общая рамка, линейки значений и курсор.
 *
 * Половины (трек и спектрограмма) — **разные холсты, но одна геометрия**: левый
 * край области графика, ширина столбца значений и полоса таймлайна заданы
 * константами `shared/lib/eegView.ts`, поэтому общий курсор и совпадение шкал
 * держатся без «магии согласования» при правках.
 *
 * Метки клика — не только вертикаль: у спектрограммы это ещё и линия частоты, у
 * трека — линия уровня и нулевая линия сигнала. Линии частоты и уровня рисует общая
 * `drawHorizontalMarker`, а видимый отрезок трека на «обзоре» обводит `drawWindowFrame`.
 *
 * Цвета берутся токенами темы через `themeColor` (canvas не читает CSS-переменные
 * и уж тем более `color-mix`), как в экспорте окна вьюера (2.8) и проекциях
 * мозга (3.1): hex в JS не дублируется.
 */
import { ARTIFACT_COLOR_TOKENS, ARTIFACT_KINDS, type ArtifactKind } from '@/shared/lib/artifacts'
import type { SpectrogramRaster } from '@/shared/lib/eegSpectrogram'
import { themeColor } from '@/shared/lib/theme'
import {
  EEG_LABEL_W,
  EEG_VALUE_W,
  plotTimeX,
  type ValueTick,
  type WindowFrame,
} from '@/shared/lib/eegView'
import type { ArtifactZone } from '@/shared/lib/viewerLayers'
import type { TimeWindow } from '@/shared/lib/viewerMath'

export type CanvasTheme = {
  text: string
  grid: string
  frame: string
  accent: string
  label: string
  /** Фон половин: подпись поверх картинки (маркер частоты) читается только на плашке */
  panel: string
  /** Цвета типов артефактов: зоны рисуются и на треке, и на спектрограмме */
  artifacts: Record<ArtifactKind, string>
}

/**
 * Масштаб холста: bitmap-пикселей на CSS-пиксель (`devicePixelRatio`).
 *
 * Нужен там, где считается **бюджет** картинки в bitmap-пикселях (растр
 * спектрограммы: `maxColumns × maxRows`), и там, где координаты не проходят через
 * трансформацию контекста (`ctx.canvas.height`). В jsdom и при 100 % масштабе — 1.
 */
export function canvasScale(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}

/** Цвета темы для холста (fallback — значения из `styles/index.css`). */
export function canvasTheme(doc: Document = document): CanvasTheme {
  const fallback: Record<ArtifactKind, string> = {
    zscore_outlier: '#ff7b72',
    peak_to_peak: '#ffb454',
    flat_line: '#8b949e',
    clipping: '#f778ba',
    break: '#39c5cf',
    electrode_pop: '#e3b341',
    muscle_emg: '#2f81f7',
    line_noise: '#3fb950',
    ocular: '#d29922',
    ecg: '#db61a2',
    ica_eog: '#a78bfa',
  }
  const artifacts = {} as Record<ArtifactKind, string>
  for (const kind of ARTIFACT_KINDS) {
    artifacts[kind] = themeColor(doc, ARTIFACT_COLOR_TOKENS[kind], fallback[kind])
  }
  return {
    text: themeColor(doc, '--color-fg-2', '#8695a8'),
    grid: themeColor(doc, '--color-border', '#2c3a4d'),
    frame: themeColor(doc, '--color-fg-1', '#c3ceda'),
    accent: themeColor(doc, '--color-accent', '#4da3ff'),
    label: themeColor(doc, '--color-fg-0', '#e8eef6'),
    panel: themeColor(doc, '--color-bg-1', '#121a24'),
    artifacts,
  }
}

/**
 * Готовит холст к рисованию: размеры в физических пикселях и масштаб.
 * Возвращает `null`, если контекста нет (jsdom без canvas) — вызывающий код
 * просто не рисует, а не падает.
 */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  widthPx: number,
  heightPx: number,
): CanvasRenderingContext2D | null {
  const width = Math.max(1, Math.round(widthPx))
  const height = Math.max(1, Math.round(heightPx))
  const scale = canvasScale()
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  return ctx
}

/**

/**
 * Рисует растр спектрограммы в область графика, растягивая его до неё.
 *
 * Растр собран в **разрешении данных** (`spectrogramRaster`), а растягивает его
 * композитор: `drawImage` с `imageSmoothingEnabled = false`. Поэтому работа
 * пропорциональна числу ячеек сетки, а не площади экрана. `putImageData` для
 * этого не годится по двум причинам: он **игнорирует трансформацию контекста**
 * (пиксели легли бы в bitmap-координаты, то есть на экране с `devicePixelRatio
 * ≠ 1` картинка заняла бы `1 / dpr` области графика) и не умеет масштабировать.
 * Пиксели данных при растяжении не «размываются»: ячейка остаётся
 * прямоугольником — столбец равен окну STFT, строка — полосе частот.
 *
 * Холст-посредник переиспользуется (`scratch`): его размер меняется вместе с
 * растром, а не на каждый кадр (курсор и маркер частоты лишь перерисовывают
 * поверх уже готовой картинки).
 */
export function drawRaster(
  ctx: CanvasRenderingContext2D,
  raster: SpectrogramRaster,
  leftPx: number,
  widthPx: number,
  heightPx: number,
  scratch?: HTMLCanvasElement | null,
): HTMLCanvasElement | null {
  const canvas =
    scratch ?? (typeof document !== 'undefined' ? document.createElement('canvas') : null)
  if (!canvas) return null
  if (canvas.width !== raster.columns || canvas.height !== raster.rows) {
    canvas.width = raster.columns
    canvas.height = raster.rows
  }
  const source = canvas.getContext('2d')
  if (!source) return canvas
  const image = source.createImageData(raster.columns, raster.rows)
  image.data.set(raster.rgba)
  source.putImageData(image, 0, 0)
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(canvas, leftPx, 0, Math.max(1, widthPx), Math.max(1, heightPx))
  ctx.restore()
  return canvas
}


/** Подпись слева (имя канала и единица шкалы) — столбец `EEG_LABEL_W`. */
export function drawLeftLabel(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  height: number,
  theme: CanvasTheme,
): void {
  ctx.save()
  ctx.textAlign = 'left'
  lines.forEach((line, index) => {
    ctx.fillStyle = index === 0 ? theme.label : theme.text
    ctx.font = index === 0 ? '13px system-ui, sans-serif' : '11px system-ui, sans-serif'
    ctx.fillText(line, 8, height / 2 + index * 16 - (lines.length - 1) * 8)
  })
  ctx.restore()
}

/** Деления линейки значений справа: короткая риска и подпись за ней. */
export function drawValueAxis(
  ctx: CanvasRenderingContext2D,
  ticks: ValueTick[],
  width: number,
  theme: CanvasTheme,
  unit: string,
): void {
  const axisLeft = width - EEG_VALUE_W
  ctx.save()
  ctx.strokeStyle = theme.grid
  ctx.fillStyle = theme.text
  ctx.textAlign = 'left'
  ctx.beginPath()
  ctx.moveTo(axisLeft, 0)
  // Высота холста — в bitmap-пикселях, а рисуем мы в CSS-координатах (трансформация
  // уже учитывает масштаб): иначе линия уходила бы за низ области на dpr−1
  ctx.lineTo(axisLeft, ctx.canvas.height / canvasScale())
  ctx.stroke()
  ticks.forEach((tick) => {
    ctx.beginPath()
    ctx.moveTo(axisLeft, tick.y)
    ctx.lineTo(axisLeft + 4, tick.y)
    ctx.stroke()
    ctx.fillText(tick.label, axisLeft + 7, tick.y)
  })
  // Единица измерения — у верхнего края линейки, а не у каждого деления
  ctx.fillText(unit, axisLeft + 7, 8)
  ctx.restore()
}

/** Общий курсор: одна вертикальная линия по всей высоте холста. */
export function drawCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  height: number,
  theme: CanvasTheme,
): void {
  ctx.save()
  ctx.strokeStyle = theme.accent
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.moveTo(Math.round(x) + 0.5, 0)
  ctx.lineTo(Math.round(x) + 0.5, height)
  ctx.stroke()
  ctx.restore()
}

/**
 * Горизонтальный маркер с подписью у линейки: линия через область графика и её
 * значение **в столбце линеек**.
 *
 * Реализация одна на линию частоты (спектрограмма) и линию уровня (трек): рисуются
 * они одинаково, а «уезжают по вертикали» по-разному — правка одной не должна
 * разводить подписи. Цифра стоит в столбце линейки, а не в подсказке: её видно
 * вместе с картинкой, и плашка фона не сливается с делениями шкалы под ней.
 */
function drawHorizontalMarker(
  ctx: CanvasRenderingContext2D,
  y: number,
  label: string,
  width: number,
  theme: CanvasTheme,
): void {
  const axisLeft = width - EEG_VALUE_W
  const lineY = Math.round(y) + 0.5
  ctx.save()
  ctx.strokeStyle = theme.accent
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.moveTo(EEG_LABEL_W, lineY)
  ctx.lineTo(axisLeft, lineY)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
  ctx.fillStyle = theme.panel
  ctx.fillRect(axisLeft, lineY - 8, ctx.measureText(label).width + 14, 16)
  ctx.fillStyle = theme.accent
  ctx.fillText(label, axisLeft + 7, lineY)
  ctx.restore()
}

/** Маркер частоты на спектрограмме (клик по картинке): `y` — из `fmaxToY`. */
export function drawFreqMarker(
  ctx: CanvasRenderingContext2D,
  y: number,
  label: string,
  width: number,
  theme: CanvasTheme,
): void {
  drawHorizontalMarker(ctx, y, label, width, theme)
}

/** Маркер уровня сигнала на треке (клик по треку): `y` — из `valueToY`. */
export function drawLevelMarker(
  ctx: CanvasRenderingContext2D,
  y: number,
  label: string,
  width: number,
  theme: CanvasTheme,
): void {
  drawHorizontalMarker(ctx, y, label, width, theme)
}

/**
 * Нулевая линия сигнала: пунктир по середине области графика.
 *
 * Шкала трека симметрична относительно нуля (±`AMPLITUDE_DIVISIONS / 2` делений),
 * поэтому ноль всегда в середине половины. Без линии «где ноль» угадывается по
 * делениям линейки, и постоянное смещение сигнала на глаз не читается. Рисуется
 * **под** огибающей: в спокойных местах видна, в шумных её закрывает сам сигнал —
 * как и положено опорной линии.
 */
export function drawNullLine(
  ctx: CanvasRenderingContext2D,
  y: number,
  width: number,
  theme: CanvasTheme,
): void {
  const lineY = Math.round(y) + 0.5
  ctx.save()
  ctx.strokeStyle = theme.frame
  ctx.globalAlpha = 0.4
  // Пунктир отличает опорную линию от линий сетки (те сплошные)
  ctx.setLineDash?.([5, 4])
  ctx.beginPath()
  ctx.moveTo(EEG_LABEL_W, lineY)
  ctx.lineTo(width - EEG_VALUE_W, lineY)
  ctx.stroke()
  ctx.restore()
}

/**
 * Рамка видимой части записи на половине, чьё окно шире окна трека (спектрограмма
 * в «обзоре»).
 *
 * Внутри рамки — отрезок, видимый на треке, снаружи — остальная запись: поэтому
 * приглушается «снаружи» плашкой фона, а не подсвечивается рамка — глаз читает
 * главное (видимый отрезок), а не границы. Курсор рисуется **после** рамки: он и
 * есть выбранная позиция внутри рамки. Подпись «окно трека» — только если рамка
 * достаточно широка, иначе текст не влезает.
 */
export function drawWindowFrame(
  ctx: CanvasRenderingContext2D,
  frame: WindowFrame,
  width: number,
  height: number,
  theme: CanvasTheme,
  label = 'окно трека',
): void {
  const axisLeft = width - EEG_VALUE_W
  ctx.save()
  // Приглушение — `globalAlpha` с цветом плашки, а не `rgba(...)`: токен темы может
  // быть записан в любом формате, а непрозрачная плашка скрыла бы картинку целиком.
  // Мягкое (0.35): «обзор» остаётся читаемым — он и нужен, чтобы видеть всю запись
  ctx.globalAlpha = 0.35
  ctx.fillStyle = theme.panel
  ctx.fillRect(EEG_LABEL_W, 0, Math.max(0, frame.x0 - EEG_LABEL_W), height)
  ctx.fillRect(frame.x1, 0, Math.max(0, axisLeft - frame.x1), height)
  // Рамку видно и без приглушения: 2 px полной непрозрачности против тусклой сетки
  ctx.globalAlpha = 1
  ctx.strokeStyle = theme.frame
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.rect(
    Math.round(frame.x0) + 0.5,
    0.5,
    Math.max(1, Math.round(frame.x1 - frame.x0) - 1),
    Math.max(1, height - 1),
  )
  ctx.stroke()
  if (frame.x1 - frame.x0 >= 96) {
    ctx.globalAlpha = 1
    ctx.fillStyle = theme.label
    ctx.textAlign = 'left'
    ctx.fillText(label, Math.round(frame.x0) + 5, 10)
  }
  ctx.restore()
}

/** Горизонтальные линии сетки (шкала значений) — «прицел» для глаз. */
export function drawGridLines(
  ctx: CanvasRenderingContext2D,
  ys: number[],
  left: number,
  right: number,
  theme: CanvasTheme,
): void {
  ctx.save()
  ctx.strokeStyle = theme.grid
  ctx.globalAlpha = 0.5
  ys.forEach((y) => {
    ctx.beginPath()
    ctx.moveTo(left, Math.round(y) + 0.5)
    ctx.lineTo(right, Math.round(y) + 0.5)
    ctx.stroke()
  })
  ctx.restore()
}

/** Прозрачность заливки зон: сигнал и картинка спектрограммы остаются читаемыми */
export const ARTIFACT_FILL_ALPHA = 0.18

/** Высота цветной полоски типа артефакта у верхнего края половины, px */
export const ARTIFACT_STRIPE_PX = 3

/**
 * Зоны артефактов поверх половины: полупрозрачная заливка по типу и цветная
 * полоска у верхнего края.
 *
 * Полоска нужна потому, что заливка специально слабая: на треке она не должна
 * перебивать сигнал, на спектрограмме — мешать читать мощность. Тип зоны
 * (z-score, ICA, flat-line) читается по цвету полоски, интервал — по её длине:
 * это визуальный контроль результата стадии «Артефакты» раздела EDF, а не
 * второй детектор.
 *
 * Зоны обрезаются по области графика: крайняя зона не «залезает» под линейки.
 */
export function drawArtifactZones(
  ctx: CanvasRenderingContext2D,
  zones: readonly ArtifactZone[],
  window: TimeWindow,
  width: number,
  height: number,
  theme: CanvasTheme,
  fillAlpha = ARTIFACT_FILL_ALPHA,
): void {
  const left = EEG_LABEL_W
  const right = width - EEG_VALUE_W
  if (zones.length === 0 || right <= left || height <= 0) return
  ctx.save()
  for (const zone of zones) {
    const x0 = plotTimeX(zone.onsetSec, window, width)
    const x1 = plotTimeX(zone.onsetSec + zone.durationSec, window, width)
    if (x1 <= left || x0 >= right) continue
    const start = Math.max(left, x0)
    // Минимум 2 px: короткая зона (всплеск peak-to-peak) иначе не различима
    const zoneWidth = Math.max(2, Math.min(right, x1) - start)
    const color = theme.artifacts[zone.kind]
    ctx.globalAlpha = fillAlpha
    ctx.fillStyle = color
    ctx.fillRect(start, 0, zoneWidth, height)
    ctx.globalAlpha = 1
    ctx.fillRect(start, 0, zoneWidth, ARTIFACT_STRIPE_PX)
  }
  ctx.restore()
}

/** Сообщение вместо графика: холст не пустой, а объясняет, чего нет. */
export function drawEmptyMessage(
  ctx: CanvasRenderingContext2D,
  message: string,
  width: number,
  height: number,
  theme: CanvasTheme,
): void {
  ctx.save()
  ctx.fillStyle = theme.text
  ctx.textAlign = 'center'
  ctx.fillText(message, EEG_LABEL_W + (width - EEG_LABEL_W - EEG_VALUE_W) / 2, height / 2)
  ctx.restore()
}
