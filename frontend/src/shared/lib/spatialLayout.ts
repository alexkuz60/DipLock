/**
 * Пространственная раскладка источников «Нейромузыки» — чистая математика
 * без Web Audio (docs/rules/spatial-audio.md, п.1).
 *
 * Семь полосовых треков стоят на дуге перед слушателем: слева низкие частоты
 * (δ), справа высокие (γ-high). Координаты — правая тройка Web Audio:
 * X вправо, Y вверх, Z от слушателя (по умолчанию слушатель смотрит вдоль −Z),
 * поэтому «перед слушателем» — это отрицательный Z.
 */

/** Максимальный азимут края дуги при полном разбросе, градусы. */
export const ARC_DEG = 60
/** Расстояние источника от слушателя, метры (в Panner3D — refDistance). */
export const SOURCE_DISTANCE_M = 1.5

export type SourcePosition = {
  x: number
  y: number
  z: number
}

/** Азимут источника под индексом: −ARC…+ARC, масштабируется разбросом. */
export function sourceAzimuthDeg(index: number, count: number, spread: number): number {
  if (count <= 1) return 0
  const unit = index / (count - 1) // 0…1 по дуге слева направо
  // Сначала строим позицию на полной дуге, потом схлопываем к центру:
  // spread=0 должен дать азимут 0 для ВСЕХ источников, а не −ARC.
  return (-ARC_DEG + 2 * ARC_DEG * unit) * clamp01(spread)
}

/**
 * Позиция источника под индексом на дуге.
 *
 * `spread` 0…1: 0 — все источники в точке перед слушателем, 1 — полная дуга
 * ±{@link ARC_DEG}°. Дистанция постоянна (равномерная громкость по дуге).
 */
export function sourcePosition(
  index: number,
  count: number,
  spread: number,
  distance: number = SOURCE_DISTANCE_M,
): SourcePosition {
  const azimuthDeg = sourceAzimuthDeg(index, count, spread)
  const azimuthRad = (azimuthDeg * Math.PI) / 180
  return {
    x: distance * Math.sin(azimuthRad),
    y: 0,
    z: -distance * Math.cos(azimuthRad),
  }
}

/** Позиции всех источников (по умолчанию 7 полос). */
export function sourcePositions(
  count: number,
  spread: number,
  distance: number = SOURCE_DISTANCE_M,
): SourcePosition[] {
  return Array.from({ length: count }, (_, index) => sourcePosition(index, count, spread, distance))
}

/**
 * Проценты UI → параметры узлов Tone.js с зажатием диапазона.
 *
 * Ширина базы: UI-проценты 0…150 (100 — без изменения) → width Tone 0…0.75,
 * где 0.5 — no change (свойство StereoWidener: Mid *= 2(1−w), Side *= 2w).
 * Влажность реверберации: 0…100 % → wet 0…1 (линейный dry/wet).
 */
export function widthParam(widthPct: number): number {
  return clamp01(widthPct / 200)
}

/** Разброс дуги (0…100 % → 0…1). */
export function spreadParam(spreadPct: number): number {
  return clamp01(spreadPct / 100)
}

/** Влажность реверберации (0…100 % → wet 0…1). */
export function wetParam(wetPct: number): number {
  return clamp01(wetPct / 100)
}

// --- «Монтаж»: 4 модуля рядов и силуэт BrainRoom (срез 07.10.2026) -------------
// Геометрия зеркалит backend `audio_render/bake.py` (тот же spread, те же
// полудуги): запечённый WAV и живой граф стоят в одной сцене.

/** Лобной ряд: узкая дуга к лбу, полудуга при полном разбросе, градусы. */
export const FRONTAL_HALF_DEG = 30
/** Затылочный: зеркало лобной — тоже узкое. */
export const OCCIPITAL_HALF_DEG = 30
/** Теменной: смещён в тыл, широкая дуга к затылку. */
export const PARIETAL_HALF_DEG = 60
/** Височный: прямая линия на уровне ушей вдоль X (Z = 0), метры. */
export const TEMPORAL_HALF_M = 1.5
/** Пропорции вида сверху BrainRoom: ширина : длина = 1.0 : 1.3. */
export const ROOM_LENGTH_RATIO = 1.3

function polar(azimuthDeg: number): SourcePosition {
  const azimuthRad = (azimuthDeg * Math.PI) / 180
  return {
    x: SOURCE_DISTANCE_M * Math.sin(azimuthRad),
    y: 0,
    z: -SOURCE_DISTANCE_M * Math.cos(azimuthRad),
  }
}

/**
 * Позиция источника модуля «Монтажа» (спецификация владельца 07.10.2026):
 * frontal — дуга к лбу (±30°·spread), temporal — прямая линия ушей
 * (X −1.5…+1.5 м, Z=0), parietal — тыл 180°±60°·spread,
 * occipital — зеркало лобной (180°±30°·spread). ``spread`` 0…1 схлопывает
 * модуль к его центру; неизвестный ряд — ошибка (в UI приходят только
 * ряды из статуса рендера).
 */
export function moduleSourcePosition(
  row: string,
  index: number,
  count: number,
  spread: number,
): SourcePosition {
  const unit = count <= 1 ? 0 : (index / (count - 1)) * 2 - 1
  const scaled = unit * clamp01(spread)
  switch (row) {
    case 'frontal':
      return polar(FRONTAL_HALF_DEG * scaled)
    case 'temporal':
      return { x: TEMPORAL_HALF_M * scaled, y: 0, z: 0 }
    case 'parietal':
      return polar(180 + PARIETAL_HALF_DEG * scaled)
    case 'occipital':
      return polar(180 + OCCIPITAL_HALF_DEG * scaled)
    default:
      throw new Error(`Неизвестный ряд модуля «Монтажа»: ${row}`)
  }
}

/**
 * Проекция точки сцены на силуэт BrainRoom (вид сверху): ``u`` −1…1 вправо,
 * ``v`` −1…1 **вперёд** (фронт сверху). Координаты нормированы на
 * пропорции комнаты 1.0 : 1.3 (длина по Z шире) — «деформация сферы»
 * из ТЗ; эллипс стен рисуется как (u, v) = единичный круг.
 */
export function brainroomProject(x: number, z: number): { u: number; v: number } {
  return {
    u: x / SOURCE_DISTANCE_M,
    v: -z / (SOURCE_DISTANCE_M * ROOM_LENGTH_RATIO),
  }
}

/** Точка силуэта: позиция сцены + ряд (для «Монтажа», иначе undefined). */
export type ScenePoint = SourcePosition & { row?: string }

/**
 * Все точки текущей сцены для силуэта: «Экспресс» — дуга ±60° из полос,
 * «Монтаж» — ряды × полосы в геометрии модулей.
 */
export function scenePoints(options: {
  variant: 'express' | 'montage'
  rows: readonly string[]
  bands: number
  spread: number
}): ScenePoint[] {
  const { variant, rows, bands, spread } = options
  if (variant === 'montage') {
    return rows.flatMap((row) =>
      Array.from({ length: bands }, (_, index) => ({
        ...moduleSourcePosition(row, index, bands, spread),
        row,
      })),
    )
  }
  return Array.from({ length: bands }, (_, index) => sourcePosition(index, bands, spread))
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}
