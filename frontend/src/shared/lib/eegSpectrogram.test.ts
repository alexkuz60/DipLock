/**
 * Тесты подготовки спектрограммы к отрисовке (срез 5).
 *
 * Проверяется главное свойство раздела: сервер отдаёт **числа**, а палитра, окно
 * дБ и сглаживание считаются на клиенте — без единого запроса. Поэтому тесты
 * держат разбор контейнера ``DPS2``, перевод дБ в цвет, скользящее среднее и
 * выбор столбцов окна (в том числе для режима «обзор записи»).
 */
import { describe, expect, it } from 'vitest'
import { encodeSpectrogramBlob } from '@/test/spectrogramBlob'
import {
  SPECTROGRAM_MAGIC,
  SpectrogramDecodeError,
  boxSmooth,
  dbToUnit,
  decodeSpectrogramGrid,
  demoSpectrogramGrid,
  freqIndexRange,
  gridUrlOf,
  gridValueAt,
  hopMs,
  lowerBound,
  paletteLut,
  paletteRgb,
  smoothSpectrogram,
  spectrogramSummary,
  timeIndexRange,
} from './eegSpectrogram'

const header = {
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
  dtype: 'float32' as const,
  byte_order: 'little' as const,
  layout: 'frequency-major' as const,
}

const values = [0, -10, -20, -30, -40, -30, -20, -10, -5, -25, -45, -60]

describe('контейнер сетки', () => {
  it('разбирает DPS2 в сетку частот и времён', () => {
    const grid = decodeSpectrogramGrid(encodeSpectrogramBlob(header, values))

    expect(SPECTROGRAM_MAGIC).toBe('DPS2')
    expect(grid.channel).toBe('Fp1')
    expect(grid.nFreqs).toBe(3)
    expect(grid.nTimes).toBe(4)
    expect(Array.from(grid.values)).toEqual(values)
    // Частоты равномерны (sfreq / n_fft), времена — центры окон с шагом перекрытия
    expect(grid.freqs[1]).toBeCloseTo(250 / 256, 6)
    expect(grid.times[1]! - grid.times[0]!).toBeCloseTo(0.25, 6)
    expect(gridValueAt(grid, 0, 0)).toBe(0)
    expect(gridValueAt(grid, 2, 3)).toBe(-60)
    // Индексы за границами зажимаются: рисование не выходит за массив
    expect(gridValueAt(grid, 99, 99)).toBe(-60)
  })

  it('сообщает о чужом формате и обрезанном ответе вместо пустой картинки', () => {
    expect(() => decodeSpectrogramGrid(new ArrayBuffer(4))).toThrow(SpectrogramDecodeError)

    const blob = encodeSpectrogramBlob(header, values)
    const broken = blob.slice(0, blob.byteLength - 8)
    expect(() => decodeSpectrogramGrid(broken)).toThrow(/Размер сетки не совпал/)
  })
})

describe('окно просмотра', () => {
  it('отбирает столбцы и строки, `null` — вся сетка', () => {
    const grid = decodeSpectrogramGrid(encodeSpectrogramBlob(header, values))

    expect(timeIndexRange(grid.times, null)).toEqual({ from: 0, to: 3 })
    // Окно уже, чем шаг сетки: в него попадает столбец на 0.5 с, край 0.75 с — граница
    expect(timeIndexRange(grid.times, { t0: 0.5, t1: 0.6 })).toEqual({ from: 0, to: 1 })
    expect(freqIndexRange(grid, null)).toEqual({ from: 0, to: 2 })
    // Окно 0.9–1.1 Гц целиком лежит между строками 0 и 0.9765 Гц
    expect(freqIndexRange(grid, [0.9, 1.1])).toEqual({ from: 1, to: 2 })
    expect(lowerBound(grid.times, 0.7)).toBe(1)
  })

  it('считает шаг сетки по времени из окна и перекрытия', () => {
    const grid = decodeSpectrogramGrid(encodeSpectrogramBlob(header, values))
    expect(hopMs(grid)).toBe(250)
  })
})

