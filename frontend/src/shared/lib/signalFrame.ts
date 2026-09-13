/**
 * Кадр сигнала для вьюера треков (срез 2.5): огибающая min/max по уровням зума.
 *
 * Вьюер не грузит ЭЭГ целиком: на уровне ×k сервер отдаёт не больше
 * `signal_base_points × k` точек на канал (docs/ui.md §8), каждая точка —
 * минимум и максимум по временной корзине. Поэтому пики артефактов видны на
 * любом зуме, а размер ответа не зависит от длины записи.
 *
 * Здесь же разбор бинарного контейнера бэкенда (``RecordingSignalsHeader``):
 * ``'DPS1'`` | ``uint32 LE len(header)`` | JSON-заголовок | float32 LE payload
 * (канало-мажорно: min, max — либо только max при `decimated=false`).
 */
import type { SignalData } from './demoSignal'

export const SIGNAL_MAGIC = 'DPS1'

/** Заголовок контейнера сигналов (формат ответа `GET /recordings/{id}/signals`). */
export type SignalContainerHeader = {
  recording_id: string
  level: number
  channels: string[]
  sfreq: number
  duration_sec: number
  n_points: number
  decimated: boolean
  arrays_per_channel: number
  dtype: string
  byte_order: string
  layout: string
}

/**
 * Кадр сигнала: общие для каналов времена корзин + min/max по каналам.
 *
 * `sourceId` различает записи: смена кадра при зуме не должна сбрасывать окно
 * просмотра, а вот смена источника — должна.
 */
export type SignalFrame = {
  /** Источник кадра: id записи или `'demo'` */
  sourceId: string
  /** Каналы в порядке отрисовки (монтаж) */
  channels: string[]
  durationSec: number
  /** Времена центров корзин, секунды (возрастают) */
  times: Float32Array
  /** Минимум по корзине, мкВ (при `decimated=false` совпадает с `max`) */
  min: Record<string, Float32Array>
  /** Максимум по корзине, мкВ */
  max: Record<string, Float32Array>
  /** true — данные уже прорежены по корзинам (min/max), false — отсчёты как есть */
  decimated: boolean
  /** Уровень пирамиды (0 — полноразрешённые данные, например демо-сигнал) */
  level: number
}

export class SignalDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignalDecodeError'
  }
}

/** Времена центров равномерных корзин: единственное, что не отдаёт сервер. */
function uniformTimes(nPoints: number, durationSec: number): Float32Array {
  const times = new Float32Array(nPoints)
  const dt = nPoints > 0 ? durationSec / nPoints : 0
  for (let i = 0; i < nPoints; i++) times[i] = (i + 0.5) * dt
  return times
}

/**
 * Разбирает контейнер сигналов в кадр вьюера.
 *
 * Времена корзин восстанавливаются из `duration_sec / n_points`: корзины
 * равномерны, поэтому погрешность не превышает половины корзины (на уровне ×1
 * это доли секунды — визуально незаметно).
 */
