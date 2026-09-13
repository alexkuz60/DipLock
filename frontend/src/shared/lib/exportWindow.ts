/**
 * Экспорт окна вьюера (срез 2.8): CSV сигналов и PNG-снапшот треков.
 *
 * Экспорт полностью **клиентский**: данные уже в браузере (кадр пирамиды сигналов,
 * слои результата, окно просмотра), а сервер не должен пересчитывать то, что
 * видно на экране. Поэтому вся геометрия экспорта живёт здесь, а `download.ts` —
 * только доставка готового файла пользователю.
 *
 * CSV отдаёт **то, что видно**: строку на пару (временная корзина × канал) с
 * явными `min_uv`/`max_uv`, а не «сырые отсчёты». Кадр уровня ×k уже прорежен
 * сервером (docs/ui.md §8), и выдавать его за полноразрешённый сигнал нельзя —
 * поэтому в файле нет колонки «одно число на точку».
 *
 * PNG собирается из canvas'ов uPlot (по одному на трек) плюс наши собственные
 * подписи каналов, шкала времени, зоны артефактов и сетка эпох: снапшот окна
 * должен повторять то, что пользователь видит, а не только линии сигнала.
 * Canvas не умеет читать CSS-токены (`color-mix` тем более), поэтому цвета
 * разрешаются через `getComputedStyle` с hex-fallback из `styles/index.css`.
 *
 * Модуль чистый: без React и zustand; DOM трогает только `drawSnapshot`, и лишь
 * тот документ, который ему передали. Поэтому арифметика экспорта тестируема.
 */
import { ARTIFACT_SHORT_LABELS, type ArtifactKind } from './artifacts'
import type { SignalFrame } from './signalFrame'
import { frameEnvelope, timeToX, type TimeWindow } from './viewerMath'
import type { ArtifactZone, EpochCell } from './viewerLayers'

/** Заголовок CSV. Длинный формат: одна строка на (корзина × канал). */
export const CSV_HEADER = 'time_sec,channel,min_uv,max_uv'

/** Микросекунды округляем до 0.1 нВ: больше знаков — шум float32. */
function formatUv(value: number): string {
  if (!Number.isFinite(value)) return ''
  const normalized = Math.abs(value) < 5e-5 ? 0 : value
  return normalized.toFixed(4)
}

/** Время корзины в секундах с миллисекундной точностью. */
function formatTime(value: number): string {
  const normalized = Math.abs(value) < 5e-4 ? 0 : value
  return normalized.toFixed(3)
}

/**
 * CSV окна: строки «time_sec,channel,min_uv,max_uv» по возрастанию времени.
 *
 * Бюджет точек равен числу корзин кадра, поэтому повторного прореживания нет:
 * в файл попадает ровно то, что показывает вьюер. Каналы — в переданном
 * порядке (порядок монтажа), отсутствующие в кадре пропускаются.
 */
