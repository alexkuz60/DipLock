/**
 * Геометрия карты-силуэта головы: точки датчиков и подписи в единицах viewBox.
 *
 * Позиции приходят из `/meta` (`channel_positions`) — «научная» проекция
 * монтажа; здесь они доводятся до читаемой картинки (чистая функция: ничего
 * не управляет, только считает координаты):
 *
 * 1. **Центральный ряд** T7–C3–Cz–C4–T8 выравнивается по одной горизонтали:
 *    монтаж даёт им разный y (−0.14…−0.08), а глазу прямая линия читается
 *    как единый ряд.
 * 2. **Боковой ряд** F7/F8/T7/T8/P7/P8 сдвигается наружу по x — к контуру
 *    головы: с внутренним кольцом (F3/F4, C3/C4, P3/P4) точки слипались.
 * 3. **Подпись** ищет первое свободное место среди кандидатов «снаружи по
 *    радиусу → выше точки → ниже → внутрь». Кандидат проходит, только если
 *    подпись (а) не пересекает ни одну точку, (б) не наезжает на уже
 *    поставленные подписи, (в) ближе к своей точке, чем к чужой (иначе
 *    читается как чужая), (г) целиком внутри viewBox и контура головы. Если
 *    ни один не прошёл — остаётся снаружи (как раньше): лучше чуть тесно,
 *    чем без подписи.
 *
 * Каналы без позиции уходят в `rest` — UI рисует их чекбоксами под картой.
 */

/** Размер viewBox: контур головы, нос и уши целиком внутри поля */
export const VIEW = 220
export const CENTER = VIEW / 2
/** Радиус контура головы (нос и уши уходят за него) */
export const HEAD_R = 92
/** Радиус, на котором стоят датчики: единица нормированных координат */
const SENSOR_R = 74
/** Радиус видимой точки датчика */
export const DOT_R = 6.5
/** Радиус прозрачной зоны клика и кольца фокуса */
export const HIT_R = 10

/** Центральный ряд монтажа: выравнивается по одной горизонтали */
const ROW_CHANNELS = ['T7', 'C3', 'Cz', 'C4', 'T8']
/** Боковой ряд монтажа: раздвигается к контуру головы */
const LATERAL_CHANNELS = ['F7', 'F8', 'T7', 'T8', 'P7', 'P8']
/** Насколько боковой ряд сдвигается наружу (множитель |x|) */
const LATERAL_SPREAD = 1.15
/** Предел раздвинутой точки: подписи обязаны помещаться внутри контура */
const MAX_UNIT_RADIUS = 1.02
/** Полувысота подписи (моно 9 px) в единицах viewBox */
const HALF_H = 3.8
/** Запас вокруг точки при проверке пересечения */
const DOT_CLEARANCE = DOT_R + 1
/** Личный зазор «точка → подпись» (к проекции подписи на радиус) */
const LABEL_GAP = 4
/** Минимальный зазор между двумя подписями */
const LABEL_PADDING = 1.5

/** Датчик на карте: точка и подпись в координатах viewBox */
export type SensorNode = { name: string; x: number; y: number; labelX: number; labelY: number }

/** Результат компоновки: размещённые датчики и каналы без позиции */
export type HeadMapLayout = { sensors: SensorNode[]; rest: string[] }

/** Полуширина подписи: моно 9 px ≈ 5.4 px/знак + запас */
function halfW(name: string): number {
  return name.length * 2.7 + 1
}

type Dot = { name: string; x: number; y: number }
type Box = { cx: number; cy: number; hw: number; hh: number }

/** Расстояние от центра круга до бокса (0 — пересечение) */
function circleBoxGap(box: Box, cx: number, cy: number): number {
  const dx = Math.max(Math.abs(cx - box.cx) - box.hw, 0)
  const dy = Math.max(Math.abs(cy - box.cy) - box.hh, 0)
  return Math.hypot(dx, dy)
}

/** Разрыв двух боксов: отрицательный — пересечение */
function boxGap(a: Box, b: Box): { x: number; y: number } {
  return {
    x: Math.abs(a.cx - b.cx) - (a.hw + b.hw),
    y: Math.abs(a.cy - b.cy) - (a.hh + b.hh),
  }
}


/** Кандидаты подписи в порядке предпочтения */
function labelCandidates(name: string, x: number, y: number): { cx: number; cy: number }[] {
  const rPx = Math.hypot(x - CENTER, y - CENTER)
  const dirX = rPx > 1 ? (x - CENTER) / rPx : 0
  const dirY = rPx > 1 ? (y - CENTER) / rPx : -1 // центральный датчик — подпись выше
  const proj = Math.abs(dirX) * halfW(name) + Math.abs(dirY) * HALF_H
  const gap = DOT_R + LABEL_GAP + proj
  const candidates = [
    // снаружи по радиусу — привычный вид карты (dir уже в экранных координатах)
    { cx: CENTER + dirX * (rPx + gap), cy: CENTER + dirY * (rPx + gap) },
    // выше / ниже точки
    { cx: x, cy: y - (DOT_R + LABEL_GAP + HALF_H) },
    { cx: x, cy: y + (DOT_R + LABEL_GAP + HALF_H) },
  ]
  // снаружи, но подогнанный под контур: у краёв (O1/O2) полный зазор уводил
  // бы подпись за линию головы — сначала пробуем сжатый, потом «выше/ниже»
  const fitR = HEAD_R - proj - 0.5
  if (fitR < rPx + gap - 0.2 && fitR - rPx > 6) {
    candidates.splice(1, 0, { cx: CENTER + dirX * fitR, cy: CENTER + dirY * fitR })
  }
  // внутрь — только если от точки ещё есть куда отодвинуться
  if (rPx - gap > 12) {
    candidates.push({ cx: CENTER + dirX * (rPx - gap), cy: CENTER + dirY * (rPx - gap) })
  }
  return candidates
}

