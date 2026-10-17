/**
 * Воспроизведение траектории диполей (срез 3.7) — чистая математика кадра.
 *
 * Быстрый расчёт даёт **одну точку на эпоху** (`epoch_index`, `time_ms` — пик GFP
 * внутри эпохи), поэтому «движение» диполя строится по сетке нарезки: время
 * сессии `t` растёт непрерывно, эпоха считается как `floor(t / epoch_length_ms)`,
 * а кадр внутри эпохи — интерполяция между её точкой и точкой следующей эпохи.
 *
 * **Интерполяция — отображение, а не измерение**: промежуточных положений в
 * результате задачи нет, и выдавать их за данные нельзя. Поэтому:
 * - интерполяция идёт только между **соседними** эпохами, у которых есть точки;
 *   у отброшенных эпох диполя нет, и «протягивать» его через дыру в данных
 *   запрещено (кадр в такой эпохе пуст);
 * - на паузе и при шаге кадр равен измеренной точке своей эпохи (доля 0);
 * - подписи в UI называют кадр кадром воспроизведения, а не измерением.
 *
 * Длительность воспроизведения — вся нарезка результата
 * (`n_epochs_total × epoch_length_ms`), поэтому скорость ×1 — реальное время
 * записи: на `test.edf` это 261 эпоха × 500 мс ≈ 130 с.
 *
 * Модуль чистый (без DOM и zustand): состояние — `shared/state/dipoleCalc.ts`,
 * часы и отрисовка — `app/sections/dipoles/PlaybackFrame.tsx`.
 */
import {
  atlasLabels,
  attributionText,
  pointPassesThresholds,
  NO_THRESHOLDS,
  type DisplayThresholds,
  type DipolePoint,
  type PointAttribution,
} from './dipolePoints'
import type { MniVector } from './mriProjections'
import type { DipoleScanResult } from '@/shared/api/types'

/**
 * Скорости воспроизведения: **0.25 и 0.5 — замедление** (поправка ручной проверки,
 * 18.09.2026: на ×1 подписи кадра не успеть прочитать), 1 — реальное время записи,
 * 2 и 4 — ускорение.
 */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4] as const

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = 1

/** Сохранённая/присланная скорость приводится к одной из доступных. */
export function normalizePlaybackSpeed(value: number): PlaybackSpeed {
  return (PLAYBACK_SPEEDS as readonly number[]).includes(value)
    ? (value as PlaybackSpeed)
    : DEFAULT_PLAYBACK_SPEED
}

/**
 * Есть ли по чему воспроизводить. Нужны и точки (иначе кадры пусты), и сетка
 * эпох: по ней считается длительность и номер кадра.
 */
export function canPlayback(result: DipoleScanResult | null): boolean {
  if (!result) return false
  return (result.points?.length ?? 0) > 0 && result.n_epochs_total > 0 && result.epoch_length_ms > 0
}

/** Длительность воспроизведения, мс: вся нарезка эпох результата. */
export function playbackDurationMs(epochLengthMs: number, totalEpochs: number): number {
  if (!(epochLengthMs > 0) || totalEpochs <= 0) return 0
  return epochLengthMs * totalEpochs
}

/** Номер эпохи, зажатый в сетку нарезки. */
export function clampEpochIndex(epochIndex: number, totalEpochs: number): number {
  if (totalEpochs <= 0 || !Number.isFinite(epochIndex)) return 0
  return Math.min(totalEpochs - 1, Math.max(0, Math.floor(epochIndex)))
}

/**
 * Номер эпохи для времени сессии, мс. Время зажимается сеткой нарезки: часовой
 * цикл может «перелететь» конец записи на кадр, а эпохи за её границей нет.
 */
export function epochAtTime(timeMs: number, epochLengthMs: number, totalEpochs: number): number {
  if (!(epochLengthMs > 0) || totalEpochs <= 0) return 0
  return clampEpochIndex(timeMs / epochLengthMs, totalEpochs)
}

/**
 * Доля внутри эпохи, 0…1: 0 — начало эпохи, 0.5 — её середина. На паузе и при
 * шаге доля нулевая, поэтому кадр равен измеренной точке, а не «полутону».
 */