export function windowCsv(
  frame: SignalFrame,
  window: TimeWindow,
  channels: readonly string[],
): string {
  const perChannel = channels
    .filter((name) => Boolean(frame.max[name]))
    .map((name) => ({
      name,
      env: frameEnvelope(
        frame.times,
        frame.min[name] ?? [],
        frame.max[name] ?? [],
        window,
        frame.times.length,
        frame.decimated,
      ),
    }))

  const lines = [CSV_HEADER]
  // Времена общие для каналов: сетка корзин одна на кадр, поэтому берём её у
  // первого канала, а не дублируем в каждой строке канала свою.
  const times = perChannel[0]?.env.times ?? []
  for (let i = 0; i < times.length; i++) {
    const time = formatTime(times[i] as number)
    for (const channel of perChannel) {
      lines.push(
        `${time},${channel.name},${formatUv(channel.env.min[i] as number)},${formatUv(
          channel.env.max[i] as number,
        )}`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Имя файла экспорта: `<запись>-win<from>-<to>s-<уровень>.<ext>`.
 *
 * Имя записи приходит из загруженного файла, поэтому санитизируется: экспорт не
 * должен уметь записать файл за пределами каталога загрузок браузера.
 */
export function exportFileName(
  stem: string,
  window: TimeWindow,
  level: number,
  ext: 'csv' | 'png',
): string {
  const safe =
    stem
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, 60) || 'recording'
  const from = Math.max(0, window.t0).toFixed(2)
  const to = Math.max(0, window.t1).toFixed(2)
  const levelPart = level > 0 ? `level${level}` : 'full'
  return `${safe}-win${from}-${to}s-${levelPart}.${ext}`
}

/** Секунды для подписи оси: по умолчанию знаков — по величине значения. */
export function formatSeconds(sec: number, digits?: number): string {
  const abs = Math.abs(sec)
  const places = digits ?? (abs >= 60 ? 1 : abs >= 1 ? 2 : 3)
  return `${sec.toFixed(places)} с`
}

/**
 * Знаков после запятой для делений оси — из шага, а не из каждого значения:
 * вся шкала должна читаться в одном формате (включая нулевую отметку).
 */
function digitsForStep(step: number): number {
  if (step >= 60) return 1
  if (step >= 1) return 2
  return 3
}

/** «Круглые» шаги оси времени, секунды. */
const NICE_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/**
 * Деления оси времени для снапшота: не больше ``maxTicks`` штук внутри окна.
 * uPlot рисует свою ось сам, но в PNG нам нужна та же шкала на всю картинку —
 * включая треки без собственной оси.
 */
export function timeTicks(
  window: TimeWindow,
  trackWidth: number,
  maxTicks = 8,
): { x: number; label: string }[] {
  const span = window.t1 - window.t0
  if (span <= 0 || trackWidth <= 0 || maxTicks < 1) return []
  const target = span / maxTicks
  const step = NICE_STEPS.find((value) => value >= target) ?? span
  const first = Math.ceil(window.t0 / step) * step
  const count = Math.floor((window.t1 - first) / step + 1e-9) + 1
  const ticks: { x: number; label: string }[] = []
  const digits = digitsForStep(step)
  for (let index = 0; index < count; index++) {
    const time = first + index * step
    // Защита от накопления float: позиция и подпись считаются из time, а не шагами
    ticks.push({ x: timeToX(time, window, trackWidth), label: formatSeconds(time, digits) })
  }
  return ticks
}

/** Размеры снапшота: те же, что у экранных треков (иначе картинка «плывёт»). */
export const SNAPSHOT_SIZES = {
  labelWidth: 56,
  trackHeight: 64,
  headerHeight: 40,
  footerHeight: 20,
  padding: 8,
} as const

export type SnapshotSizes = {
  labelWidth: number
  trackHeight: number
  headerHeight: number
  footerHeight: number
  padding: number
}

export type SnapshotLayout = SnapshotSizes & {
  /** Ширина только области треков (без колонки подписей), px */
  trackWidth: number
  width: number
  height: number
  /** Координата Y верхнего края каждого трека */
  trackTops: number[]
}

/** Раскладка снапшота: колонка подписей + N треков + шапка/подвал с подписями. */
export function snapshotLayout(
  trackCount: number,
  trackWidth: number,
  sizes: SnapshotSizes = SNAPSHOT_SIZES,
): SnapshotLayout {
  const count = Math.max(0, Math.floor(trackCount))
  const width = sizes.labelWidth + sizes.padding * 2 + Math.max(0, Math.round(trackWidth))
  const height =
    sizes.headerHeight + count * sizes.trackHeight + (count > 0 ? sizes.footerHeight : 0)
  const trackTops = Array.from(
    { length: count },
    (_, index) => sizes.headerHeight + index * sizes.trackHeight,
  )
  return { ...sizes, trackWidth: Math.max(0, Math.round(trackWidth)), width, height, trackTops }
}

/** Прямоугольник слоя в пикселях трека (обрезанный по окну). */
export type LayerRect = { x: number; width: number; kind?: ArtifactKind }

/**
 * Прямоугольники зон артефактов для снапшота — та же геометрия, что у DOM-слоя
 * (`TrackLayers.ArtifactZoneLayer`): зона вне окна не рисуется, заходящая за
 * край обрезается, минимальная ширина 2 px, чтобы короткий всплеск был виден.
 */
export function zoneRects(
  zones: readonly ArtifactZone[],
  window: TimeWindow,
  trackWidth: number,
): LayerRect[] {
  const rects: LayerRect[] = []
  for (const zone of zones) {
    const rawLeft = timeToX(zone.onsetSec, window, trackWidth)
    const rawRight = timeToX(zone.onsetSec + zone.durationSec, window, trackWidth)
    if (rawRight <= 0 || rawLeft >= trackWidth) continue
    const x = Math.max(0, rawLeft)
    rects.push({
      x,
      width: Math.max(2, Math.min(trackWidth, rawRight) - x),
      kind: zone.kind,
    })
  }
  return rects
}

/** Границы эпох и штриховка отброшенных — в пикселях трека. */
export type EpochMarks = {
  /** X-координаты границ эпох внутри окна */
  boundaries: number[]
  /** Прямоугольники отброшенных эпох (обрезанные по окну) */
  dropped: LayerRect[]
}

/**
 * Сетка эпох для снапшота. Границы — линии, отброшенные — заливка; обе части
 * зависят от тумблеров вьюера, поэтому в снапшоте не может быть того, что
 * пользователь выключил.
 */
export function epochMarks(
  cells: readonly EpochCell[],
  window: TimeWindow,
  trackWidth: number,
  options: { boundaries: boolean; dropped: boolean },
): EpochMarks {
  const boundaries: number[] = []
  const dropped: LayerRect[] = []

  cells.forEach((cell, index) => {
    if (options.boundaries && index > 0 && cell.onsetSec > window.t0 && cell.onsetSec < window.t1) {
      boundaries.push(timeToX(cell.onsetSec, window, trackWidth))
    }
    if (!options.dropped || !cell.rejected) return
    const rawLeft = timeToX(cell.onsetSec, window, trackWidth)
    const rawRight = timeToX(cell.onsetSec + cell.durationSec, window, trackWidth)
    if (rawRight <= 0 || rawLeft >= trackWidth) return
    const x = Math.max(0, rawLeft)
    dropped.push({ x, width: Math.max(1, Math.min(trackWidth, rawRight) - x) })
  })

  return { boundaries, dropped }
}

/** Цвет темы внутри canvas: токены резолвим через getComputedStyle (hex-fallback). */
function themeColor(doc: Document, token: string, fallback: string): string {
  const view = doc.defaultView
  if (!view) return fallback
  const value = view.getComputedStyle(doc.documentElement).getPropertyValue(token)
  return value.trim() || fallback
}

/** `#rrggbb` + alpha → `rgba(...)`: canvas не понимает `color-mix` из токенов. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`
}

/** Цвета зон для canvas: токены темы те же, что у DOM-слоёв (без дублирования hex). */
const ZONE_TOKENS: Record<ArtifactKind, { token: string; fallback: string }> = {
  zscore_outlier: { token: '--color-artifact-zscore', fallback: '#ff7b72' },
  peak_to_peak: { token: '--color-artifact-pp', fallback: '#ffb454' },
  flat_line: { token: '--color-artifact-flat', fallback: '#8b949e' },
  ica_eog: { token: '--color-artifact-ica', fallback: '#a78bfa' },
}

/** Описание картинки снапшота: всё, что нужно нарисовать, без обращения к React. */
export type SnapshotScene = {
  title: string
  subtitle: string
  window: TimeWindow
  /** Ширина области треков на экране, px (колонка подписей добавляется сюда же) */
  trackWidth: number
  /** Каналы в порядке отрисовки: имя + готовый canvas uPlot (если уже отрисован) */
  tracks: { name: string; canvas: HTMLCanvasElement | null }[]
  zones: readonly ArtifactZone[]
  epochs: readonly EpochCell[]
  showZones: boolean
  showEpochBoundaries: boolean
  showDroppedEpochs: boolean
  /** Подпись шкалы: «общая ±100 мкВ» или «авто по каналу» */
  scaleLabel: string
  sizes?: SnapshotSizes
}

/** Тема снапшота: hex-fallback из `styles/index.css` (canvas не читает токены). */
function snapshotTheme(doc: Document) {
  return {
    background: themeColor(doc, '--color-bg-1', '#121a24'),
    label: themeColor(doc, '--color-fg-0', '#eef3f9'),
    muted: themeColor(doc, '--color-fg-2', '#8695a8'),
    border: themeColor(doc, '--color-border', '#2c3a4d'),
    danger: themeColor(doc, '--color-danger', '#ff6b6b'),
  }
}

/**
 * Собирает PNG-снапшот окна: шапка (файл, окно, уровень), треки из canvas'ов
 * uPlot с подписями каналов, зоны артефактов, сетка эпох, легенда и шкала
 * времени. Возвращает готовый холст; кодирование в PNG — в `download.ts`.
 *
 * Если 2D-контекст недоступен (jsdom), холст возвращается пустым: экспорт — не
 * то место, где стоит падать.
 */
export function drawSnapshot(scene: SnapshotScene, doc: Document = document): HTMLCanvasElement {
  const layout = snapshotLayout(scene.tracks.length, scene.trackWidth, scene.sizes ?? SNAPSHOT_SIZES)
  const canvas = doc.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas

  const theme = snapshotTheme(doc)
  const left = layout.labelWidth + layout.padding
  const tracksTop = layout.headerHeight
  const tracksBottom = layout.headerHeight + scene.tracks.length * layout.trackHeight
  const font = '11px system-ui, sans-serif'

  ctx.fillStyle = theme.background
  ctx.fillRect(0, 0, layout.width, layout.height)

  // Шапка: файл + окно/уровень/шкала/каналы
  ctx.fillStyle = theme.label
  ctx.font = `600 13px system-ui, sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillText(scene.title, layout.padding, 8)
  ctx.fillStyle = theme.muted
  ctx.font = font
  ctx.fillText(scene.subtitle, layout.padding, 24)

  // Подсветка зон и отброшенных эпох — под треками, как в DOM-слоях
  const marks = epochMarks(scene.epochs, scene.window, layout.trackWidth, {
    boundaries: scene.showEpochBoundaries,
    dropped: scene.showDroppedEpochs,
  })
  for (const rect of marks.dropped) {
    ctx.fillStyle = withAlpha(theme.danger, 0.12)
    ctx.fillRect(left + rect.x, tracksTop, rect.width, tracksBottom - tracksTop)
  }
  if (scene.showZones) {
    for (const rect of zoneRects(scene.zones, scene.window, layout.trackWidth)) {
      const kind = rect.kind as ArtifactKind
      const token = ZONE_TOKENS[kind]
      ctx.fillStyle = withAlpha(themeColor(doc, token.token, token.fallback), 0.18)
      ctx.fillRect(left + rect.x, tracksTop, rect.width, tracksBottom - tracksTop)
    }
  }
  if (scene.showEpochBoundaries) {
    ctx.strokeStyle = withAlpha(theme.muted, 0.5)
    ctx.lineWidth = 1
    for (const x of marks.boundaries) {
      ctx.beginPath()
      ctx.moveTo(left + x, tracksTop)
      ctx.lineTo(left + x, tracksBottom)
      ctx.stroke()
    }
  }

  // Треки: canvas uPlot как есть + подпись канала в своей колонке
  ctx.textBaseline = 'middle'
  scene.tracks.forEach((track, index) => {
    const top = layout.trackTops[index] as number
    ctx.fillStyle = theme.label
    ctx.font = font
    ctx.textAlign = 'right'
    ctx.fillText(track.name, layout.labelWidth, top + layout.trackHeight / 2)
    ctx.textAlign = 'left'

    if (track.canvas) {
      ctx.drawImage(track.canvas, left, top, layout.trackWidth, layout.trackHeight)
    } else {
      // Трек ещё не отрисован (например, нет 2D-контекста) — рамка вместо линий
      ctx.strokeStyle = withAlpha(theme.border, 0.6)
      ctx.strokeRect(left + 0.5, top + 0.5, layout.trackWidth - 1, layout.trackHeight - 1)
    }
    // Разделитель треков: сигналы каналов не должны сливаться визуально
    ctx.strokeStyle = withAlpha(theme.border, 0.7)
    ctx.beginPath()
    ctx.moveTo(layout.padding, top + layout.trackHeight - 0.5)
    ctx.lineTo(left + layout.trackWidth, top + layout.trackHeight - 0.5)
    ctx.stroke()
  })

  // Шкала времени: деления считаются из окна, а не берутся из оси uPlot
  ctx.fillStyle = theme.muted
  ctx.font = font
  ctx.textBaseline = 'top'
  for (const tick of timeTicks(scene.window, layout.trackWidth)) {
    ctx.fillText(tick.label, left + tick.x + 2, tracksBottom + 2)
  }

  // Подвал: легенда видимых типов зон + подпись шкалы амплитуды
  const legendKinds = scene.showZones
    ? (Object.keys(ZONE_TOKENS) as ArtifactKind[]).filter((kind) =>
        scene.zones.some((zone) => zone.kind === kind),
      )
    : []
  let x = layout.padding
  ctx.textBaseline = 'middle'
  const legendY = layout.headerHeight + scene.tracks.length * layout.trackHeight - layout.footerHeight / 2 - 4
  for (const kind of legendKinds) {
    const token = ZONE_TOKENS[kind]
    const color = themeColor(doc, token.token, token.fallback)
    ctx.fillStyle = withAlpha(color, 0.35)
    ctx.fillRect(x, legendY - 4, 10, 8)
    ctx.strokeStyle = color
    ctx.strokeRect(x + 0.5, legendY - 3.5, 9, 7)
    x += 16
    ctx.fillStyle = theme.muted
    ctx.fillText(ARTIFACT_SHORT_LABELS[kind], x, legendY)
    x += ctx.measureText(ARTIFACT_SHORT_LABELS[kind]).width + 14
  }
  ctx.fillStyle = theme.muted
  ctx.textAlign = 'right'
  ctx.fillText(scene.scaleLabel, layout.width - layout.padding, legendY)
  ctx.textAlign = 'left'

  return canvas
}
