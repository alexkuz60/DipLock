/**
 * Тестовый энкодер контейнера спектрограммы (формат `SpectrogramGridHeader`).
 *
 * Используется тестами разбора (`eegSpectrogram.test.ts`) и моком API: формат
 * меняется синхронно с бэкендом (`app/services/spectrogram.py`), поэтому
 * «похожий» контейнер в тестах означал бы непроверенный разбор.
 */

export type SpectrogramBlobHeader = {
  recording_id: string
  channel: string
  window_ms: number
  overlap_pct: number
  fmax_hz: number
  sfreq: number
  n_fft: number
  n_freqs: number
  n_times: number
  db_min: number
  db_max: number
  dtype: 'float32'
  byte_order: 'little'
  layout: 'frequency-major'
}

/** Собирает контейнер ``DPS2``: magic | uint32 LE длина заголовка | JSON | float32 LE. */
export function encodeSpectrogramBlob(
  header: SpectrogramBlobHeader,
  values: number[] | Float32Array,
): ArrayBuffer {
  const payload = new Float32Array(values)
  const raw = new TextEncoder().encode(JSON.stringify(header))
  const buffer = new ArrayBuffer(8 + raw.length + payload.byteLength)
  const bytes = new Uint8Array(buffer)
  bytes.set([0x44, 0x50, 0x53, 0x32], 0) // 'DPS2'
  new DataView(buffer).setUint32(4, raw.length, true)
  bytes.set(raw, 8)
  // Копия побайтово: заголовок JSON не выровнен по 4 байта, а Float32Array
  // требует выровненного смещения — ровно та же осторожность, что при разборе
  bytes.set(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), 8 + raw.length)
  return buffer
}

/** Заголовок моковой сетки: 3 частоты (шаг 10 Гц) × 4 окна по 500 мс. */
export const spectrogramBlobHeaderFixture: SpectrogramBlobHeader = {
  recording_id: 'rec-1',
  channel: 'Fp1',
  window_ms: 1000,
  overlap_pct: 75,
  fmax_hz: 40,
  sfreq: 250,
  n_fft: 256,
  n_freqs: 3,
  n_times: 4,
  db_min: -60,
  db_max: 0,
  dtype: 'float32',
  byte_order: 'little',
  layout: 'frequency-major',
}

/** Значения сетки (частото-мажорно): по 4 окна на каждую из 3 частот. */
export const spectrogramBlobValuesFixture = [
  0, -10, -20, -30,
  -40, -30, -20, -10,
  -5, -25, -45, -60,
]

/** Контейнер моковой сетки — то, что отдал бы бэкенд. */
export function spectrogramBlobFixture(): ArrayBuffer {
  return encodeSpectrogramBlob(spectrogramBlobHeaderFixture, spectrogramBlobValuesFixture)
}
