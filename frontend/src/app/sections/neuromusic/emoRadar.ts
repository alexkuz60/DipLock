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

/**
 * Лучи кадра в другом **динамическом диапазоне** шкалы: проценты радиуса окна
 * `[fromFloorDb … 0]` дБ переносятся в окно `[toFloorDb … 0]` дБ
 * (оба порога — отрицательные: `db_floor` контракта). Формула — обратная
 * карте `db_rays` бэкенда (`services/audio_render/emo_radar.py`):
 * `pct = 100·db/floor` → `pct₂ = pct · fromFloor/toFloor`, зажим 0…100.
 *
 * Параметр «Динамический диапазон» панели «ЕмоЛаб» (−96…0 / −60…0 / −40…0
 * дБ) переносит шкалу лучей без пересчёта анализа. Кадры пишутся с порогом
 * −60 дБ (тишина глубже — 0 %), поэтому в более широком окне (−96…0) всё
 * ниже −60 дБ остаётся на нуле — данные кадров ниже порога не сохраняются.
 * Негодные пороги (0, NaN, не отрицательные) — масштаб 1 (копия с зажимом);
 * нечисловые значения лучей — 0 (как у `starPolygon`).
 */
export function raysDbRange(
  rays: readonly number[],
  fromFloorDb: number,
  toFloorDb: number,
): number[] {
  const scale =
    Number.isFinite(fromFloorDb) &&
    Number.isFinite(toFloorDb) &&
    fromFloorDb < 0 &&
    toFloorDb < 0
      ? fromFloorDb / toFloorDb
      : 1
  return rays.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return Math.min(100, Math.max(0, value * scale))
  })
}

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
