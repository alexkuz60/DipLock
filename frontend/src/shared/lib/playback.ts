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
import { atlasLabels, type DipolePoint } from './dipolePoints'
import type { MniVector } from './mriProjections'
import type { DipoleScanResult } from '@/shared/api/types'

/** Скорости воспроизведения: 1 — реальное время записи, 2 и 4 — ускорение */
export const PLAYBACK_SPEEDS = [1, 2, 4] as const

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
  return result.points.length > 0 && result.n_epochs_total > 0 && result.epoch_length_ms > 0
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
 * между точкой эпохи `epochIndex` и точкой следующей эпохи.
 *
 * `null` — в этой эпохе диполя нет (эпоха отброшена): кадр остаётся пустым, а не
 * «дотягивается» от соседней эпохи. Если у следующей эпохи точки нет или доля
 * нулевая, кадр — **измеренная** точка своей эпохи (id, эпоха, время пика, GOF и
 * поле Бродмана всегда берутся у неё: это измеренные величины, их не размываем).
 */
export function interpolatedPoint(
  points: Map<number, DipolePoint>,
  epochIndex: number,
  fraction: number,
): DipolePoint | null {
  const current = points.get(epochIndex) ?? null
  if (!current) return null
  const next = points.get(epochIndex + 1) ?? null
  if (!next || !(fraction > 0)) return current
  const f = Math.min(1, Math.max(0, fraction))
  return {
    ...current,
    position: {
      x: lerp(current.position.x, next.position.x, f),
      y: lerp(current.position.y, next.position.y, f),
      z: lerp(current.position.z, next.position.z, f),
    },
    orientation: slerpUnit(current.orientation, next.orientation, f),
    amplitudeNaM: lerp(current.amplitudeNaM, next.amplitudeNaM, f),
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
export type AnatomyLabels = { structure: string | null; area: string | null }

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
  const parts = [labels.structure, labels.area].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : ANATOMY_UNKNOWN_TEXT
}

/**
 * Ближайшая **смена** анатомии впереди: на какой эпохе диполь оказывается в
 * другой структуре или поле.
 *
 * Идём только по непрерывной цепочке эпох с точками: эпоха без диполя — это
 * разрыв в данных, и «протягивать» через неё переход нельзя (`null`) — то же
 * правило, что у интерполяции кадра и шлейфа. Отсутствие метки (`null`) —
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
  const current = points.get(epochIndex)
  if (!current) return null
  const currentLabels = atlasLabels(current)
  // Не больше эпох, чем есть в карте: цикл конечен даже на «дырявой» нарезке
  for (let step = 0, index = epochIndex + 1; step < points.size; step++, index++) {
    const candidate = points.get(index)
    // Разрыв (эпоха отброшена нарезкой или у точки нет MNI): «перехода» нет
    if (!candidate) return null
    const labels = atlasLabels(candidate)
    if (labels.structure !== currentLabels.structure || labels.area !== currentLabels.area) {
      return { epochIndex: index, timeMs: candidate.timeMs, labels }
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
 * Шлейф к текущему кадру: отрезки между точками соседних эпох за последние
 * `TRAIL_WINDOW_MS` сессии, гаснущие с возрастом.
 *
 * Сегменты строятся **по измеренным точкам**, а не по интерполированным
 * положениям: шлейф — это история измерений, и «дорисовывать» промежуточные
 * положения там, где их никто не считал, нельзя. Через разрыв (эпоху, у которой
 * точки нет) шлейф не тянется: вместо сквозного отрезка получаются два.
 *
 * Возраст считается по **новому** концу отрезка, поэтому сегмент, примыкающий к
 * кадру, самый свежий и самый плотный; эпохи старше окна не рисуются вовсе.
 *
 * `minAmplitudeNam` — порог «КД»: он правило **отображения**, и шлейф подчиняется
 * ему так же, как облако и маркер кадра. Отрезок не рисуется, если слабее порога
 * хотя бы один из его концов: иначе шлейф вёл бы к точке, которой на проекциях нет.
 */
export function trailSegments(
  points: Map<number, DipolePoint>,
  epochIndex: number,
  epochLengthMs: number,
  minAmplitudeNam = 0,
): TrailSegment[] {
  if (!(epochLengthMs > 0) || points.size < 2) return []
  const span = Math.max(1, Math.min(TRAIL_MAX_SEGMENTS, Math.ceil(TRAIL_WINDOW_MS / epochLengthMs)))
  const segments: TrailSegment[] = []
  for (let start = epochIndex - span; start < epochIndex; start++) {
    if (start < 0) continue
    const from = points.get(start)
    const to = points.get(start + 1)
    if (!from || !to) continue
    if (from.amplitudeNaM < minAmplitudeNam || to.amplitudeNaM < minAmplitudeNam) continue
    const age = Math.max(0, epochIndex - (start + 1)) * epochLengthMs
    const alpha = TRAIL_ALPHA_HEAD * Math.max(0, 1 - age / TRAIL_WINDOW_MS)
    if (alpha < TRAIL_ALPHA_MIN) continue
    segments.push({ id: `${start}-${start + 1}`, from: from.position, to: to.position, alpha })
  }
  return segments
}
