/**
 * Тесты клиентских замеров (правило `docs/rules/frontend-perf.md`).
 *
 * Проверяется контракт, на который опираются замеры отрисовки: `perfSpan` меряет
 * блок и меряет его **даже при исключении** (иначе падение отрисовки исчезало бы
 * из отчёта), `perfCount` считает события без времени, кольцо не растёт, а сводка
 * отвечает на вопрос «что съедает кадр» — сортировкой по суммарному времени.
 * Часы подменяются: тест не должен зависеть от скорости машины.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PERF_RING_CAPACITY,
  perfCount,
  perfEntries,
  perfReset,
  perfSpan,
  perfStats,
} from './perf'

let clock = 0

beforeEach(() => {
  clock = 100
  perfReset()
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  perfReset()
})

describe('клиентские замеры', () => {
  it('меряет блок и возвращает его результат', () => {
    const value = perfSpan('eeg.raster.build', () => {
      clock += 12.5
      return 'растр'
    })

    expect(value).toBe('растр')
    expect(perfEntries()).toEqual([{ name: 'eeg.raster.build', ms: 12.5 }])
    expect(perfStats()).toEqual([
      { name: 'eeg.raster.build', count: 1, totalMs: 12.5, maxMs: 12.5 },
    ])
  })

  it('меряет блок, который упал: ошибка не выпадает из сводки', () => {
    expect(() =>
      perfSpan('eeg.raster.paint', () => {
        clock += 3
        throw new Error('нет контекста')
      }),
    ).toThrow('нет контекста')

    expect(perfStats()).toEqual([
      { name: 'eeg.raster.paint', count: 1, totalMs: 3, maxMs: 3 },
    ])
  })

  it('считает события без времени, в том числе пачкой', () => {
    perfCount('edf.envelope.recompute')
    perfCount('edf.envelope.recompute')
    perfCount('edf.chart.create', 3)

    const stats = perfStats()
    expect(stats).toEqual([
      { name: 'edf.chart.create', count: 3, totalMs: 0, maxMs: 0 },
      { name: 'edf.envelope.recompute', count: 2, totalMs: 0, maxMs: 0 },
    ])
  })

  it('ставит на первое место то, что съедает кадр, а не то, что случилось раньше', () => {
    perfSpan('eeg.raster.paint', () => {
      clock += 1
    })
    perfSpan('eeg.raster.build', () => {
      clock += 40
    })
    // Частое, но мгновенное событие: суммарное время нулевое, поэтому оно в конце
    // отчёта — счётчик говорит «сколько раз», а не «сколько времени»
    perfCount('edf.pan.frame', 50)

    expect(perfStats().map((stat) => stat.name)).toEqual([
      'eeg.raster.build',
      'eeg.raster.paint',
      'edf.pan.frame',
    ])
  })

  it('накапливает сводку по имени: count, сумма и максимум', () => {
    perfSpan('eeg.raster.paint', () => {
      clock += 5
    })
    perfSpan('eeg.raster.paint', () => {
      clock += 9
    })

    expect(perfStats()).toEqual([
      { name: 'eeg.raster.paint', count: 2, totalMs: 14, maxMs: 9 },
    ])
  })

  it('держит кольцо замеров, а не журнал: старые вытесняются', () => {
    for (let i = 0; i < PERF_RING_CAPACITY + 10; i++) {
      perfSpan('eeg.raster.paint', () => {
        clock += 1
      })
    }

    const entries = perfEntries()
    expect(entries).toHaveLength(PERF_RING_CAPACITY)
    expect(entries[entries.length - 1]).toEqual({ name: 'eeg.raster.paint', ms: 1 })
    // Сводка при этом считает все замеры, а не только оставшиеся в кольце
    expect(perfStats()[0]?.count).toBe(PERF_RING_CAPACITY + 10)
  })

  it('сбрасывает и кольцо, и счётчики (сценарий ручной проверки)', () => {
    perfCount('edf.pan.frame', 4)
    perfSpan('eeg.raster.build', () => {
      clock += 2
    })

    perfReset()

    expect(perfEntries()).toEqual([])
    expect(perfStats()).toEqual([])
  })

  it('отдаёт сводку в консоль браузера через __diplockPerf', () => {
    const api = (globalThis as unknown as { __diplockPerf?: { count: (n: string) => void } })
      .__diplockPerf
    expect(api).toBeDefined()

    api?.count('edf.pan.frame')

    expect(perfStats()).toEqual([{ name: 'edf.pan.frame', count: 1, totalMs: 0, maxMs: 0 }])
  })
})
