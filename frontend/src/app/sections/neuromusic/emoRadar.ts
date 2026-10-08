/**
 * Кадры радара «Эмо»: время плеера → 7 лучей с плавной интерполяцией между
 * слайдами (спецификация владельца 08.10.2026, `docs/rules/neuromusic.md`
 * §«Эмо»).
 *
 * Слайды готовит бэкенд (`services/audio_render/emo_radar.py`): окно FFT
 * 32768, сдвиг 32000 сэмплов (перекрытие 768) — слайд k занимает отрезок
 * `[k·hop, (k+1)·hop)` секунд. Здесь — только чистая математика выбора
 * кадра и линейной интерполяции (решение владельца: между слайдами плавный
 * переход, звезда «дышит» по глобальной шкале) — без DOM и сети, покрыто
 * `emoRadar.test.ts`; рисует `RadialChart.tsx`.
 */
import type { AudioEmoFrame } from '@/shared/api/types'

/** Секунд на кадр: `hop_samples / fs_audio` (32000/48000 = 2/3 с). */
export function hopSeconds(hopSamples: number, fsAudio: number): number {
  if (!(hopSamples > 0) || !(fsAudio > 0)) return 0
  return hopSamples / fsAudio
}

/** Индекс слайда для момента `tSec`: `floor(t/hop)`, зажатый в 0…count−1. */
export function frameIndexAt(tSec: number, hopSec: number, frameCount: number): number {
  if (frameCount <= 0 || !(hopSec > 0) || !Number.isFinite(tSec)) return 0
  const index = Math.floor(tSec / hopSec)
  return Math.min(frameCount - 1, Math.max(0, index))
}

/**
 * Лучи (7 штук, % радиуса) в момент `tSec`: линейная интерполяция между
 * слайдами `floor` и `ceil` по сетке `hopSec`; до первого кадра — первый,
 * после последнего — последний (хвост держится). `null` — нет кадров либо
 * сетка не задана. Некорректное время → первый слайд.
 */
export function interpolatedRays(
  frames: readonly AudioEmoFrame[],
  hopSec: number,
  tSec: number,
): number[] | null {
  const first = frames[0]
  if (!first || !(hopSec > 0)) return null
  const last = frames[frames.length - 1]
  if (last === undefined) return null
  const time = Number.isFinite(tSec) ? tSec : first.t_sec
  // Позиция в слайдах относительно первого кадра (t_sec[0] может ≠ 0).
  const position = (time - first.t_sec) / hopSec
  const index = Math.min(frames.length - 1, Math.max(0, Math.floor(position)))
  const from = frames[index]
  if (!from) return [...first.rays]
  const to = frames[Math.min(frames.length - 1, index + 1)] ?? from
  const frac = Math.min(1, Math.max(0, position - index))
  if (frac === 0) return [...from.rays]
  return from.rays.map((value, ray) => {
    const target = to.rays[ray]
    if (target === undefined) return value
    return value + (target - value) * frac
  })
}
