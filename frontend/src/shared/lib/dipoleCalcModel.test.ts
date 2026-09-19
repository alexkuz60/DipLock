/**
 * Тесты домена расчёта раздела «Диполи» (срезы 3.4–3.7): формы запросов, отпечатки
 * параметров и результата, чтение хода задачи, нормализация сохранённых параметров.
 *
 * Модуль чистый (`shared/lib/dipoleCalcModel.ts`), поэтому тесты не поднимают
 * хранилище: правила «что уходит в задачу» и «свеж ли результат» проверяются без
 * zustand. Состояние и действия — `shared/state/dipoleCalc.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { BANDWIDTH_RANGE, SINGLE_FREQ_RANGE } from '@/shared/lib/calcFilter'
import {
  CALC_PARAM_DEFAULTS,
  buildDipoleForm,
  buildRefineForm,
  epochIndexOfPointId,
  buildSpectrumForm,
  calcJobFromStatus,
  calcJobSummary,
  calcSignature,
  normalizeCalcParams,
  resultMatchesParams,
  refineTooltip,
  refinedSummary,
  resultSignature,
  type CalcParams,
} from '@/shared/lib/dipoleCalcModel'
import { calcJobFixture, dipoleRefineResultFixture, dipoleScanResultFixture } from '@/test/fixtures'

/** Параметры формы в виде объекта: FormData удобнее читать словарём. */
function formEntries(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
}

describe('домен расчёта диполей: формы, отпечатки и нормализация', () => {
  it('собирает формы задач из параметров: без выдуманных значений', () => {
    expect(formEntries(buildDipoleForm(CALC_PARAM_DEFAULTS))).toEqual({
      band_min: '1',
      band_max: '40',
      epoch_length_ms: '1000',
      reject_threshold_uv: '150',
      grid_mm: '7',
    })
    // Спектр считается с той же полосой, но без шага сетки (он не нужен PSD)
    expect(formEntries(buildSpectrumForm(CALC_PARAM_DEFAULTS))).toEqual({
      band_min: '1',
      band_max: '40',
      epoch_length_ms: '1000',
      reject_threshold_uv: '150',
    })
  })

  it('кладёт выбранную полосу и сетевой фильтр в формы обеих задач (срез 3.6)', () => {
    const params: CalcParams = { ...CALC_PARAM_DEFAULTS, filterBandHz: [8, 13], notchHz: 50 }

    expect(formEntries(buildDipoleForm(params))).toMatchObject({
      band_min: '8',
      band_max: '13',
      notch_hz: '50',
    })
    // Спектр и диполи считаются на одной полосе: иначе топокарты и точки были бы из разных расчётов
    expect(formEntries(buildSpectrumForm(params))).toMatchObject({
      band_min: '8',
      band_max: '13',
      notch_hz: '50',
    })
    // «Без фильтра» — отсутствие пары границ, а не «0–0»
    expect(formEntries(buildDipoleForm({ ...params, filterBandHz: null }))).not.toHaveProperty(
      'band_min',
    )
  })

  it('нормализует параметры расчёта перед использованием (срез 3.6)', () => {
    const params = normalizeCalcParams({
      ...CALC_PARAM_DEFAULTS,
      // «Без фильтра» с непустой полосой и числа вне границ контролов
      filterPreset: 'none',
      filterBandHz: [20, 5],
      notchHz: 55,
      singleFreqHz: 999,
      bandwidthHz: 0,
      gridMm: 50,
      epochLengthMs: 500.4,
    })

    expect(params.filterBandHz).toEqual([5, 20])
    expect(params.notchHz).toBe(50)
    expect(params.singleFreqHz).toBe(SINGLE_FREQ_RANGE[1])
    expect(params.bandwidthHz).toBe(BANDWIDTH_RANGE[0])
    expect(params.gridMm).toBe(20)
    expect(params.epochLengthMs).toBe(500)
    // Пресет восстановлен из полосы: полосу с такими границами задают руками
    expect(params.filterPreset).toBe('custom')
  })

  it('сводит полосу и пресет: пустая полоса — только у «без фильтра» (срез 3.6)', () => {
    const noFilter = normalizeCalcParams({
      ...CALC_PARAM_DEFAULTS,
      filterBandHz: null,
    })
    expect(noFilter.filterPreset).toBe('none')

    const wide = normalizeCalcParams({
      ...CALC_PARAM_DEFAULTS,
      filterPreset: 'none',
      filterBandHz: [1, 40],
    })
    expect(wide.filterPreset).toBe('band_1_40')

    // Неизвестный пресет (сохранённый другой версией UI) не ломает форму
    const unknown = normalizeCalcParams({
      ...CALC_PARAM_DEFAULTS,
      filterPreset: 'gamma_2' as never,
      filterBandHz: [5, 20],
    })
    expect(unknown.filterPreset).toBe('custom')
  })

  it('переводит статус задачи сервера в состояние панели', () => {
    expect(calcJobFromStatus(calcJobFixture).status).toBe('succeeded')
    expect(calcJobFromStatus({ ...calcJobFixture, status: 'running' }).status).toBe('running')
    expect(calcJobFromStatus({ ...calcJobFixture, status: 'failed', error: 'сбой' }).error).toBe(
      'сбой',
    )
    expect(calcJobSummary(null)).toBe('Расчёт не запускался')
    expect(calcJobSummary(calcJobFromStatus(calcJobFixture))).toContain('эпох 4 из 4')
  })

  it('сверяет результат с параметрами расчёта по отпечатку (для таблицы локализации)', () => {
    const result = dipoleScanResultFixture()

    // Результат фикстуры посчитан на параметрах по умолчанию: сетка 7 мм,
    // полоса 1–40 Гц, reject 150 мкВ — расхождения быть не должно
    expect(resultSignature(result)).toBe(calcSignature(CALC_PARAM_DEFAULTS))
    expect(resultMatchesParams(result, CALC_PARAM_DEFAULTS)).toBe(true)

    // Правка любого параметра расчёта делает старый результат «посчитанным
    // на других настройках»: таблица обязана об этом сказать, а не молчать
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, gridMm: 12 })).toBe(false)
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, rejectThresholdUv: 300 })).toBe(
      false,
    )
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, filterBandHz: null })).toBe(false)
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, notchHz: 50 })).toBe(false)
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, epochLengthMs: 500 })).toBe(false)
  })
})

