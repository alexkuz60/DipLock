/**
 * Спиральный след момента (срез 3.11) — чистая математика, без DOM.
 *
 * Шлейф кончика луча момента вдоль траектории: между соседними **измеренными**
 * точками позиция идёт по прямой, направление момента — по кратчайшей дуге
 * (`slerpUnit`), и кончик луча `pos(t) + L·Q(t)` описывает винтовую кривую.
 * Каждый переход эпоха → эпоха — «виток» шлейфа: он окрашен по знаку поворота
 * момента и гаснет с возрастом.
 *
 * Рисуется **затухающий шлейф последних витков**, а не весь след: окно в
 * времени сессии и угасание — те же, что у шлейфа кадра анимации
 * (`playback.ts`: `TRAIL_WINDOW_MS`, `TRAIL_ALPHA_HEAD`…): «хвост» истории
 * читается лучше сплошной ленты из сотен витков.
 *
 * Знак (по/против часовой) **не определён в 3D абстрактно** — только
 * относительно оси наблюдения (разбор «спирального вращения», срез 3.11 в
 * `docs/ui/dipoles.md`). Поэтому:
 * - на проекции знак — «вид на экране этой проекции»: 2D-векторное произведение
 *   экранных проекций Q_from → Q_to (экран с вертикалью «вверх», как рисует
 *   `dipoleMarker`);
 * - в 3D знак — относительно вертикальной оси MNI (+z, «вид сверху»): он
 *   зафиксирован относительно головы, а не камеры, и при вращении сцены цвета
 *   не «плавают».
 *
 * Фолбэки «нет вращения» (`none`, нейтральный цвет): момент вдоль нормали
 * среза (на проекции его не видно), почти совпадающие/противонаправленные Q
 * (slerp держит первое направление — вращения нет), нулевой момент.
 *
 * След — **отображение интерполяции**, а не измерение (правило `playback.ts`):
 * промежуточных направлений в результате задачи нет. Дуги строятся между
 * соседними измеренными точками **включая через разрыв** (эпоха без диполя) —
 * как «хвост» перехода (сглаживание разрывов, 17.10.2026).
 */
import { bandVectorPx } from './bandColors'
import {
  NO_THRESHOLDS,
  dipoleVectorDirection,
  dipoleVectorLength,
  pointPassesThresholds,
  type DisplayThresholds,
  type DipolePoint,
} from './dipolePoints'
import {
  PROJECTION_SCALE,
  projectPoint,
  type MniVector,
  type PixelPoint,
  type ProjectionPlane,
} from './mriProjections'
import { TRAIL_ALPHA_HEAD, TRAIL_ALPHA_MIN, TRAIL_WINDOW_MS, lerp, slerpUnit } from './playback'

/** Знак поворота момента на дуге; `none` — вращение на этой оси наблюдения не видно. */
export type RotationSense = 'ccw' | 'cw' | 'none'

/** Сэмпл дуги: интерполированные позиция и направление момента (отображение). */
export type SpiralSample = {
  position: MniVector
  orientation: MniVector
}

/** Дуга спирального шлейфа: переход между соседними измеренными точками. */
export type SpiralArc = {
  /** Ключ React: `полоса:эпоха-эпоха` (уникален среди источников кадра) */
  id: string
  from: DipolePoint
  to: DipolePoint
  /** Сэмплы вдоль дуги, включая концы (их кончики луча — точки витка) */
  samples: SpiralSample[]
}

/** Виток затухающего шлейфа: дуга плюс её непрозрачность (гаснет с возрастом). */
export type SpiralTrailArc = SpiralArc & {
  /** Непрозрачность витка: `TRAIL_ALPHA_HEAD` у свежего, дальше линейно к нулю */
  alpha: number
}

/** Сэмплов на дугу (виток кривой читается плавной линией, а не ломаной из 2 точек). */
export const SPIRAL_SAMPLES_PER_ARC = 8

/**
 * Бюджет витков шлейфа: при малой длине эпохи окно вмещало бы сотни витков —
 * шлейф остаётся «хвостом», а не вторым рисунком траектории (роль
 * `TRAIL_MAX_SEGMENTS` у шлейфа кадра).
 */