describe('цвет и окно дБ', () => {
  it('переводит дБ в 0..1 по окну отображения, зажимая края', () => {
    // Окно задаётся относительно потолка расчёта: [-40, 0] от db_max = 0
    expect(dbToUnit(0, [-40, 0], 0)).toBe(1)
    expect(dbToUnit(-40, [-40, 0], 0)).toBe(0)
    expect(dbToUnit(-20, [-40, 0], 0)).toBeCloseTo(0.5, 6)
    expect(dbToUnit(-100, [-40, 0], 0)).toBe(0)
    expect(dbToUnit(10, [-40, 0], 0)).toBe(1)
    // Вырожденное окно: значение выше потолка — максимум, иначе пол
    expect(dbToUnit(-5, [0, 0], 0)).toBe(0)
  })

  it('даёт одинаковый цвет по краям палитры и таблицу на 256 шагов', () => {
    const low = paletteRgb('viridis', 0)
    const high = paletteRgb('viridis', 1)
    expect(low).not.toEqual(high)
    // Значение вне 0..1 зажимается: пиксель не «переполняет» палитру
    expect(paletteRgb('viridis', 2)).toEqual(high)
    expect(paletteRgb('viridis', Number.NaN)).toEqual(low)

    const lut = paletteLut('magma')
    expect(lut).toHaveLength(256 * 3)
    expect([lut[0], lut[1], lut[2]]).toEqual(paletteRgb('magma', 0))
    expect([lut[765], lut[766], lut[767]]).toEqual(paletteRgb('magma', 1))
  })
})

describe('сглаживание — параметр просмотра', () => {
  it('усредняет ячейки по осям, не сдвигая картинку', () => {
    const row = Float32Array.from([0, 10, 0])
    expect(Array.from(boxSmooth(row, 1, 3, 1, 'time'))).toEqual([0, 10, 0])
    // Окно шириной 3: средний столбец усредняется по соседям, края не «уезжают»
    const smoothed = boxSmooth(row, 1, 3, 3, 'time')
    expect(Array.from(smoothed)[0]).toBeCloseTo(5, 6)
    expect(Array.from(smoothed)[1]).toBeCloseTo(10 / 3, 4)
    expect(Array.from(smoothed)[2]).toBeCloseTo(5, 6)
  })

  it('не пересчитывает сетку при нулевом сглаживании и делает новую при ненулевом', () => {
    const grid = decodeSpectrogramGrid(encodeSpectrogramBlob(header, values))
    expect(smoothSpectrogram(grid, 0, 0)).toBe(grid)

    const smoothed = smoothSpectrogram(grid, 250, 3)
    expect(smoothed).not.toBe(grid)
    expect(smoothed.channel).toBe(grid.channel)
    expect(Array.from(smoothed.values)).not.toEqual(values)
    // Сглаживание по времени в 250 мс при шаге 250 мс = окно шириной 1 → без изменений
    expect(Array.from(smoothSpectrogram(grid, 10, 0).values)).toEqual(values)
  })

  it('даёт подпись сетки словами и URL с версией расчёта', () => {
    const grid = demoSpectrogramGrid('C3')
    expect(spectrogramSummary(grid)).toContain('C3')
    expect(spectrogramSummary(grid)).toContain('окно 500 мс')
    expect(
      gridUrlOf({ grid_url: '/grid.bin', grid_version: 'abc', channel: 'Fp1' }),
    ).toBe('/grid.bin?v=abc')
  })

  it('держит детерминированную демо-сетку с α-пиком', () => {
    const first = demoSpectrogramGrid()
    const second = demoSpectrogramGrid()
    expect(Array.from(first.values)).toEqual(Array.from(second.values))

    // Максимум сетки — около 10 Гц: фикстура узнаваема, а не «случайный шум»
    const rows = Array.from({ length: first.nFreqs }, (_, row) =>
      first.values.subarray(row * first.nTimes, (row + 1) * first.nTimes).reduce((a, b) => a + b, 0) /
      first.nTimes,
    )
    const peak = rows.indexOf(Math.max(...rows))
    expect(first.freqs[peak]).toBeGreaterThanOrEqual(8)
    expect(first.freqs[peak]).toBeLessThanOrEqual(13)
  })
})

