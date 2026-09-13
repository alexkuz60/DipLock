/**
 * Тесты кадра сигналов (срез 2.5): разбор бинарного контейнера бэкенда,
 * восстановление времён, ошибки формата и выбор кадра под уровень зума.
 *
 * Контейнер собирается тем же тестовым энкодером, что и мок API
 * (`test/signalBlob.ts`), — формат проверяется ровно так, как его отдаёт сервер.
 */
import { describe, expect, it } from 'vitest'
import {
  SIGNAL_MAGIC,
  SignalDecodeError,
  decodeSignalFrame,
  frameFromSignalData,
  resolveSignalLevel,
  selectFrame,
  type SignalFrame,
} from '@/shared/lib/signalFrame'
import { makeDemoSignal } from '@/shared/lib/demoSignal'
import { encodeSignalBlob } from '@/test/signalBlob'

function header(patch: Partial<Record<string, unknown>> = {}) {
  return {
    recording_id: 'rec-1',
    level: 1,
    channels: ['F3', 'F4'],
    sfreq: 100,
    duration_sec: 5,
    n_points: 5,
    decimated: false,
    dtype: 'float32',
    byte_order: 'little',
    layout: 'channel-major',
    ...patch,
  } as Parameters<typeof encodeSignalBlob>[0]
}

describe('разбор контейнера сигналов', () => {
  it('читает неразреженный кадр: min == max, времена по центру корзин', () => {
    const buffer = encodeSignalBlob(header(), [
      { name: 'F3', min: [1, 2, 3, 4, 5], max: [1, 2, 3, 4, 5] },
      { name: 'F4', min: [10, 20, 30, 40, 50], max: [10, 20, 30, 40, 50] },
    ])

    const frame = decodeSignalFrame(buffer)

    expect(frame.sourceId).toBe('rec-1')
    expect(frame.channels).toEqual(['F3', 'F4'])
    expect(frame.durationSec).toBe(5)
    expect(frame.decimated).toBe(false)
    expect(frame.level).toBe(1)
    expect(Array.from(frame.max.F3)).toEqual([1, 2, 3, 4, 5])
    expect(Array.from(frame.min.F4)).toEqual([10, 20, 30, 40, 50])
    // Корзины равномерны: 5 с / 5 корзин → центры 0.5, 1.5, …
    expect(Array.from(frame.times)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5])
    // Без прореживания min и max — один и тот же ряд
    expect(frame.min.F3).toBe(frame.max.F3)
  })

  it('читает прореженный кадр: min и max — разные серии, пик сохраняется', () => {
    const buffer = encodeSignalBlob(header({ decimated: true, n_points: 3 }), [
      { name: 'F3', min: [-5, -60, -7], max: [5, 300, 7] },
      { name: 'F4', min: [-1, -2, -3], max: [1, 2, 3] },
    ])

    const frame = decodeSignalFrame(buffer)

    expect(frame.decimated).toBe(true)
    expect(Array.from(frame.min.F3)).toEqual([-5, -60, -7])
    expect(Array.from(frame.max.F3)).toEqual([5, 300, 7])
    expect(Math.max(...frame.max.F3)).toBe(300)
  })

  it('отклоняет чужой формат, обрезанный ответ и несовпавший размер', () => {
    expect(() => decodeSignalFrame(new ArrayBuffer(4))).toThrow(SignalDecodeError)

    const wrongMagic = encodeSignalBlob(header(), [
      { name: 'F3', min: [0], max: [0] },
      { name: 'F4', min: [0], max: [0] },
    ])
    new Uint8Array(wrongMagic)[0] = 'X'.charCodeAt(0)
    expect(() => decodeSignalFrame(wrongMagic)).toThrow(/Неожиданный формат/)

    const truncated = encodeSignalBlob(header(), [
      { name: 'F3', min: [0], max: [0] },
      { name: 'F4', min: [0], max: [0] },
    ]).slice(0, 20)
    expect(() => decodeSignalFrame(truncated)).toThrow(SignalDecodeError)
  })

  it('сообщает о несовпадении размера данных с заголовком', () => {
    const buffer = encodeSignalBlob(header(), [
      { name: 'F3', min: [0, 0, 0, 0, 0], max: [0, 0, 0, 0, 0] },
      { name: 'F4', min: [0, 0, 0, 0, 0], max: [0, 0, 0, 0, 0] },
    ])
    // Урезаем payload на один float32 — заголовок обещает больше
    expect(() => decodeSignalFrame(buffer.slice(0, buffer.byteLength - 4))).toThrow(
      /Размер данных/,
    )
  })

  it('magic-константа совпадает с контейнером', () => {
    const buffer = encodeSignalBlob(header(), [
      { name: 'F3', min: [0], max: [0] },
      { name: 'F4', min: [0], max: [0] },
    ])
    expect(new TextDecoder().decode(new Uint8Array(buffer, 0, 4))).toBe(SIGNAL_MAGIC)
  })
})

describe('кадр из демо-сигнала', () => {
  it('переводит полноразрешённый сигнал в кадр уровня 0 без агрегации', () => {
    const signal = makeDemoSignal(['F3', 'F4'])
    const frame = frameFromSignalData(signal)

    expect(frame.sourceId).toBe('demo')
    expect(frame.level).toBe(0)
    expect(frame.decimated).toBe(false)
    expect(frame.channels).toEqual(['F3', 'F4'])
    expect(frame.times.length).toBe(signal.data.F3?.length)
    expect(frame.min.F3).toBe(frame.max.F3)
    expect(frame.durationSec).toBe(signal.durationSec)
  })
})

describe('выбор кадра под уровень зума', () => {
  const frame = (level: number) => ({ level, times: new Float32Array(0) }) as unknown as SignalFrame

  it('точный уровень в приоритете', () => {
    const frames = { 1: frame(1), 4: frame(4) }
    expect(selectFrame(frames, 4)?.level).toBe(4)
  })

  it('при промахе берёт ближайший загруженный кадр', () => {
    const frames = { 1: frame(1), 2: frame(2) }
    expect(selectFrame(frames, 8)?.level).toBe(2)
    // Равное удаление (|2−9| = |16−9|) — в пользу более подробного
    expect(selectFrame({ 2: frame(2), 16: frame(16) }, 9)?.level).toBe(16)
  })

  it('пустой кэш — null (рабочая область покажет скелет)', () => {
    expect(selectFrame({}, 1)).toBeNull()
  })

  it('resolveSignalLevel округляет вверх до доступного уровня', () => {
    expect(resolveSignalLevel(4, [1, 2, 4, 8, 16])).toBe(4)
    // Уровня «×3» не бывает: берём ближайший сверху — детализации будет не меньше
    expect(resolveSignalLevel(3, [1, 2, 4, 8, 16])).toBe(4)
    // Свой список уровней из /meta: ×2 покрывается уровнем ×4
    expect(resolveSignalLevel(2, [1, 4])).toBe(4)
    // Запрошенный уровень подробнее самого подробного — берём максимальный
    expect(resolveSignalLevel(16, [1, 2, 4])).toBe(4)
    // Пустой список (мета недоступна) — множитель UI как есть
    expect(resolveSignalLevel(3, [])).toBe(3)
  })
})