export const SPIRAL_MAX_ARCS = 120

/** Штрих витка — фиксированный экранный размер (как у луча и шлейфа). */
export const SPIRAL_STROKE_PX = 1.5

/** Цвета знака поворота (токены темы): CCW/CW — вид на проекции, `none` — нейтральный. */
export const SPIRAL_SENSE_COLORS: Record<RotationSense, string> = {
  ccw: 'var(--color-mri-spiral-ccw)',
  cw: 'var(--color-mri-spiral-cw)',
  none: 'var(--color-mri-spiral-neutral)',
}

/** Единичный вектор; нулевой остаётся нулевым (знака нет). */
function unitVector(v: MniVector): MniVector {
  const length = Math.hypot(v.x, v.y, v.z)
  if (!(length > 0)) return { x: 0, y: 0, z: 0 }
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}

/** Косинус угла между направлениями (зажат в [−1, 1]; нулевой вектор → 0). */
function unitDot(a: MniVector, b: MniVector): number {
  const ua = unitVector(a)
  const ub = unitVector(b)
  return Math.min(1, Math.max(-1, ua.x * ub.x + ua.y * ub.y + ua.z * ub.z))
}

/** Тот же порог «вращения нет», что у фолбэков `slerpUnit`. */
const SPIRAL_COLLINEAR_DOT = 0.9995

/** Порог «поворот не виден»: проекция/ось вращения перпендикулярна взгляду. */
const SPIRAL_MIN_CROSS = 1e-6


/**
 * Затухающий шлейф витков по точкам одного источника (полосы пакета или
 * одиночного расчёта). Только **завершённые** переходы не позже текущей эпохи
 * (`epochIndex` — «сейчас» кадра; путь «в будущее» — не история), окно —
 * последние `TRAIL_WINDOW_MS` времени сессии, непрозрачность гаснет с возрастом
 * (возраст — по **новому** концу витка, как у шлейфа кадра). Виток, чей хоть
 * один конец слабее порогов отображения, не рисуется. Через разрыв (эпоха без
 * диполя) виток строится между соседними измеренными точками — движение через
 * разрыв продолжается (17.10.2026).
 */
export function spiralTrailArcs(
  points: readonly DipolePoint[],
  epochIndex: number,
  epochLengthMs: number,
  thresholds: DisplayThresholds = NO_THRESHOLDS,
  samplesPerArc: number = SPIRAL_SAMPLES_PER_ARC,
): SpiralTrailArc[] {
  if (!(epochLengthMs > 0)) return []
  const ordered = [...points]
    .filter((point) => point.epochIndex <= epochIndex)
    .sort((left, right) => left.epochIndex - right.epochIndex)
  const arcs: SpiralTrailArc[] = []
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const from = ordered[index - 1]
    const to = ordered[index]
    const age = Math.max(0, epochIndex - to.epochIndex) * epochLengthMs
    const alpha = TRAIL_ALPHA_HEAD * Math.max(0, 1 - age / TRAIL_WINDOW_MS)
    if (alpha < TRAIL_ALPHA_MIN) break
    if (pointPassesThresholds(from, thresholds) && pointPassesThresholds(to, thresholds)) {
      const samples: SpiralSample[] = []
      for (let step = 0; step <= samplesPerArc; step += 1) {
        const t = step / samplesPerArc
        samples.push({
          position: {
            x: lerp(from.position.x, to.position.x, t),
            y: lerp(from.position.y, to.position.y, t),
            z: lerp(from.position.z, to.position.z, t),
          },
          orientation: slerpUnit(from.orientation, to.orientation, t),
        })
      }
      arcs.push({
        id: `${from.band?.key ?? 'single'}:${from.epochIndex}-${to.epochIndex}`,
        from,
        to,
        samples,
        alpha,
      })
    }
    if (arcs.length >= SPIRAL_MAX_ARCS) break
  }
  return arcs.reverse()
}

