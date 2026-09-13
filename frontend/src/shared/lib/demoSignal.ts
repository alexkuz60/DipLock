/**
 * Синтетический сигнал для отладки вьюера без бэкенда (срез 2.3).
 *
 * Это фикстура разработки: вьюер рисует её по кнопке «Демо-сигнал», пока
 * эндпоинт сигналов записи (срез 2.5) не подключён. Реальные данные придут
 * с тем же контрактом: каналы, sfreq, длительность, массивы по каналам в мкВ.
 */

export type SignalData = {
  channels: string[]
  sfreq: number
  durationSec: number
  /** Полноразрешённые данные по каналам, мкВ */
  data: Record<string, Float32Array>
}

/**
 * Каналы демо-режима — набор монтажа 10-20 как в наших записях.
 * Это фикстура, а не источник истины: реальный монтаж приходит из /api/v1/meta.
 */
export const DEMO_CHANNELS = [
  'F3', 'F4', 'C3', 'C4', 'P3', 'P4', 'O1', 'O2',
  'F7', 'F8', 'T7', 'T8', 'P7', 'P8', 'Fz', 'Cz', 'Pz', 'Oz',
]

/** Детерминированный ГПСЧ (mulberry32): демо-данные одинаковы между запусками. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type DemoOptions = {
  durationSec?: number
  sfreq?: number
  seed?: number
}

/**
 * Генерирует запись: у каждого канала свой ритм (5–11 Гц) + высокочастотная
 * составляющая + шум; два «артефактных» всплеска на 30 % и 70 % длительности —
 * именно они должны пережить min/max-огибающую при любом зуме.
 */
export function makeDemoSignal(
  channels: string[] = DEMO_CHANNELS,
  options: DemoOptions = {},
): SignalData {
  const durationSec = options.durationSec ?? 30
  const sfreq = options.sfreq ?? 250
  const rand = mulberry32(options.seed ?? 42)
  const n = Math.round(durationSec * sfreq)
  const data: Record<string, Float32Array> = {}

  channels.forEach((name, index) => {
    const arr = new Float32Array(n)
    const slowHz = 5 + (index % 7)
    const fastHz = 20 + (index % 5) * 3
    const amplitudeUv = 25 + (index % 6) * 5
    for (let i = 0; i < n; i++) {
      const t = i / sfreq
      arr[i] =
        amplitudeUv * Math.sin(2 * Math.PI * slowHz * t + index) +
        6 * Math.sin(2 * Math.PI * fastHz * t) +
        (rand() - 0.5) * 8
    }
    for (const fraction of [0.3, 0.7]) {
      const at = Math.round(n * fraction)
      for (let k = -25; k <= 25; k++) {
        const p = at + k
        if (p >= 0 && p < n) {
          arr[p] += Math.exp(-(k * k) / 50) * 150 * (index % 3 === 0 ? 1 : 0.5)
        }
      }
    }
    data[name] = arr
  })

  return { channels: [...channels], sfreq, durationSec, data }
}
