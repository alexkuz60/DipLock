/**
 * Тесты домена расчёта раздела «Диполи» (срезы 3.4–3.7): формы запросов, отпечатки
 * параметров и результата, чтение хода задачи, нормализация сохранённых параметров.
 *
 * Модуль чистый (`shared/lib/dipoleCalcModel.ts`), поэтому тесты не поднимают
 * хранилище: правила «что уходит в задачу» и «свеж ли результат» проверяются без
 * zustand. Состояние и действия — `shared/state/dipoleCalc.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  CALC_PARAM_DEFAULTS,
  REFINE_HALFWIN_OPTIONS,
  buildRefineForm,
  epochIndexOfPointId,
  buildSpectrumForm,
  calcJobFromStatus,
  calcJobSummary,
  calcSignature,
  normalizeCalcParams,
  normalizeCalcView,
  normalizeRefineHalfwin,
  refineCostHint,
  refineHalfwinLabel,
  refineWindowSamples,
  resultMatchesParams,
  refineTooltip,
  refinedSummary,
  resultSignature,
  type CalcParams,
} from '@/shared/lib/dipoleCalcModel'
import { calcJobFixture, dipoleRefineResultFixture, dipoleScanResultFixture, metaFixture } from '@/test/fixtures'

/** Параметры формы в виде объекта: FormData удобнее читать словарём. */
function formEntries(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
}

describe('домен расчёта диполей: формы, отпечатки и нормализация', () => {
  it('собирает форму спектра из параметров: без выдуманных значений', () => {
    // Спектр считается по всему диапазону записи (полоса фильтра одиночного
    // расчёта убрана), без шага сетки (он не нужен PSD); метод PSD — только
    // спектру (N17)
    expect(formEntries(buildSpectrumForm(CALC_PARAM_DEFAULTS))).toEqual({
      epoch_length_ms: '1000',
      psd_method: 'welch',
    })
    expect(formEntries(buildSpectrumForm({ ...CALC_PARAM_DEFAULTS, psdMethod: 'multitaper' }))).toEqual({
      epoch_length_ms: '1000',
      psd_method: 'multitaper',
    })
  })

  it('кладёт сетевой фильтр в форму спектра (срез 3.6)', () => {
    const params: CalcParams = { ...CALC_PARAM_DEFAULTS, notchHz: 50 }

    expect(formEntries(buildSpectrumForm(params))).toMatchObject({
      notch_hz: '50',
    })
    // «Без фильтра» — отсутствие значения, а не «0»
    expect(formEntries(buildSpectrumForm({ ...params, notchHz: null }))).not.toHaveProperty(
      'notch_hz',
    )
  })

  it('нормализует параметры расчёта и отбрасывает устаревшие поля формы фильтра', () => {
    const params = normalizeCalcParams({
      ...CALC_PARAM_DEFAULTS,
      // Поля удалённой формы фильтра одиночного расчёта — их место не в задаче
      ...( { filterPreset: 'none', filterBandHz: [20, 5], singleFreqHz: 999, bandwidthHz: 0 } as object),
      notchHz: 55,
      gridMm: 50,
      epochLengthMs: 500.4,
      // Мусор правок КД: не-числа — к «дефолту методики» (null), числа — в рамки
      ...( {
        kdGofByBand: { alpha: 'x', beta: 150, gamma: 77.5 },
        kdMomentSharePercent: Number.NaN,
      } as object),
    } as CalcParams)

    expect(params.notchHz).toBe(50)
    expect(params.gridMm).toBe(20)
    expect(params.epochLengthMs).toBe(500)
    // Устаревшие поля просто отброшены: хранить/переносить их незачем
    expect(params).toEqual({
      notchHz: 50,
      gridMm: 20,
      epochLengthMs: 500,
      psdMethod: CALC_PARAM_DEFAULTS.psdMethod,
      kdGofByBand: { alpha: null, beta: 100, gamma: 77.5 },
      kdMomentSharePercent: null,
    })
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
    // длина эпохи 1000 мс — расхождения быть не должно. Полоса фильтра в
    // отпечатке не живёт: у пакета своя полоса у каждой точки, а не у формы
    expect(resultSignature(result)).toBe(calcSignature(CALC_PARAM_DEFAULTS))
    expect(resultMatchesParams(result, CALC_PARAM_DEFAULTS)).toBe(true)

    // Правка любого параметра расчёта делает старый результат «посчитанным
    // на других настройках»: таблица обязана об этом сказать, а не молчать
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, gridMm: 12 })).toBe(false)
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
      grid_mm: '5',
      // Окно свободного фитинга (шаг 1.5): по умолчанию только пик GFP
      halfwin_ms: '0',
      // Момент заменяемой точки — якорь знака уточнения (срез 3.11)
      moment_dir: '0,1,0',
    })
    // Окно — из параметра: «пошире» уходит в задачу явно, а не по умолчанию
    expect(formEntries(buildRefineForm(result, 2, 10)).halfwin_ms).toBe('10')
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

