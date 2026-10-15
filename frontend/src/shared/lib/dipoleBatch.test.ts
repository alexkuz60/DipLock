/**
 * Тесты помощников пакета поддиапазонов (С1/С2): форма запроса, выбор полосы,
 * сборка `DipoleScanResult` активной полосы.
 *
 * Главные инварианты: форма несёт **набор** полос (не одну), скан полосы
 * повторяет паспорт прогона (одна длина эпохи на прогон, п.7) и точки своей
 * полосы — чтобы прежняя отрисовка работала без правок.
 */
import { describe, expect, it } from 'vitest'
import {
  BATCH_MAX_BANDS,
  BATCH_MIN_BANDS,
  bandLabel,
  bandRunOf,
  buildDipoleBatchForm,
  scanResultOfBand,
  shareLabel,
} from './dipoleBatch'
import { dipoleBatchResultFixture } from '@/test/fixtures'

describe('помощники пакета поддиапазонов', () => {
  it('собирает форму с набором полос и параметрами расчёта', () => {
    const form = buildDipoleBatchForm({
      bandKeys: ['alpha', 'beta', 'custom:2.5-4'],
      epochLengthMs: 500,
      gridMm: 4,
      notchHz: 50,
      reference: 'average',
      referenceChannels: null,
    })
    expect(form.get('bands')).toBe('alpha,beta,custom:2.5-4')
    expect(form.get('epoch_length_ms')).toBe('500')
    expect(form.get('grid_mm')).toBe('4')
    expect(form.get('notch_hz')).toBe('50')
    // Пустой референс не уходит в форму (сервер ждёт «average» по умолчанию)
    expect(form.get('reference')).toBeNull()
    expect(form.get('reference_channels')).toBeNull()
  })

  it('держит рамки набора: минимум полос и лимит прогона', () => {
    expect(BATCH_MIN_BANDS).toBe(2)
    expect(BATCH_MAX_BANDS).toBeGreaterThanOrEqual(2)
  })

  it('находит полосу по ключу и честно отвечает null на чужой', () => {
    const batch = dipoleBatchResultFixture()
    expect(bandRunOf(batch, 'beta')?.band_key).toBe('beta')
    expect(bandRunOf(batch, 'omega')).toBeNull()
    expect(bandRunOf(null, 'beta')).toBeNull()
    expect(bandRunOf(batch, null)).toBeNull()
  })

  it('собирает скан активной полосы: паспорт прогона + точки своей полосы', () => {
    const batch = dipoleBatchResultFixture()
    const band = bandRunOf(batch, 'beta')
    expect(band).not.toBeNull()
    const scan = scanResultOfBand(batch, band!)

    // Паспорт — общий на прогон (одна длина эпохи, п.7)
    expect(scan.recording_id).toBe(batch.recording_id)
    expect(scan.epoch_length_ms).toBe(batch.epoch_length_ms)
    expect(scan.grid_mm).toBe(batch.grid_mm)
    expect(scan.sfreq).toBe(batch.sfreq)
    // Адрес полосы — в filter_band_hz: точки показывает именно своя полоса
    expect(scan.filter_band_hz).toEqual([13, 30])
    expect(scan.points).toHaveLength(band!.points?.length ?? 0)
    expect(scan.n_epochs_used).toBe(band!.n_epochs_used)
  })

  it('подписывает полосу границами и нормированные доли процентами', () => {
    expect(bandLabel({ label: 'alpha', band_hz: [8, 13] })).toBe('alpha (8–13 Гц)')
    expect(shareLabel(0.62)).toBe('62%')
    expect(shareLabel(1)).toBe('100%')
    // «Не измерено» — прочерк, а не «0%»
    expect(shareLabel(null)).toBe('—')
    expect(shareLabel(undefined)).toBe('—')
  })
})
