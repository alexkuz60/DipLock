/**
 * Вращение звезды-полигона «Эмо» по тональности микса (спецификация владельца
 * 09.10.2026, `docs/rules/neuromusic.md` §«Эмо», «Вращение звезды»).
 *
 * Тональность сегмента микса — из VAMP Key Detector (`key_track` кадров
 * `GET /audio/render/{id}/emo`, `services/audio_render/vamp_analysis.py`).
 * Правила владельца:
 *
 * - мажор — вращение **против часовой** стрелки (+), C = 0, C# = +δ … B = +11δ;
 * - минор — **по часовой** (−), Am = 0, Abm = −δ … Bbm = −11δ (нисходящий
 *   хроматический ряд от A);
 * - единица смещения δ = 1/12 сектора, секторов 7 (по 1/7 круга) →
 *   δ = 2π/84 = π/42 рад ≈ 4.2857°.
 *
 * Угол кадра — из активного сегмента тональности, между кадрами сетки 2/3 с
 * — **линейная интерполяция** (решение владельца: плавный доворот, как у
 * лучей). Доминанты считаются **после** вращения полигона. Чистая математика
 * без DOM — покрыта `keyRotation.test.ts`; применяет `RadialChart.tsx`.
 */
import type { AudioEmoFrame, AudioKeySegment } from '@/shared/api/types'

/**
 * Шаг вращения δ, рад: 1/12 сектора (сектор — 2π/7) → 2π/84 = π/42.
 * Максимум ±11δ ≈ ±47.14° — диапазон не пересекает разрыв окружности,
 * поэтому интерполяция угла — простая линейная, без shortest-path.
 */
export const KEY_DELTA_RAD = Math.PI / 42

/** Коды тональности QM Key Detector: 1…24 (1…12 мажор, 13…24 минор). */
export const KEY_CODE_MIN = 1
export const KEY_CODE_MAX = 24

/**
 * Угол вращения полигона для кода тональности QM, рад (справа — шаг в δ):
 *
 * - мажор (код 1…12): `+(код−1)·δ` — C=0, C#=+1 … B=+11 (против часовой);
 * - минор (код 13…24): `−((9 − (код−13)) mod 12)·δ` — Am=0, Abm=−1,
 *   Gm=−2 … Bbm=−11 (по часовой, хроматический спуск от A);
 * - код вне 1…24 либо не число — 0 (нет вращения).
 */
export function keyRotationRad(keyCode: number): number {
  if (!Number.isFinite(keyCode)) return 0
  const code = Math.round(keyCode)
  if (code < KEY_CODE_MIN || code > KEY_CODE_MAX) return 0
  if (code <= 12) return (code - 1) * KEY_DELTA_RAD
  const tonic = code - 13 // тоника минора: 0 = C … 11 = B
  const stepsDownFromA = ((9 - tonic) % 12 + 12) % 12
  // Am = 0 — чистый +0 (не −0: Object.is(-0, 0) === false).
  return stepsDownFromA === 0 ? 0 : -stepsDownFromA * KEY_DELTA_RAD
}

/**
 * Активный сегмент тональности в момент `tSec` — последний с `t_sec ≤ tSec`
 * (сегмент длится до следующего, как в `frameRotations`); до первого сегмента,
 * пустой/`null` трек либо нечисловое время — `null` (тональность не определена).
 * Источник для счётчика «Аккорд» у графика «Эмо» (`neuromusic/EmoCounters.tsx`).
 */
export function activeKeySegment(
  keyTrack: readonly AudioKeySegment[] | null | undefined,
  tSec: number,
): AudioKeySegment | null {
  if (!keyTrack || keyTrack.length === 0) return null
  const time = Number.isFinite(tSec) ? tSec : Number.NEGATIVE_INFINITY
  let active: AudioKeySegment | null = null
  for (const segment of keyTrack) {
    if (segment.t_sec <= time) active = segment
    else break
  }
  return active
}

/**
 * Угол вращения каждого кадра, рад: для кадра берётся тональность
 * активного сегмента `key_track` (последний с `t_sec ≤ t` кадра; сегмент
 * длится до следующего). До первого сегмента — 0 (тональность не
 * определена). `null`/пустой трек — нули на все кадры (вращение выключено).
 * Длина ряда — длина `frames` (параллельный ряд, как лучи).
 */
export function frameRotations(
  keyTrack: readonly AudioKeySegment[] | null | undefined,
  frames: readonly Pick<AudioEmoFrame, 't_sec'>[],
): number[] {
  const rotations = new Array<number>(frames.length).fill(0)
  if (!keyTrack || keyTrack.length === 0) return rotations
  let segmentIndex = -1
  frames.forEach((frame, index) => {
    while (
      segmentIndex + 1 < keyTrack.length &&
      (keyTrack[segmentIndex + 1]?.t_sec ?? Number.POSITIVE_INFINITY) <= frame.t_sec
    ) {
      segmentIndex += 1
    }
    const segment = segmentIndex >= 0 ? keyTrack[segmentIndex] : undefined
    rotations[index] = segment ? keyRotationRad(segment.key_code) : 0
  })
  return rotations
}

/**
 * Угол в момент `tSec`, рад: линейная интерполяция пофреймового ряда
 * `rotations` между слайдами `floor`/`ceil` сетки `hopSec` (та же семантика,
 * что у `emoRadar.interpolatedRays`: хвосты держатся, некорректное время —
 * первый слайд). `null` — нет ряда либо сетки.
 */
export function interpolatedRotation(
  rotations: readonly number[],
  frames: readonly Pick<AudioEmoFrame, 't_sec'>[],
  hopSec: number,
  tSec: number,
): number | null {
  const first = frames[0]
  if (!first || !(hopSec > 0) || rotations.length === 0) return null
  const time = Number.isFinite(tSec) ? tSec : first.t_sec
  const position = (time - first.t_sec) / hopSec
  const index = Math.min(rotations.length - 1, Math.max(0, Math.floor(position)))
  const from = rotations[index] ?? 0
  const to = rotations[Math.min(rotations.length - 1, index + 1)] ?? from
  const frac = Math.min(1, Math.max(0, position - index))
  return from + (to - from) * frac
}