describe('точное уточнение эпохи (F19, «Уточнить…»)', () => {
  it('buildRefineForm берёт нарезку из результата, а не из формы панели', () => {
    const result = dipoleScanResultFixture({
      filter_band_hz: [8, 13],
      epoch_length_ms: 500,
      grid_mm: 5,
      notch_hz: 50,
    })
    expect(formEntries(buildRefineForm(result, 2))).toEqual({
      epoch_index: '2',
      band_min: '8',
      band_max: '13',
      notch_hz: '50',
      reference: 'average',
      epoch_length_ms: '500',
      reject_threshold_uv: '150',
      grid_mm: '5',
    })
    // custom-референс доезжает списком каналов; без фильтра пары границ нет
    const custom = formEntries(
      buildRefineForm(
        dipoleScanResultFixture({ reference: 'custom', reference_channels: ['Cz', 'Pz'] }),
        0,
      ),
    )
    expect(custom.reference_channels).toBe('Cz,Pz')
    expect(formEntries(buildRefineForm(dipoleScanResultFixture({ filter_band_hz: null }), 0)))
      .not.toHaveProperty('band_min')
  })

  it('refinedSummary и refineTooltip показывают «было/стало» без «null» в тексте', () => {
    const refined = dipoleRefineResultFixture()
    expect(refinedSummary(refined)).toBe('BEM GOF 94.0 % · сетка на BEM 81.0 % · Δ 6.3 мм')
    const tooltip = refineTooltip(refined)
    expect(tooltip).toContain('Уточнено точным профилем')
    expect(tooltip).toContain('Было — сетка')
    // grid_gof_bem = null — метрика просто отсутствует, а не печатается как «null»
    expect(refinedSummary(dipoleRefineResultFixture({ grid_gof_bem: null }))).toBe(
      'BEM GOF 94.0 % · Δ 6.3 мм',
    )
    expect(refineTooltip(dipoleRefineResultFixture({ grid_gof_bem: null }))).not.toContain('null')
  })
})

describe('epochIndexOfPointId: номер эпохи из id точки (кнопка «Уточнить» хедера)', () => {
  it('парсит префикс id и отсекает мусор', () => {
    expect(epochIndexOfPointId('2-60')).toBe(2)
    expect(epochIndexOfPointId('0-120')).toBe(0)
    expect(epochIndexOfPointId(null)).toBeNull()
    expect(epochIndexOfPointId('')).toBeNull()
    expect(epochIndexOfPointId('abc')).toBeNull()
  })
})