/** Кандидат допустим: внутри поля и контура, не трогает точки и подписи, ближе к своему */
function fits(box: Box, dot: Dot, dots: Dot[], labels: Box[]): boolean {
  if (
    box.cx - box.hw < 1 ||
    box.cx + box.hw > VIEW - 1 ||
    box.cy - box.hh < 1 ||
    box.cy + box.hh > VIEW - 1
  ) {
    return false
  }
  // Углы бокса — внутри контура головы
  for (const cornerX of [box.cx - box.hw, box.cx + box.hw]) {
    for (const cornerY of [box.cy - box.hh, box.cy + box.hh]) {
      if (Math.hypot(cornerX - CENTER, cornerY - CENTER) > HEAD_R) return false
    }
  }
  // Нет пересечения ни с одной точкой (включая свою)
  for (const other of dots) {
    if (circleBoxGap(box, other.x, other.y) <= DOT_CLEARANCE) return false
  }
  // Подпись ближе к своей точке — иначе читается как чужая
  const ownDist = Math.hypot(dot.x - box.cx, dot.y - box.cy)
  for (const other of dots) {
    if (other.name === dot.name) continue
    if (Math.hypot(other.x - box.cx, other.y - box.cy) <= ownDist + 0.5) return false
  }
  // Не наезжает на уже поставленные подписи
  for (const other of labels) {
    const gap = boxGap(box, other)
    if (gap.x < LABEL_PADDING && gap.y < LABEL_PADDING) return false
  }
  return true
}

/**
 * Компоновка карты: точки датчиков и их подписи в единицах viewBox.
 *
 * `channels` — каналы панели (порядок монтажа сохраняется), `positions` —
 * нормированные координаты из `/meta`. Каналы с негодной позицией уходят в
 * `rest` — UI рисует их чекбоксами под картой.
 */
export function layoutSensors(
  channels: string[],
  positions: Record<string, number[]>,
): HeadMapLayout {
  const parsed: { name: string; ux: number; uy: number }[] = []
  const rest: string[] = []
  for (const name of channels) {
    const xy = positions[name]
    // Нормировка сервера держит координаты в [-1, 1] (+запас): всё, что дальше,
    // — негодная позиция, а не «датчик за контуром»
    if (
      xy &&
      xy.length >= 2 &&
      Number.isFinite(xy[0]) &&
      Number.isFinite(xy[1]) &&
      Math.abs(xy[0]!) <= 1.05 &&
      Math.abs(xy[1]!) <= 1.05
    ) {
      parsed.push({ name, ux: xy[0]!, uy: xy[1]! })
    } else {
      rest.push(name)
    }
  }

  // 1. Центральный ряд — общий y (среднее по присутствующим каналам ряда)
  const row = parsed.filter((entry) => ROW_CHANNELS.includes(entry.name))
  if (row.length > 1) {
    const rowY = row.reduce((sum, entry) => sum + entry.uy, 0) / row.length
    for (const entry of row) entry.uy = rowY
  }

  // 2. Боковой ряд — наружу по x, с ограничением радиуса (подписи внутри контура)
  for (const entry of parsed) {
    if (!LATERAL_CHANNELS.includes(entry.name)) continue
    entry.ux *= LATERAL_SPREAD
    const radius = Math.hypot(entry.ux, entry.uy)
    if (radius > MAX_UNIT_RADIUS) {
      entry.ux *= MAX_UNIT_RADIUS / radius
      entry.uy *= MAX_UNIT_RADIUS / radius
    }
  }

  // Точки — сначала все: подписи ищут место относительно полного набора
  const dots: Dot[] = parsed.map((entry) => ({
    name: entry.name,
    x: CENTER + entry.ux * SENSOR_R,
    y: CENTER - entry.uy * SENSOR_R,
  }))

  // 3. Подписи — первая подходящая позиция кандидата
  const labels: Box[] = []
  const sensors: SensorNode[] = parsed.map((entry, index) => {
    const dot = dots[index]!
    const name = entry.name
    const hw = halfW(name)
    let chosen: { cx: number; cy: number } | null = null
    let first: { cx: number; cy: number } | null = null
    for (const candidate of labelCandidates(name, dot.x, dot.y)) {
      const box: Box = { cx: candidate.cx, cy: candidate.cy, hw, hh: HALF_H }
      if (!first) first = candidate
      if (fits(box, dot, dots, labels)) {
        chosen = candidate
        break
      }
    }
    const label = chosen ?? first!
    labels.push({ cx: label.cx, cy: label.cy, hw, hh: HALF_H })
    return { name, x: dot.x, y: dot.y, labelX: label.cx, labelY: label.cy }
  })

  return { sensors, rest }
}