export function epochFraction(timeMs: number, epochLengthMs: number): number {
  if (!(epochLengthMs > 0)) return 0
  const within = timeMs - Math.floor(timeMs / epochLengthMs) * epochLengthMs
  const fraction = within / epochLengthMs
  if (!Number.isFinite(fraction)) return 0
  return Math.min(1, Math.max(0, fraction))
}

/** Точки по номеру эпохи: у эпох без диполя (отброшены порогом) записи нет. */
export function pointByEpoch(points: readonly DipolePoint[]): Map<number, DipolePoint> {
  const map = new Map<number, DipolePoint>()
  for (const point of points) map.set(point.epochIndex, point)
  return map
}

/**
 * Линейная интерполяция двух чисел (`fraction` уже зажат вызывающей стороной).
 */
export function lerp(a: number, b: number, fraction: number): number {
  return a + (b - a) * fraction
}

/** Вектор единичной длины; нулевой вектор остаётся нулевым (луча не будет). */
function normalizeVector(v: MniVector): MniVector {
  const length = Math.hypot(v.x, v.y, v.z)
  if (!(length > 0)) return { x: 0, y: 0, z: 0 }
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}

/**
 * Интерполяция **направления** момента (единичные векторы): по большой дуге
 * (slerp), а не по прямой — иначе середина пути «сплющивалась» бы к центру и луч
 * на кадре был бы короче, чем у обеих измеренных точек.
 *
 * Особые случаи взяты явно: у почти совпадающих направлений `sin θ → 0`, и
 * формула slerp делит на ноль (там линейная интерполяция с нормировкой), а у
 * противонаправленных дуга не определена вовсе — произвольное вращение
 * «дорисовывать» нельзя, поэтому остаётся первое направление.
 */
export function slerpUnit(a: MniVector, b: MniVector, fraction: number): MniVector {
  const va = normalizeVector(a)
  const vb = normalizeVector(b)
  const dot = Math.min(1, Math.max(-1, va.x * vb.x + va.y * vb.y + va.z * vb.z))
  if (dot > 0.9995) {
    return normalizeVector({
      x: lerp(va.x, vb.x, fraction),
      y: lerp(va.y, vb.y, fraction),
      z: lerp(va.z, vb.z, fraction),
    })
  }
  if (dot < -0.9995) return va
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  const wa = Math.sin((1 - fraction) * theta) / sinTheta
  const wb = Math.sin(fraction * theta) / sinTheta
  return normalizeVector({
    x: va.x * wa + vb.x * wb,
    y: va.y * wa + vb.y * wb,
    z: va.z * wa + vb.z * wb,
  })
}

/**
 * Кадр воспроизведения: интерполяция позиции, направления момента и амплитуды
 * между соседними **измеренными** точками траектории.
 *
 * Разрывы (эпохи без диполя: отброшены нарезкой/BAD-зонами или без MNI) больше
 * не «мигают» (поправка владельца 17.10.2026): движение между соседними
 * измеренными точками просто **замедляется** — переход занимает время всех
 * эпох между ними, включая заблокированные. Кадр через дыру едет по прямой
 * между этими точками (это отображение, а не измерение — метки ниже), а после
 * последней точки держится на ней до конца нарезки, а не исчезает.
 *
 * Якорь кадра — последняя измеренная точка не позже текущей эпохи (`frameAnchor`):
 * измеренные величины (id, эпоха, время пика, GOF, анатомия) всегда берутся у неё
 * и не «размываются». На паузе и при шаге у эпохи с диполем кадр равен её точке
 * (доля 0); в эпохе без диполя — точке замедленного перехода на её границе
 * (непрерывность движения: пауза не «прыгает» вдоль пути).
 */
export function frameAnchor(
  points: Map<number, DipolePoint>,
  epochIndex: number,
): DipolePoint | null {
  let anchor: DipolePoint | null = null
  for (const point of points.values()) {
    if (point.epochIndex <= epochIndex && (!anchor || point.epochIndex > anchor.epochIndex)) {
      anchor = point
    }
  }
  return anchor
}

/** Следующая измеренная точка после эпохи (`null` — дальше точек в нарезке нет). */
export function nextMeasuredPoint(
  points: Map<number, DipolePoint>,
  epochIndex: number,
): DipolePoint | null {
  let next: DipolePoint | null = null
  for (const point of points.values()) {
    if (point.epochIndex > epochIndex && (!next || point.epochIndex < next.epochIndex)) {
      next = point
    }
  }
  return next
}