/**
 * Знак поворота момента на дуге — **вид на экране проекции**: знак
 * 2D-векторного произведения экранных проекций Q_from → Q_to. С экраном
 * согласован `dipoleMarker`: горизонталь `u`, вертикаль `v` «вверх», поэтому
 * `cross > 0` — поворот против часовой, как видит пользователь.
 */
export function arcSenseOnPlane(arc: SpiralArc, plane: ProjectionPlane): RotationSense {
  const from = dipoleVectorDirection(plane, arc.from.orientation)
  const to = dipoleVectorDirection(plane, arc.to.orientation)
  // Момент вдоль нормали среза: на этой проекции его не видно — вращения нет
  if ((from.u === 0 && from.v === 0) || (to.u === 0 && to.v === 0)) return 'none'
  // Почти совпадающие/противонаправленные: slerp держит первое направление
  if (Math.abs(unitDot(arc.from.orientation, arc.to.orientation)) > SPIRAL_COLLINEAR_DOT) {
    return 'none'
  }
  const cross = from.u * to.v - from.v * to.u
  if (!(Math.abs(cross) > SPIRAL_MIN_CROSS)) return 'none'
  return cross > 0 ? 'ccw' : 'cw'
}

/**
 * Знак поворота момента в 3D: относительно вертикальной оси MNI (+z,
 * «вид сверху»). Знак зафиксирован относительно головы, а не камеры —
 * вращение сцены не меняет цвета витков.
 */
export function arcSense3d(arc: SpiralArc): RotationSense {
  const from = unitVector(arc.from.orientation)
  const to = unitVector(arc.to.orientation)
  if (Math.abs(unitDot(arc.from.orientation, arc.to.orientation)) > SPIRAL_COLLINEAR_DOT) {
    return 'none'
  }
  // z-компонента векторного произведения Q_from × Q_to: ось вращения «на нас»
  const axisZ = from.x * to.y - from.y * to.x
  if (!(Math.abs(axisZ) > SPIRAL_MIN_CROSS)) return 'none'
  return axisZ > 0 ? 'ccw' : 'cw'
}


/**
 * Длина луча-«кончика» дуги, px: полосная длина пакета (та же, что у луча кадра
 * анимации) либо луч якоря по амплитуде (как в облаке одиночного расчёта).
 * На всю дугу длина постоянная — виток не «дышит» по амплитуде.
 */
export function spiralTipLengthPx(arc: SpiralArc): number {
  const band = arc.from.band ?? null
  return band ? bandVectorPx(band.bandHz) : dipoleVectorLength(arc.from.amplitudeNaM)
}

/**
 * Кончики луча дуги на проекции, px: те же формулы, что у `dipoleMarker`
 * (позиция → пиксели, направление → экранные оси, вертикаль инвертирована).
 */
export function spiralTipsPx(arc: SpiralArc, plane: ProjectionPlane): PixelPoint[] {
  const vectorPx = spiralTipLengthPx(arc)
  return arc.samples.map((sample) => {
    const at = projectPoint(plane, sample.position)
    const direction = dipoleVectorDirection(plane, sample.orientation)
    return {
      x: at.x + direction.u * vectorPx,
      y: at.y - direction.v * vectorPx,
    }
  })
}

/**
 * Кончики луча дуги в 3D, мм MNI: длина в миллиметрах та же, что в пикселях
 * проекции (`PROJECTION_SCALE` px/мм) — виток выглядит одинаково во видах.
 */
export function spiralTipsMm(arc: SpiralArc): MniVector[] {
  const tipMm = spiralTipLengthPx(arc) / PROJECTION_SCALE
  return arc.samples.map((sample) => {
    const orientation = unitVector(sample.orientation)
    return {
      x: sample.position.x + orientation.x * tipMm,
      y: sample.position.y + orientation.y * tipMm,
      z: sample.position.z + orientation.z * tipMm,
    }
  })
}

/** Подпись знака для тултипа витка (проекция; в 3D свой текст не нужен). */
export function spiralSenseLabel(sense: RotationSense): string {
  if (sense === 'ccw') return 'поворот момента против часовой (вид на этой проекции)'
  if (sense === 'cw') return 'поворот момента по часовой (вид на этой проекции)'
  return 'поворот момента на этой проекции не виден'
}
