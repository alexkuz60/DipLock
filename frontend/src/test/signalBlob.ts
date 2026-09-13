/**
 * Тестовый энкодер контейнера сигналов (формат `RecordingSignalsHeader`).
 *
 * Используется тестами разбора (`signalFrame.test.ts`) и моком API
 * (`apiMocks.ts`) — так формат контейнера проверяется с обеих сторон.
 */
import type { SignalContainerHeader } from '@/shared/lib/signalFrame'

export type SignalBlobChannel = {
  name: string
  /** Отсчёты (при `decimated=false`) или минимумы (при `decimated=true`) */
  min: number[]
  /** Максимумы; при `decimated=false` совпадает с `min` */
  max: number[]
}

/** Собирает бинарный контейнер: `DPS1` + uint32 LE + JSON + float32 LE. */
export function encodeSignalBlob(
  header: Omit<SignalContainerHeader, 'arrays_per_channel'> & { arrays_per_channel?: number },
  channels: SignalBlobChannel[],
): ArrayBuffer {
  const payload: number[] = []
  for (const channel of channels) {
    if (header.decimated) payload.push(...channel.min)
    payload.push(...channel.max)
  }
  const full: SignalContainerHeader = {
    ...header,
    arrays_per_channel: header.decimated ? 2 : (header.arrays_per_channel ?? 1),
  }

  const headerBytes = new TextEncoder().encode(JSON.stringify(full))
  // Выравниваем заголовок по 4 байта: так payload читается без копии.
  const padded = new Uint8Array(Math.ceil(headerBytes.byteLength / 4) * 4)
  padded.fill(0x20) // пробелы: для JSON.parse это допустимые хвостовые символы
  padded.set(headerBytes)
  const buffer = new ArrayBuffer(8 + padded.byteLength + payload.length * 4)
  const bytes = new Uint8Array(buffer)
  bytes.set(new TextEncoder().encode('DPS1'), 0)
  new DataView(buffer).setUint32(4, padded.byteLength, true)
  bytes.set(padded, 8)
  new Float32Array(buffer, 8 + padded.byteLength, payload.length).set(payload)
  return buffer
}