export function interpolatedPoint(
  points: Map<number, DipolePoint>,
  epochIndex: number,
  fraction: number,
): DipolePoint | null {
  const anchor = frameAnchor(points, epochIndex)
  if (!anchor) return null
  const next = nextMeasuredPoint(points, anchor.epochIndex)
  // Последняя измеренная точка: кадр держится на ней, пока идёт хвост нарезки
  if (!next) return anchor
  const f = Math.min(1, Math.max(0, fraction))
  // Пауза/шаг на эпохе с диполем — чистое измерение своей эпохи
  if (!(f > 0) && anchor.epochIndex === epochIndex) return anchor
  // Переход идёт во времени всех эпох между точками (замедление на разрывах)
  const span = next.epochIndex - anchor.epochIndex
  const t = Math.min(1, Math.max(0, (epochIndex + f - anchor.epochIndex) / span))
  if (!(t > 0)) return anchor
  return {
    ...anchor,
    position: {
      x: lerp(anchor.position.x, next.position.x, t),
      y: lerp(anchor.position.y, next.position.y, t),
      z: lerp(anchor.position.z, next.position.z, t),
    },
    orientation: slerpUnit(anchor.orientation, next.orientation, t),
    amplitudeNaM: lerp(anchor.amplitudeNaM, next.amplitudeNaM, t),
  }
}

/** Подпись кадра для шапки: эпоха, время её начала и скорость. */
export function playbackSummary(
  epochIndex: number,
  totalEpochs: number,
  timeSec: number,
  speed: PlaybackSpeed,
): string {
  return `Кадр: эпоха ${epochIndex + 1} из ${totalEpochs} · ${timeSec.toFixed(2)} с · ×${speed}`
}

/** Анатомия диполя: структура `aparc+aseg` и поле Бродмана (уже нормализованные). */
export type AnatomyLabels = PointAttribution

/** Переход анатомии впереди: эпоха, на которой диполь оказывается в других метках. */
export type AnatomyChange = {
  /** Номер эпохи, на которой метки стали другими */
  epochIndex: number
  /** Время пика этой эпохи, мс — та же величина, что в подписях точек */
  timeMs: number
  /** Анатомия, в которую диполь «приходит» на этой эпохе */
  labels: AnatomyLabels
}

/** Отсутствие анатомии подписывается словами, а не прочерком: в тексте строки «—» не читается. */
export const ANATOMY_UNKNOWN_TEXT = 'анатомия не определена'

/**
 * Подпись анатомии: «структура, поле» — или честное «анатомия не определена».
 * Структура и поле остаются разными величинами (см. `atlasLabels`), поэтому
 * склеиваются только для чтения, а не в одно поле данных.
 */
export function anatomyText(labels: AnatomyLabels): string {
  return attributionText(labels, ANATOMY_UNKNOWN_TEXT)
}

/**
 * Ближайшая **смена** анатомии впереди: на какой эпохе диполь оказывается в
 * другой структуре или поле.
 *
 * Идём по **измеренным** точкам вперёд от якоря кадра, в том числе через
 * разрывы (поправка 17.10.2026): движение через эпоху без диполя замедляется,
 * но продолжается, поэтому и смена меток за разрывом — реальная веха пути
 * («дальше: эпоха N»), а не потерянный переход. Отсутствие метки (`null`) —
 * такая же величина, как и название: переход «таламус → не определено»
 * показывается, а не прячется.
 *
 * Функция читает **измеренные** точки эпох: кадр между эпохами интерполирован,
 * анатомия — нет (правило модуля), поэтому «дальше» — это не предсказание
 * положения, а следующая измеренная метка.
 */
export function nextAnatomyChange(
  points: Map<number, DipolePoint>,
  epochIndex: number,
): AnatomyChange | null {
  const current = frameAnchor(points, epochIndex)
  if (!current) return null
  const currentLabels = atlasLabels(current)
  const ahead = [...points.values()]
    .filter((point) => point.epochIndex > current.epochIndex)
    .sort((a, b) => a.epochIndex - b.epochIndex)
  for (const candidate of ahead) {
    const labels = atlasLabels(candidate)
    if (labels.structure !== currentLabels.structure || labels.area !== currentLabels.area) {
      return { epochIndex: candidate.epochIndex, timeMs: candidate.timeMs, labels }
    }
  }
  return null
}

