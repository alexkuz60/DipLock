/**
 * Тесты правил авто-длины эпохи (п.4 плана): правило «≥ 2 периодов нижней
 * частоты полосы» (достоверность пика) и «≥ 3C отсчётов» (обратимость
 * ковариации) — §8.3 `docs/strategy/01-signal-quality.md`, `todo.md`.
 *
 * Ключевые границы: нормировка δ на 1 Гц (0.5 Гц → 2000 мс, а не 4000),
 * длина «ровно на минимуме» — не нарушение, подстановка без полосы/без
 * списка длин — не происходит.
 */
import { describe, expect, it } from 'vitest'
import {
  covarianceMinMs,
  epochRuleWarnings,
  periodMinMs,
  recommendedEpochLengthMs,
} from './epochRules'

/** Список длин из `/meta` (как в конфиге сервера) */
const LENGTHS = [250, 500, 750, 1000, 1250, 1500, 1750, 2000]

describe('правило «≥ 2 периодов нижней частоты полосы»', () => {
  it('считает минимум по нижней частоте и нормирует δ на 1 Гц (§8.3)', () => {
    expect(periodMinMs(4)).toBe(500) // θ: 2 × 250 мс
    expect(periodMinMs(8)).toBe(250) // α: 2 × 125 мс
    expect(periodMinMs(16)).toBe(125) // β: 2 × 62.5 мс
    // δ 0.5 Гц strict ≥ 4 с, но таблица нормирована на 1 Гц → 2000 мс
    expect(periodMinMs(0.5)).toBe(2000)
    expect(periodMinMs(1)).toBe(2000)
  })

  it('без полосы («без фильтра») правила нет — null, а не 4000', () => {
    expect(periodMinMs(null)).toBeNull()
    expect(periodMinMs(undefined)).toBeNull()
    expect(periodMinMs(0)).toBeNull()
    expect(periodMinMs(Number.NaN)).toBeNull()
  })
})

describe('правило «≥ 3C отсчётов» для ковариации', () => {
  it('считает минимум из каналов и sfreq (требование стабильности)', () => {
    // 18 каналов при 250 Гц: 54 отсчёта → 216 мс (числа из todo.md)
    expect(covarianceMinMs(250, 18)).toBe(216)
    // 18 каналов при 500 Гц → 108 мс; 10 каналов при 100 Гц → 300 мс
    expect(covarianceMinMs(500, 18)).toBe(108)
    expect(covarianceMinMs(100, 10)).toBe(300)
  })

  it('без sfreq или каналов записи правила нет — null', () => {
    expect(covarianceMinMs(null, 18)).toBeNull()
    expect(covarianceMinMs(250, null)).toBeNull()
    expect(covarianceMinMs(0, 18)).toBeNull()
    expect(covarianceMinMs(250, 0)).toBeNull()
  })
})

describe('авто-длина эпохи по полосе («короче для высоких»)', () => {
  it('подставляет кратчайшую длину списка, прошедшую правило периодов', () => {
    expect(recommendedEpochLengthMs(8, LENGTHS)).toBe(250) // α → 250
    expect(recommendedEpochLengthMs(4, LENGTHS)).toBe(500) // θ → 500
    expect(recommendedEpochLengthMs(2, LENGTHS)).toBe(1000) // δ/θ 2–4 → 1000
    expect(recommendedEpochLengthMs(16, LENGTHS)).toBe(250) // β (125 мс) → ближайшая 250
    expect(recommendedEpochLengthMs(0.5, LENGTHS)).toBe(2000) // δ нормирована → 2000
  })

  it('учитывает N ≥ 3C по записи: берётся длина, прошедшая обе половины', () => {
    // 60 каналов при 250 Гц: 3C = 180 отсчётов → 720 мс; период α требует 250
    const heavy = recommendedEpochLengthMs(8, LENGTHS, { sfreq: 250, nChannels: 60 })
    expect(heavy).toBe(750)
  })

  it('без полосы и без списка длин подстановки нет', () => {
    expect(recommendedEpochLengthMs(null, LENGTHS)).toBeNull()
    expect(recommendedEpochLengthMs(8, [])).toBeNull()
  })

  it('если ни одна длина не проходит правило — берётся максимальная (предупреждение объяснит)', () => {
    expect(recommendedEpochLengthMs(1, [250, 500])).toBe(500)
  })
})

describe('предупреждения у контролов (две половины читаются вместе)', () => {
  it('обе половины выполнены — предупреждений нет (границы включительно)', () => {
    expect(
      epochRuleWarnings({ lengthMs: 2000, bandLoHz: 1, sfreq: 250, nChannels: 18 }),
    ).toEqual([])
    // ровно 2 периода 4 Гц и ровно 3C = 54 отсчёта (500 мс при 108 Гц) — не нарушение
    expect(
      epochRuleWarnings({ lengthMs: 500, bandLoHz: 4, sfreq: 108, nChannels: 18 }),
    ).toEqual([])
  })

  it('короче 2 периодов — предупреждение о достоверности пика', () => {
    const warnings = epochRuleWarnings({ lengthMs: 250, bandLoHz: 4 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('двух периодов нижней частоты полосы')
    expect(warnings[0]).toContain('минимум 500 мс')
    expect(warnings[0]).toContain('достоверность пика')
  })

  it('короче 3C — предупреждение об обратимости ковариации', () => {
    const warnings = epochRuleWarnings({ lengthMs: 200, bandLoHz: null, sfreq: 250, nChannels: 18 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('3 × 18 = 54 отсчётов')
    expect(warnings[0]).toContain('минимум 216 мс')
    expect(warnings[0]).toContain('обратимость ковариации')
  })

  it('нарушаются обе — оба текста читаются вместе', () => {
    const warnings = epochRuleWarnings({
      lengthMs: 100,
      bandLoHz: 8,
      sfreq: 250,
      nChannels: 18,
    })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('двух периодов')
    expect(warnings[1]).toContain('3C')
  })

  it('δ 0.5 Гц: нормировка на 1 Гц названа в тексте (4000 мс не появляется)', () => {
    const warnings = epochRuleWarnings({ lengthMs: 500, bandLoHz: 0.5 })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('0.5 Гц, нормировано на 1 Гц')
    expect(warnings[0]).toContain('минимум 2000 мс')
    expect(warnings[0]).not.toContain('4000')
  })

  it('окно спектра говорит своим словом («Окно»), а не «Эпоха»', () => {
    const warnings = epochRuleWarnings({ lengthMs: 250, bandLoHz: 4, subject: 'Окно' })
    expect(warnings[0]).toMatch(/^Окно 250 мс/)
  })

  it('без полосы период-правило молчит, но N ≥ 3C продолжает следить', () => {
    expect(epochRuleWarnings({ lengthMs: 1000, bandLoHz: null })).toEqual([])
    // 18 каналов при 40 Гц: 3C = 54 отсчёта → 1350 мс > 1000 мс
    expect(
      epochRuleWarnings({ lengthMs: 1000, bandLoHz: null, sfreq: 40, nChannels: 18 }),
    ).toHaveLength(1)
  })
})