export function decodeSignalFrame(buffer: ArrayBuffer): SignalFrame {
  if (buffer.byteLength < 8) {
    throw new SignalDecodeError('Ответ сигналов пуст или обрезан')
  }
  const bytes = new Uint8Array(buffer)
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  if (magic !== SIGNAL_MAGIC) {
    throw new SignalDecodeError(`Неожиданный формат сигналов (${magic})`)
  }

  const headerLength = new DataView(buffer).getUint32(4, true)
  const headerEnd = 8 + headerLength
  if (headerEnd > buffer.byteLength) {
    throw new SignalDecodeError('Заголовок сигналов выходит за границы ответа')
  }
  let header: SignalContainerHeader
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, headerEnd)))
  } catch {
    throw new SignalDecodeError('Заголовок сигналов не читается (не JSON)')
  }
  if (
    header.dtype !== 'float32' ||
    header.byte_order !== 'little' ||
    header.layout !== 'channel-major'
  ) {
    throw new SignalDecodeError('Поддерживается только float32 LE channel-major')
  }

  const nChannels = header.channels.length
  const arrays = header.arrays_per_channel === 2 ? 2 : 1
  const nPoints = header.n_points
  const expected = nChannels * arrays * nPoints * 4
  if (buffer.byteLength - headerEnd !== expected) {
    throw new SignalDecodeError(
      `Размер данных сигналов не совпал: ${buffer.byteLength - headerEnd} вместо ${expected}`,
    )
  }

  // Копия payload: заголовок JSON не выровнен по 4 байта, а Float32Array требует
  // выровненного смещения (slice даёт буфер с нулевым offset).
  const payload = new Float32Array(buffer.slice(headerEnd))
  const times = uniformTimes(nPoints, header.duration_sec)
  const min: Record<string, Float32Array> = {}
  const max: Record<string, Float32Array> = {}
  header.channels.forEach((name, index) => {
    if (arrays === 2) {
      min[name] = payload.subarray(index * 2 * nPoints, (index * 2 + 1) * nPoints)
      max[name] = payload.subarray((index * 2 + 1) * nPoints, (index * 2 + 2) * nPoints)
    } else {
      const row = payload.subarray(index * nPoints, (index + 1) * nPoints)
      min[name] = row
      max[name] = row
    }
  })

  return {
    sourceId: header.recording_id,
    channels: [...header.channels],
    durationSec: header.duration_sec,
    times,
    min,
    max,
    decimated: header.decimated,
    level: header.level,
  }
}

/**
 * Уровень пирамиды для множителя зума.
 *
 * `levels` приходят из `/meta` (`signal_levels`) и могут отличаться от
 * дискретных ×1…×16 UI: берём минимальный доступный уровень не ниже множителя,
 * иначе — самый подробный из доступных.
 */
export function resolveSignalLevel(factor: number, levels: number[]): number {
  const sorted = [...levels].filter((level) => level > 0).sort((a, b) => a - b)
  if (!sorted.length) return factor
  return sorted.find((level) => level >= factor) ?? sorted[sorted.length - 1]!
}

/**
 * Кадр для показа: точный уровень, иначе ближайший загруженный.
 *
 * Пока нужный уровень грузится, показываем ближайший — переключение зума не
 * мигает пустотой, а подпись под треками честно говорит, какой уровень виден.
 * При равном удалении предпочитаем более подробный (больший) уровень.
 */
export function selectFrame(
  frames: Record<number, SignalFrame>,
  level: number,
): SignalFrame | null {
  const exact = frames[level]
  if (exact) return exact
  const loaded = Object.keys(frames)
    .map(Number)
    .filter((value) => frames[value])
    .sort((a, b) => {
      const distance = Math.abs(a - level) - Math.abs(b - level)
      return distance !== 0 ? distance : b - a
    })
  return loaded.length ? frames[loaded[0]!]! : null
}

/**
 * Кадр из полноразрешённого сигнала (демо-фикстура, срез 2.3).
 * `min == max`: огибающая совпадает с линией, как и у неразреженных данных.
 */
export function frameFromSignalData(signal: SignalData, sourceId = 'demo'): SignalFrame {
  const nPoints = Math.max(1, Math.round(signal.durationSec * signal.sfreq))
  const times = new Float32Array(nPoints)
  for (let i = 0; i < nPoints; i++) times[i] = i / signal.sfreq

  const min: Record<string, Float32Array> = {}
  const max: Record<string, Float32Array> = {}
  for (const name of signal.channels) {
    const row = signal.data[name] ?? new Float32Array(0)
    min[name] = row
    max[name] = row
  }
  return {
    sourceId,
    channels: [...signal.channels],
    durationSec: signal.durationSec,
    times,
    min,
    max,
    decimated: false,
    level: 0,
  }
}