describe('окно уточнения (шаг 1.5): варианты, оценка времени и честное «стало»', () => {
  it('число отсчётов окна считается от частоты записи, мусор хранилища — к пику', () => {
    expect(refineWindowSamples(0, 500)).toBe(1)
    expect(refineWindowSamples(10, 500)).toBe(11)
    expect(refineWindowSamples(10, 250)).toBe(5)
    expect(normalizeRefineHalfwin(10)).toBe(10)
    // Произвольное число из localStorage не превращается в «окно на минуты»
    expect(normalizeRefineHalfwin(20)).toBe(0)
    expect(normalizeRefineHalfwin(undefined)).toBe(0)
  })

  it('подписи вариантов окна читаемы без чисел конфига в UI', () => {
    expect(REFINE_HALFWIN_OPTIONS).toEqual([0, 2, 5, 10])
    expect(refineHalfwinLabel(0)).toContain('только пик')
    expect(refineHalfwinLabel(5)).toBe('±5 мс')
  })

  it('оценка времени берётся из чисел /meta, а не из головы клиента', () => {
    // 0.5 с (узел на BEM) + 1·7 с (свободный фит пика) → ≈8 с — тот же порядок,
    // что дал живой замер 20.09.2026
    expect(refineCostHint(metaFixture, 500, 0)).toBe(
      'Ожидаемое время ≈8 с: оценка узла на BEM ≈0.5 с + свободный фит 1 отсч. ≈7 с',
    )
    // Без результата расчёта частота записи неизвестна: число отсчётов не выдумываем
    expect(refineCostHint(metaFixture, null, 10)).toContain('частота записи станет известна')
    expect(refineCostHint(null, 500, 0)).toContain('Оценка времени появится')
  })

  it('сбой свободного фита называет «стало» оценкой узла, а не уточнением', () => {
    const fallback = dipoleRefineResultFixture({ free_fit: false, shift_mm: 0 })
    expect(refinedSummary(fallback)).toBe(
      'Оценка узла сетки на BEM: GOF 94.0 % · свободный фит не выполнен',
    )
    expect(refineTooltip(fallback)).toContain('Свободный фит не выполнен')
    expect(refineTooltip(dipoleRefineResultFixture({ halfwin_ms: 5 }))).toContain('±5 мс')
  })
})

describe('normalizeCalcView: подъём сохранённого вида панели', () => {
  it('пропускает известные виды и отбрасывает мусор хранилища', () => {
    // Все четыре вида валидны (правка 20.10.2026 вернула `fft` — панель АЧХ
    // снова собственная: в общей с топокартами график схлопывался по высоте);
    // мусор не должен открывать несуществующее окно
    expect(normalizeCalcView('fft')).toBe('fft')
    expect(normalizeCalcView('topomap')).toBe('topomap')
    expect(normalizeCalcView('explore')).toBe('explore')
    expect(normalizeCalcView('none')).toBe('none')
    expect(normalizeCalcView('histogram')).toBeNull()
    expect(normalizeCalcView(undefined)).toBeNull()
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
