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

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}
