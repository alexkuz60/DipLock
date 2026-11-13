/**
 * Тесты моделей таблицы готовности (раздел «БД»): подписи стадий, сводки
 * параметров («—» вместо «не измерено»), сортировка/поиск/группировка.
 */
import { describe, expect, it } from 'vitest'
import type { RecordingReadiness } from '@/shared/api/types'
import {
  readinessStageFixture,
  readinessStageParamsFixture,
  recordingsReadinessFixture,
} from '@/test/fixtures'
import {
  dash,
  formatDate,
  groupByPatient,
  readinessText,
  stageLabel,
  stageSummary,
  stageParamLines,
} from './dbTable'

function row(overrides: Partial<RecordingReadiness>): RecordingReadiness {
  return {
    recording_id: 'rec-1',
    filename: 'a.edf',
    patient_alias: null,
    n_channels: null,
    sfreq: null,
    duration_sec: null,
    created_at: null,
    accessed_at: null,
    readiness_ready: 0,
    readiness_total: 5,
    stages: [],
    ...overrides,
  }
}

describe('dbTable: подписи и готовность', () => {
  it('подписи стадий: известные ключи по-русски, неизвестный — как есть', () => {
    expect(stageLabel('preprocess')).toBe('Препроцессинг')
    expect(stageLabel('package')).toBe('Полосы пакета')
    expect(stageLabel('what')).toBe('what')
  })

  it('степень готовности — «k из N»; прочерк «—» — «не измерено», а не 0', () => {
    expect(readinessText(row({ readiness_ready: 4, readiness_total: 5 }))).toBe('4 из 5')
    expect(dash(null)).toBe('—')
    expect(dash(undefined)).toBe('—')
    expect(dash(0)).toBe('0')
    expect(dash('x')).toBe('x')
  })
})

describe('dbTable: сводки параметров', () => {
  it('препроцессинг: фильтр, notch, референс, чистка, эпохи', () => {
    const stage = readinessStageFixture('preprocess')
    expect(stageSummary(stage)).toBe(
      '0.5–45 Гц · notch 50 · average · ICA · эпохи 2000 мс · 10/12',
    )
  })

  it('пустая стадия и стадия без параметров — прочерк', () => {
    const empty = readinessStageFixture('dipoles', {
      state: 'none', n_runs: 0, params: null,
    })
    expect(stageSummary(empty)).toBe('—')
  })

  it('полный список параметров: прочерки и «auto» у ICA', () => {
    const lines = stageParamLines(
      readinessStageParamsFixture({ ica_n_components: 0, event_id: null }),
    )
    const byLabel = Object.fromEntries(lines.map((line) => [line.label, line.value]))
    expect(byLabel['Полоса фильтра']).toBe('0.5–45 Гц')
    expect(byLabel['Notch']).toBe('50 Гц')
    expect(byLabel['Компонент ICA']).toBe('auto')
    expect(byLabel['Нарезка эпох']).toBe('всего 12, в расчёте 10, отбраковано 2')
    expect(byLabel['Окно события']).toBe('—')
    expect(stageParamLines(null)).toEqual([])
  })

  it('формат даты: ДД.ММ.ГГГГ ЧЧ:ММ, пустое — прочерк', () => {
    expect(formatDate('2026-10-01T10:05:00')).toBe('01.10.2026 10:05')
    expect(formatDate(null)).toBe('—')
    expect(formatDate('мусор')).toBe('—')
  })
})

describe('dbTable: группировка по испытуемому', () => {
  const items = recordingsReadinessFixture.items as RecordingReadiness[]

  it('2 файла Patient-aaa111 и «Без псевдонима»; порядок групп = порядок строк', () => {
    const groups = groupByPatient(items)
    expect(groups.map((group) => group.label)).toEqual(['Patient-aaa111', 'Без псевдонима'])
    expect(groups[0].rows.map((item) => item.recording_id)).toEqual(['rec-rest', 'rec-task'])
    expect(groups[1].alias).toBeNull()
  })
})