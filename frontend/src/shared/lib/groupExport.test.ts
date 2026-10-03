/**
 * Экспорт сводки группового анализа в CSV (§3.5): формат RFC 4180,
 * два знаменателя share (группа и своя запись), подпись полосы в шапке
 * и честные прочерки пустых GOF.
 */
import { describe, expect, it } from 'vitest'
import { groupCsv, groupCsvFilename } from './groupExport'
import { groupAggregateFixture } from '@/test/fixtures'

describe('groupCsv', () => {
  const csv = groupCsv(groupAggregateFixture())

  it('шапка подписывает полосу и оба знаменателя', () => {
    expect(csv).toContain('# полоса: alpha (8–16 Гц)')
    expect(csv).toContain('доля_группы')
    expect(csv).toContain('rec-rest_доля_ %')
    expect(csv).toContain('точек: 5')
  })

  it('строки обоих словарей с числами и ячейками по записям', () => {
    const lines = csv.trimEnd().split('\n')
    const thalamus = lines.find((line) => line.includes('таламус (слева)'))
    expect(thalamus).toBeDefined()
    // count 4, доля 80 %, средний GOF 0.75, ячейки 2/67 % и 2/100 %
    expect(thalamus).toContain('4,80.0,0.75')
    expect(thalamus).toContain('2,66.7')
    expect(thalamus).toContain('2,100.0')
    // Второй словарь — поля Бродмана
    expect(csv).toContain('поле_БА,BA7-lh')
  })

  it('пустые числа — пустое поле, кавычки экранируются', () => {
    const rows = groupAggregateFixture({
      structures: [
        {
          name: 'изрезанная, «кавычки»',
          hemisphere: 'mid',
          count: 1,
          share: 1,
          mean_gof: null,
          median_gof: null,
          std_gof: null,
          mean_amplitude_nam: null,
          std_amplitude_nam: null,
          n_sessions: 1,
          cells: [],
        },
      ],
      brodmann: [],
    })
    const text = groupCsv(rows)
    expect(text).toContain('"изрезанная, «кавычки»"')
    // Пять пустых чисел (GOF×3 + амплитуды×2) между долей и «записей»
    expect(text).toMatch(/1,100\.0,,,,,,1,/)
  })

  it('имя файла содержит полосу', () => {
    expect(groupCsvFilename('alpha')).toBe('diplock-group-alpha.csv')
  })
})