/** Подпись перехода для строки кадра: «дальше: эпоха 52 (26.000 с) → …». */
export function anatomyChangeText(change: AnatomyChange): string {
  return `дальше: эпоха ${change.epochIndex + 1} (${(change.timeMs / 1000).toFixed(3)} с) → ${anatomyText(change.labels)}`
}

/**
 * Шлейф траектории: окно в **времени сессии**, а не в числе эпох — «шлейф за
 * последние 10 секунд» остаётся тем же по смыслу при любой длине нарезки.
 */
export const TRAIL_WINDOW_MS = 10_000

/** Плотность шлейфа у самого кадра и порог, ниже которого сегмент не рисуется. */
export const TRAIL_ALPHA_HEAD = 0.6
export const TRAIL_ALPHA_MIN = 0.04

/**
 * Предел числа сегментов: на коротких эпохах окно вмещало бы сотни отрезков, а
 * шлейф нужен как «хвост», а не как второй рисунок облака.
 */
export const TRAIL_MAX_SEGMENTS = 40

/** Сегмент шлейфа: отрезок между двумя **измеренными** точками соседних эпох. */
export type TrailSegment = {
  /** Ключ React: пары эпох, между которыми построен отрезок */
  id: string
  from: MniVector
  to: MniVector
  /** Непрозрачность: у кадра — `TRAIL_ALPHA_HEAD`, дальше гаснет с возрастом */
  alpha: number
}

/**
 * Шлейф к текущему кадру: отрезки между соседними **измеренными** точками за
 * последние `TRAIL_WINDOW_MS` сессии, гаснущие с возрастом.
 *
 * Сегменты строятся по измеренным точкам, а не по интерполированным
 * положениям: шлейф — это история измерений. Через разрыв (эпоху без диполя)
 * шлейф **переходит одним отрезком** между измеренными концами (поправка
 * 17.10.2026: движение через разрыв замедляется, но продолжается — и «хвост»
 * траектории обязан это отражать, а не рваться и не исчезать). Растущий сегмент
 * текущего перехода (от якоря к кадру) рисует маркер кадра (`headSegment`).
 *
 * Возраст считается по **новому** концу отрезка, поэтому сегмент, примыкающий к
 * кадру, самый свежий и самый плотный; отрезки старше окна не рисуются вовсе.
 * В шлейф идут только завершённые переходы (новый конец не позже текущей эпохи):
 * путь «в будущее» — это не история.
 *
 * `thresholds` — пороги отображения (GOF % и момент нА·м): они правило
 * **отображения**, и шлейф подчиняется им так же, как облако и маркер кадра.
 * Отрезок не рисуется, если слабее порогов хотя бы один из его концов: иначе
 * шлейф вёл бы к точке, которой на проекциях нет.
 */
export function trailSegments(
  points: Map<number, DipolePoint>,
  epochIndex: number,
  epochLengthMs: number,
  thresholds: DisplayThresholds = NO_THRESHOLDS,
): TrailSegment[] {
  if (!(epochLengthMs > 0) || points.size < 2) return []
  const measured = [...points.values()]
    .filter((point) => point.epochIndex <= epochIndex)
    .sort((a, b) => a.epochIndex - b.epochIndex)
  const segments: TrailSegment[] = []
  for (let index = measured.length - 1; index > 0; index--) {
    const from = measured[index - 1]
    const to = measured[index]
    const age = Math.max(0, epochIndex - to.epochIndex) * epochLengthMs
    const alpha = TRAIL_ALPHA_HEAD * Math.max(0, 1 - age / TRAIL_WINDOW_MS)
    if (alpha < TRAIL_ALPHA_MIN) break
    if (pointPassesThresholds(from, thresholds) && pointPassesThresholds(to, thresholds)) {
      segments.push({
        id: `${from.epochIndex}-${to.epochIndex}`,
        from: from.position,
        to: to.position,
        alpha,
      })
    }
    if (segments.length >= TRAIL_MAX_SEGMENTS) break
  }
  return segments.reverse()
}
