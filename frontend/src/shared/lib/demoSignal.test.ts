/** Тесты демо-сигнала: детерминизм, форма данных, артефактные всплески. */
import { describe, expect, it } from 'vitest'
import { DEMO_CHANNELS, makeDemoSignal } from '@/shared/lib/demoSignal'

describe('демо-сигнал', () => {
  it('детерминирован: одинаковый seed даёт одинаковые данные', () => {
    const a = makeDemoSignal(['F3', 'C3'], { durationSec: 2, seed: 7 })
    const b = makeDemoSignal(['F3', 'C3'], { durationSec: 2, seed: 7 })

    expect(Array.from(a.data.F3.slice(0, 100))).toEqual(Array.from(b.data.F3.slice(0, 100)))
  })

  it('имеет правильную форму: каналы × отсчёты', () => {
    const signal = makeDemoSignal(DEMO_CHANNELS, { durationSec: 3, sfreq: 250 })

    expect(signal.channels).toHaveLength(18)
    expect(signal.sfreq).toBe(250)
    expect(signal.durationSec).toBe(3)
    for (const name of signal.channels) {
      expect(signal.data[name]).toHaveLength(750)
    }
  })

  it('содержит артефактные всплески заметной амплитуды', () => {
    const signal = makeDemoSignal(['F3'], { durationSec: 10, sfreq: 250 })
    const data = signal.data.F3
    const peak = Math.max(...data)

    // Базовый сигнал ~50 мкВ, всплеск +150 → пик заметно выше ритма
    expect(peak).toBeGreaterThan(120)
    // и всплеск ровно там, где заложено (30 % длительности)
    const peakIndex = data.indexOf(peak)
    expect(peakIndex / data.length).toBeCloseTo(0.3, 1)
  })
})
