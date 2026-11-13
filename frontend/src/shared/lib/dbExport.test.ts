/**
 * Экспорт выборки записей раздела «БД» в CSV: шапка, строки, экранирование
 * (RFC 4180) и «—» вместо «не измерено».
 */
import { describe, expect, it } from 'vitest'
import type { RecordingReadiness } from '@/shared/api/types'
import { readinessStageFixture, recordingsReadinessFixture } from '@/test/fixtures'
import {
  dbSelectionCsv,
  dbSelectionFilename,
  dbSelectionJson,
  dbSelectionJsonFilename,
  dbSelectionReport,
  dbSelectionReportFilename,
} from './dbExport'

describe('dbExport: CSV выборки записей', () => {
  it('имя файла и шапка: паспорт + готовность + 4 колонки на стадию', () => {
    expect(dbSelectionFilename()).toBe('diplock-db-recordings.csv')
    const [header] = dbSelectionCsv([]).split('\n')
    const columns = header.split(',')
    expect(columns.slice(0, 10)).toEqual([
      'id_записи', 'файл', 'псевдоним', 'каналов', 'частота_Гц',
      'длительность_с', 'зарегистрирована', 'готовность', 'готово_стадий', 'всего_стадий',
    ])
    // 10 + 5 стадий × 4 колонки
    expect(columns).toHaveLength(30)
    expect(columns).toContain('Препроцессинг:параметры')
    expect(columns).toContain('Спектрограмма:статус')
  })

  it('строка записи: готовность «k из N» и сводки стадий', () => {
    const row = (recordingsReadinessFixture.items ?? [])[0] as RecordingReadiness
    const line = dbSelectionCsv([row]).split('\n')[1]
    expect(line).toContain('rec-rest')
    expect(line).toContain('4 из 5')
    expect(line).toContain('0.5–45 Гц · notch 50 · average · ICA')
    expect(line).toContain('готово') // статус готовой стадии словом
  })

  it('экранирует запятые/кавычки по RFC 4180; пустые поля — без кавычек', () => {
    const row: RecordingReadiness = {
      recording_id: 'rec-x',
      filename: 'a, "b".edf',
      patient_alias: null,
      n_channels: null,
      sfreq: null,
      duration_sec: null,
      created_at: null,
      readiness_ready: 1,
      readiness_total: 5,
      stages: [
        readinessStageFixture('preprocess', {
          state: 'none', n_runs: 0, last_run_at: null, job_id: null, params: null,
        }),
      ],
    }
    const line = dbSelectionCsv([row]).split('\n')[1]
    expect(line).toContain('"a, ""b"".edf"')
    expect(line).toContain('1 из 5')
    expect(line).toContain('нет') // неготовая стадия — «нет», не пусто
  })
})

describe('dbExport: JSON выборки', () => {
  it('schema_version + строки контракта без потерь', () => {
    const row = (recordingsReadinessFixture.items ?? [])[0] as RecordingReadiness
    const parsed = JSON.parse(
      dbSelectionJson([row], '2026-11-13T12:00:00.000Z'),
    ) as { schema_version: number; exported_at: string; recordings: RecordingReadiness[] }
    expect(parsed.schema_version).toBe(1)
    expect(parsed.exported_at).toBe('2026-11-13T12:00:00.000Z')
    expect(parsed.recordings).toHaveLength(1)
    expect(parsed.recordings[0]).toEqual(row) // ровно то, что в таблице
    expect(dbSelectionJsonFilename()).toBe('diplock-db-recordings.json')
  })
})

describe('dbExport: сводный HTML-отчёт', () => {
  const row = (recordingsReadinessFixture.items ?? [])[0] as RecordingReadiness

  it('шапка, группы испытуемых и готовность «k из N»', () => {
    const html = dbSelectionReport([row], '2026-11-13T12:00:00.000Z')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('DipLock — записи и результаты (выборка)')
    expect(html).toContain('Испытуемый: Patient-aaa111')
    expect(html).toContain('4 из 5')
    expect(html).toContain('расчёты не запускались')
    expect(dbSelectionReportFilename()).toBe('diplock-db-recordings.html')
  })

  it('параметры стадий и экранирование имени файла (<script>)', () => {
    const hostile: RecordingReadiness = {
      ...row,
      filename: '<script>alert(1)</script>.edf',
      stages: [
        readinessStageFixture('preprocess'),
        readinessStageFixture('dipoles', {
          state: 'none', n_runs: 0, last_run_at: null, job_id: null, params: null,
        }),
      ],
    }
    const html = dbSelectionReport([hostile])
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.edf')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('0.5–45 Гц · notch 50 · average · ICA') // сводка препроцессинга
    expect(html).toContain('Параметры прогона не записаны') // пустая стадия — честно
    expect(html).toContain('Полоса фильтра') // полный список параметров готовой стадии
  })
})