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
  bandLabel,
  bandRunOf,
  bandTagOf,
  batchDipoleLayer,
  buildDipoleBatchForm,
  frameSources,
  scanResultOfBand,
  shareLabel,
} from './dipoleBatch'
import { bandColor } from './bandColors'
import { dipoleBatchResultFixture, dipoleScanResultFixture } from '@/test/fixtures'

describe('помощники пакета поддиапазонов', () => {
  it('собирает форму с набором полос, параметрами расчёта и порогами КД', () => {
    const form = buildDipoleBatchForm({
      bandKeys: ['alpha', 'beta', 'custom:2.5-4'],
      epochLengthMs: 500,
      gridMm: 4,
      notchHz: 50,
      reference: 'average',
      referenceChannels: null,
      kdGofByBand: { alpha: 90, gamma: null },
      kdMomentSharePercent: 50,
    })
    expect(form.get('bands')).toBe('alpha,beta,custom:2.5-4')
    expect(form.get('epoch_length_ms')).toBe('500')
    expect(form.get('grid_mm')).toBe('4')
    expect(form.get('notch_hz')).toBe('50')
    // Пустой референс не уходит в форму (сервер ждёт «average» по умолчанию)
    expect(form.get('reference')).toBeNull()
    expect(form.get('reference_channels')).toBeNull()
    // КД (С0): заданные пороги — долями 0…1, null («дефолт методики») не уходит
    expect(form.get('kd_gof_min_by_band')).toBe('{"alpha":0.9}')
    expect(form.get('kd_moment_share')).toBe('0.5')
  })

  it('не шлёт поля КД без правок: пустые пороги решает методика сервера', () => {
    const form = buildDipoleBatchForm({
      bandKeys: ['alpha'],
      epochLengthMs: 1000,
      gridMm: 7,
      notchHz: null,
      reference: 'average',
      referenceChannels: null,
      kdGofByBand: {},
      kdMomentSharePercent: null,
    })
    expect(form.get('kd_gof_min_by_band')).toBeNull()
    expect(form.get('kd_moment_share')).toBeNull()
  })

  it('держит рамки набора: лимит полос прогона покрывает каталог', () => {
    // Каталог — 7 октавных + 6 функциональных = 13 полос; лимит сервера
    // (`dipole_batch_max_bands`) обязан их покрывать — прогон идёт по всему каталогу
    expect(BATCH_MAX_BANDS).toBeGreaterThanOrEqual(13)
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

describe('полосная отрисовка пакета (п.1, 17.10.2026)', () => {
  it('даёт тег полосы с цветом гаммы red→violet и стабильным ключом', () => {
    const batch = dipoleBatchResultFixture()
    const [alpha, beta] = batch.bands ?? []
    const alphaTag = bandTagOf(alpha)
    const betaTag = bandTagOf(beta)

    expect(alphaTag.key).toBe('alpha')
    expect(alphaTag.label).toBe(alpha.label)
    expect(alphaTag.bandHz).toEqual(alpha.band_hz)
    // Полоса с более высокими частотами — «правее» в гамме (ближе к фиолетовому)
    expect(betaTag.color).not.toBe(alphaTag.color)
    expect(alphaTag.color).toBe(bandColor(alpha.band_hz))
  })

  it('собирает источники кадра по чекбоксам полос: от всех до одной', () => {
    const batch = dipoleBatchResultFixture()

    // Все полосы — два источника с тегами (порядок — как в прогоне)
    const all = frameSources(null, batch, ['beta', 'alpha'])
    expect(all.map((source) => source.band?.key)).toEqual(['alpha', 'beta'])
    expect(all[0].points.size).toBeGreaterThan(0)
    // Только одна — один источник; ни одной — ни одного (честная пустота)
    expect(frameSources(null, batch, ['beta'])).toHaveLength(1)
    expect(frameSources(null, batch, [])).toHaveLength(0)
    // Одиночный расчёт — один источник без полосы
    const single = frameSources(dipoleScanResultFixture(), null, [])
    expect(single).toHaveLength(1)
    expect(single[0].band).toBeNull()
  })

  it('складывает облако пакета из отмеченных полос с тегами на точках', () => {
    const batch = dipoleBatchResultFixture()

    const layer = batchDipoleLayer(batch, ['alpha', 'beta'])
    // Точки обеих полос, каждая несёт свою полосу (цвет/масштаб вектора)
    expect(layer.source).toBe('result')
    expect(layer.points.every((point) => point.band !== null && point.band !== undefined)).toBe(true)
    expect(new Set(layer.points.map((point) => point.band?.key))).toEqual(new Set(['alpha', 'beta']))
    // Снятая полоса убирает свои точки
    const alphaOnly = batchDipoleLayer(batch, ['alpha'])
    expect(new Set(alphaOnly.points.map((point) => point.band?.key))).toEqual(new Set(['alpha']))
    expect(alphaOnly.points.length).toBeLessThan(layer.points.length)
  })
})
