/**
 * Экспорт «Итогов» в CSV (часть 3, §3.9.6): плоская таблица «тип, название,
 * числа топа, 5 бинов динамики» + имя файла с ключом полосы.
 */
import { describe, expect, it } from 'vitest'
import { bandCsvFilename, bandSummaryCsv } from './summaryExport'
import { reportBandFixture } from '@/test/fixtures'

describe('summaryExport (CSV полосы «Итогов»)', () => {
  it('строка заголовка и все три раздела: структуры, поля БА, динамика', () => {
    const csv = bandSummaryCsv(reportBandFixture('theta'))
    const lines = csv.trimEnd().split('\n')

    expect(lines[0]).toBe(
      'тип,название,эпох активно,доля %,медианный GOF,бин 1 %,бин 2 %,бин 3 %,бин 4 %,бин 5 %',
    )
    expect(lines).toContain('структура,Precuneus,5,55.6,0.85,,,,,')
    expect(lines).toContain('поле_БА,BA7-lh,5,55.6,0.85,,,,,')
    expect(lines).toContain('динамика,Precuneus,,,,20.0,40.0,60.0,40.0,20.0')
  })

  it('имя файла содержит ключ полосы — файлов по полосам несколько', () => {
    expect(bandCsvFilename(reportBandFixture('alpha'))).toBe('diplock-итоги-alpha.csv')
  })

  it('значения с запятыми и кавычками экранируются по RFC 4180', () => {
    const band = reportBandFixture('theta')
    band.top_structures = [{ name: 'Gyrus, "central"', count: 1, share: 1, median_gof: null }]
    band.top_brodmann = []
    band.dynamics = []
    const csv = bandSummaryCsv(band)

    expect(csv).toContain('структура,"Gyrus, ""central""",1,100.0,')
  })
})
