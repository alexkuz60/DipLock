/**
 * Квинтово-квартовый круг тональностей (постановка владельца 23.10.2026):
 * гармонический закон вращения звезды «Эмо» и раскладка активного круга
 * (внешнее кольцо — 12 мажоров, внутреннее — 12 миноров, как на образце
 * akkordov.net/articles/circle-of-fifths).
 *
 * **Гармонический закон** (владелец, 23.10.2026): те же 12 позиций для
 * мажора и минора; звезда смещается на `P` тиков по `δ = 1/12` сектора
 * (сектор = 1/7 круга) — на позицию найденного в круге аккорда, а не на
 * `N/12` полного круга. Позиция `P` = `(7·(semitone + (минор ? 3 : 0))) mod 12`:
 * шаг по кругу — квинта вверх (7 полутонов), минор стоит на позиции своего
 * параллельного мажора (`Am ↔ C`, `Em ↔ G`, …). Направление сдвига — как в
 * хроматическом законе: мажор `+` (против часовой), минор `−` (по часовой).
 *
 * **Подсветки активного круга** (легенда образца): тоника (заливка),
 * суб/доминанта (тёмная заливка), параллельная (обводка), одноимённая
 * (пунктир) — роли всех 24 ячеек для активного кода тональности.
 *
 * Чистая математика без DOM — покрыта `keyCircle.test.ts`; вращение
 * применяет `neuromusic/keyRotation.ts`, круг рисует
 * `emolab/CircleOfFifths.tsx`.
 */
import type { RadialPoint } from './radialChart'

/** Внешнее кольцо: 12 мажоров по часовой от верха (квинтовый ход). */
export const CIRCLE_MAJORS: readonly string[] = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F',
]

/** Внутреннее кольцо: 12 миноров, позиция = позиция параллельного мажора. */
export const CIRCLE_MINORS: readonly string[] = [
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm',
]

/** Подписи знаков альтерации у внешнего кольца (0, 1♯ … 1♭) — как на образце. */
export const CIRCLE_SIGNATURES: readonly string[] = [
  '0', '1♯', '2♯', '3♯', '4♯', '5♯', '6♯/6♭', '5♭', '4♭', '3♭', '2♭', '1♭',
]

/** Роль ячейки круга для активной тональности (легенда образца). */
export type CircleRole = 'tonic' | 'dominant' | 'subdominant' | 'parallel' | 'sameName' | null

/** Ячейка круга: кольцо (`major` — внешнее, `minor` — внутреннее) и позиция 0…11. */
export type CircleSlot = {
  readonly ring: 'major' | 'minor'
  readonly position: number
  /** Полутон тоники 0…11 (C = 0 … B = 11) — для одноимённого лада. */
  readonly semitone: number
}

/** Коды тональности QM/Chordino: 1…24 (1…12 мажор, 13…24 минор). */
const KEY_CODE_MIN = 1
const KEY_CODE_MAX = 24

/**
 * Ячейка круга для кода тональности 1…24: мажор (код 1…12) — внешнее кольцо,
 * минор (13…24) — внутреннее; позиция `P = (7·(semitone + (минор ? 3 : 0)))
 * mod 12` (квинтовый ход по часовой, минор — на позиции параллельного
 * мажора). Код вне 1…24 либо не число — `null`.
 */
export function circleSlotOf(keyCode: number): CircleSlot | null {
  if (!Number.isFinite(keyCode)) return null
  const code = Math.round(keyCode)
  if (code < KEY_CODE_MIN || code > KEY_CODE_MAX) return null
  const minor = code > 12
  const semitone = minor ? code - 13 : code - 1 // тоника: C = 0 … B = 11
  const position = (7 * (semitone + (minor ? 3 : 0))) % 12
  return { ring: minor ? 'minor' : 'major', position, semitone }
}

/**
 * Имя ячейки круга для кода тональности («C», «Am») — базовое имя без
 * надстроек аккорда; код вне 1…24 — `null`.
 */
export function circleNameOf(keyCode: number): string | null {
  const slot = circleSlotOf(keyCode)
  if (!slot) return null
  return (slot.ring === 'major' ? CIRCLE_MAJORS : CIRCLE_MINORS)[slot.position] ?? null
}

/**
 * Роли всех 24 ячеек круга для активной тональности `keyCode` (легенда
 * образца): тоника — сам аккорд; доминанта/субдоминанта — соседние позиции
 * своего кольца (`P±1`, квинта вверх/вниз по кругу); параллельная — та же
 * позиция другого кольца (`Am ↔ C`); одноимённая — та же тоника другого лада
 * (позиция `(7·(semitone + 3)) mod 12` для мажора, `(7·semitone) mod 12` для
 * минора). Код вне 1…24 — все роли `null`.
 */
export function circleHighlightRoles(keyCode: number): {
  readonly major: readonly CircleRole[]
  readonly minor: readonly CircleRole[]
} {
  const empty: readonly CircleRole[] = Array.from({ length: 12 }, () => null)
  const major: CircleRole[] = [...empty]
  const minor: CircleRole[] = [...empty]
  const slot = circleSlotOf(keyCode)
  if (!slot) return { major, minor }
  const own = slot.ring === 'major' ? major : minor
  const other = slot.ring === 'major' ? minor : major
  const otherPos = (7 * (slot.semitone + (slot.ring === 'major' ? 3 : 0))) % 12
  own[slot.position] = 'tonic'
  own[(slot.position + 1) % 12] = 'dominant'
  own[(slot.position + 11) % 12] = 'subdominant'
  other[slot.position] = 'parallel'
  other[otherPos] = 'sameName'
  return { major, minor }
}

/** Ширина ячейки круга, град: 12 позиций × 30° = 360°. */
const CELL_DEG = 30

/**
 * Точка круга в градусах: 0° — верх (12 часов), отсчёт **по часовой**
 * (раскладка образца: C/Am вверху, G/Em правее). `deg` дробный — для границ
 * ячеек (`±15°` от центра).
 */
function polar(cx: number, cy: number, radius: number, deg: number): RadialPoint {
  const rad = (deg * Math.PI) / 180
  return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) }
}

/** Центр ячейки `position` (0…11) на радиусе `radius` — точка подписи. */
export function circleLabelPoint(
  cx: number,
  cy: number,
  radius: number,
  position: number,
): RadialPoint {
  return polar(cx, cy, radius, position * CELL_DEG)
}

/**
 * Путь SVG ячейки-сектора `position` (0…11) кольца `rInner…rOuter`: внешняя
 * дуга по часовой (sweep 1), радиус, внутренняя дуга обратно (sweep 0), замыкание.
 */
export function circleCellPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  position: number,
): string {
  const a1 = position * CELL_DEG - CELL_DEG / 2
  const a2 = position * CELL_DEG + CELL_DEG / 2
  const o1 = polar(cx, cy, rOuter, a1)
  const o2 = polar(cx, cy, rOuter, a2)
  const i2 = polar(cx, cy, rInner, a2)
  const i1 = polar(cx, cy, rInner, a1)
  return [
    `M ${o1.x.toFixed(3)} ${o1.y.toFixed(3)}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${o2.x.toFixed(3)} ${o2.y.toFixed(3)}`,
    `L ${i2.x.toFixed(3)} ${i2.y.toFixed(3)}`,
    `A ${rInner} ${rInner} 0 0 0 ${i1.x.toFixed(3)} ${i1.y.toFixed(3)}`,
    'Z',
  ].join(' ')
}