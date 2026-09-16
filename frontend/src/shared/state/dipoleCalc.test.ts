/**
 * Тесты состояния расчёта раздела «Диполи» (срез 3.4).
 *
 * Главное, что проверяется: расчёт запускается **только вызовом действия**
 * (кнопкой), уходит на сервер задачей с поллингом прогресса, а параметры
 * (порог «КД», шаг сетки, длина эпохи) правятся без единого запроса и с зажимом
 * в рамки контролов. Результат «Сбросить» убирает, параметры — нет.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { BANDWIDTH_RANGE, SINGLE_FREQ_RANGE } from '@/shared/lib/calcFilter'
import { mockApiFetch } from '@/test/apiMocks'
import {
  CALC_PARAM_DEFAULTS,
  buildDipoleForm,
  buildSpectrumForm,
  calcJobFromStatus,
  calcJobSummary,
  calcSignature,
  normalizeCalcParams,
  resultMatchesParams,
  resultSignature,
  useDipoleCalc,
  type CalcParams,
} from './dipoleCalc'
import {
  calcJobFixture,
  dipoleScanResultFixture,
  jobFixture,
  spectrumResultFixture,
} from '@/test/fixtures'

function resetState() {
  useDipoleCalc.setState({
    view: 'none',
    amplitudeThresholdNam: 0,
    fftRangeHz: null,
    selectedPointId: null,
    params: { ...CALC_PARAM_DEFAULTS },
    job: null,
    result: null,
    spectrumJob: null,
    spectrum: null,
    error: null,
    spectrumError: null,
  })
}

/** Параметры формы в виде объекта: FormData удобнее читать словарём. */
function formEntries(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]))
}

describe('состояние расчёта диполей', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
  })

  it('начинает с закрытой панелью, без порога и с параметрами по умолчанию', () => {
    const state = useDipoleCalc.getState()
    expect(state.view).toBe('none')
    expect(state.amplitudeThresholdNam).toBe(0)
    expect(state.params).toEqual(CALC_PARAM_DEFAULTS)
    expect(state.result).toBeNull()
  })

  it('открывает и закрывает выдвижную панель одной и той же кнопкой', () => {
    useDipoleCalc.getState().toggleView('topomap')
    expect(useDipoleCalc.getState().view).toBe('topomap')

    useDipoleCalc.getState().toggleView('fft')
    expect(useDipoleCalc.getState().view).toBe('fft')

    useDipoleCalc.getState().toggleView('fft')
    expect(useDipoleCalc.getState().view).toBe('none')
  })

  it('правит окно частот FFT без запросов, с нормализацией границ (срез 3.5)', () => {
    const fetchSpy = mockApiFetch()

    useDipoleCalc.getState().setFftRange([13, 8])
    expect(useDipoleCalc.getState().fftRangeHz).toEqual([8, 13])

    useDipoleCalc.getState().setFftRange([8.04, 12.96])
    expect(useDipoleCalc.getState().fftRangeHz).toEqual([8, 13])

    // Мусорный ввод трактуется как «весь диапазон», а не как окно [0, 0]
    useDipoleCalc.getState().setFftRange([Number.NaN, 10])
    expect(useDipoleCalc.getState().fftRangeHz).toBeNull()

    useDipoleCalc.getState().setFftRange(null)
    expect(useDipoleCalc.getState().fftRangeHz).toBeNull()
    // Окно — параметр просмотра: правка ничего не запускает и ни о чём не спрашивает
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('выделяет диполь переключателем и сбрасывает выделение (срез 3.5)', () => {
    useDipoleCalc.getState().toggleSelectedPoint('0-120')
    expect(useDipoleCalc.getState().selectedPointId).toBe('0-120')

    // Повторный клик по той же точке снимает выделение (выбор в одной, «отмена» в ней же)
    useDipoleCalc.getState().toggleSelectedPoint('0-120')
    expect(useDipoleCalc.getState().selectedPointId).toBeNull()

    useDipoleCalc.getState().toggleSelectedPoint('1-140')
    useDipoleCalc.getState().clearSelectedPoint()
    expect(useDipoleCalc.getState().selectedPointId).toBeNull()
  })

  it('зажимает порог «КД» и шаг сетки в рамки контролов', () => {
    const state = useDipoleCalc.getState()
    state.setAmplitudeThreshold(-5)
    expect(useDipoleCalc.getState().amplitudeThresholdNam).toBe(0)
    useDipoleCalc.getState().setAmplitudeThreshold(9999)
    expect(useDipoleCalc.getState().amplitudeThresholdNam).toBe(1000)

    useDipoleCalc.getState().setGridMm(1)
    expect(useDipoleCalc.getState().params.gridMm).toBe(2)
    useDipoleCalc.getState().setGridMm(50)
    expect(useDipoleCalc.getState().params.gridMm).toBe(20)
  })

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

  it('правит полосу и сетевой фильтр без запросов (срез 3.6)', () => {
    const fetchSpy = mockApiFetch()

    // Полоса нормализуется: границы по возрастанию, «пустая» полоса — без фильтра
    useDipoleCalc.getState().setFilterBand([13, 8])
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([8, 13])
    // Правка полосы руками — это «свой диапазон», а не подмена выбранного ритма
    expect(useDipoleCalc.getState().params.filterPreset).toBe('custom')
    useDipoleCalc.getState().setFilterBand([8, 8])
    expect(useDipoleCalc.getState().params.filterBandHz).toBeNull()
    expect(useDipoleCalc.getState().params.filterPreset).toBe('none')

    // Пресет берёт полосу из метаданных сервера, а не из таблицы в коде UI
    useDipoleCalc.getState().setFilterPreset('alpha', { alpha: [8, 13] })
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([8, 13])
    expect(useDipoleCalc.getState().params.filterPreset).toBe('alpha')
    useDipoleCalc.getState().setFilterPreset('none', { alpha: [8, 13] })
    expect(useDipoleCalc.getState().params.filterBandHz).toBeNull()

    // Одиночная частота: полоса пересчитывается как f ± bw/2
    useDipoleCalc.getState().setSingleFreq(10)
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([9.8, 10.3])
    expect(useDipoleCalc.getState().params.filterPreset).toBe('single')
    useDipoleCalc.getState().setBandwidth(1)
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([9.5, 10.5])

    // Сетевой фильтр — только 50/60 Гц (список и состояние не разъезжаются)
    useDipoleCalc.getState().setNotchHz(55)
    expect(useDipoleCalc.getState().params.notchHz).toBe(50)
    useDipoleCalc.getState().setNotchHz(null)
    expect(useDipoleCalc.getState().params.notchHz).toBeNull()

    // Правка параметров — не запуск: расчёт идёт только по кнопке
    expect(fetchSpy).not.toHaveBeenCalled()
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

  it('поднимает параметры прежней версии UI с дефолтами формы фильтра (срез 3.6)', async () => {
    // Так выглядело сохранённое состояние до среза 3.6: полей одиночной частоты нет
    localStorage.setItem(
      'diplock.dipoleCalc',
      JSON.stringify({
        state: {
          params: {
            filterBandHz: [8, 13],
            notchHz: null,
            epochLengthMs: 500,
            rejectThresholdUv: 200,
            gridMm: 9,
          },
        },
      }),
    )

    await useDipoleCalc.persist.rehydrate()

    const params = useDipoleCalc.getState().params
    expect(params.filterBandHz).toEqual([8, 13])
    expect(params.epochLengthMs).toBe(500)
    // Полей не было — они берут значения по умолчанию, а не `undefined`
    expect(params.singleFreqHz).toBe(CALC_PARAM_DEFAULTS.singleFreqHz)
    expect(params.bandwidthHz).toBe(CALC_PARAM_DEFAULTS.bandwidthHz)
    // Пресета тоже не было: он выводится из полосы (1–40 → «широкий», здесь — «свой»),
    // а не берётся дефолтный и не называет эти границы чужим ритмом
    expect(params.filterPreset).toBe('custom')
  })

  it('не запускает расчёт без записи (кнопка в шапке выключена)', async () => {
    const fetchSpy = mockApiFetch()
    await useDipoleCalc.getState().runCalculation(null)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('проводит расчёт задачей: 202 → поллинг → результат', async () => {
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })

    await useDipoleCalc.getState().runCalculation('rec-1')

    const urls = fetchSpy.mock.calls.map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/dipoles')
    expect(urls.some((url) => url.startsWith('GET /api/v1/jobs/'))).toBe(true)
    expect(urls.some((url) => url.startsWith('GET /api/v1/recordings/rec-1/dipoles/'))).toBe(true)

    const state = useDipoleCalc.getState()
    expect(state.result?.method).toBe('fast_grid')
    expect(state.job?.status).toBe('succeeded')
    expect(state.error).toBeNull()
  })

  it('показывает прогресс по эпохам, пока задача идёт', async () => {
    const runningProgress = {
      ...calcJobFixture,
      status: 'running' as const,
      progress: 0.5,
      stage: 'scan',
      epochs_done: 2,
      epochs_total: 4,
    }
    // Первый опрос — ещё идёт, второй — успех: так виден промежуточный прогресс
    let polls = 0
    mockApiFetch({ calcJob: calcJobFixture })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/jobs/')) {
        polls += 1
        const body = polls === 1 ? runningProgress : calcJobFixture
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    await useDipoleCalc.getState().runCalculation('rec-1')

    expect(polls).toBeGreaterThanOrEqual(2)
    expect(useDipoleCalc.getState().job?.epochsTotal).toBe(4)
  })

  it('сообщает ошибку задачи и не подменяет результат прежним', async () => {
    const failed = {
      ...jobFixture,
      status: 'failed' as const,
      error: 'Ни одной эпохи не удалось локализовать',
    }
    mockApiFetch({ calcJob: failed })

    await useDipoleCalc.getState().runCalculation('rec-1')

    const state = useDipoleCalc.getState()
    expect(state.job?.status).toBe('failed')
    expect(state.error).toBe('Ни одной эпохи не удалось локализовать')
    expect(state.result).toBeNull()
  })

  it('показывает понятный текст отказа запуска (404 записи)', async () => {
    mockApiFetch({ calcStartFails: true })

    await useDipoleCalc.getState().runCalculation('rec-1')

    expect(useDipoleCalc.getState().error).toBe('Запись не найдена или уже удалена')
    expect(useDipoleCalc.getState().job?.status).toBe('failed')
  })

  it('держит ошибки расчёта и спектра раздельно', async () => {
    // Сбой спектра не должен выглядеть как сбой локализации (и наоборот):
    // панель показывает «спектр не рассчитан» только про свою задачу
    mockApiFetch({ calcStartFails: true })

    await useDipoleCalc.getState().runSpectrum('rec-1')

    const state = useDipoleCalc.getState()
    expect(state.spectrumError).toBe('Запись не найдена или уже удалена')
    expect(state.error).toBeNull()
    expect(state.spectrumJob?.status).toBe('failed')
  })

  it('считает спектр отдельной задачей и кладёт его в состояние', async () => {
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })

    await useDipoleCalc.getState().runSpectrum('rec-1')

    const urls = fetchSpy.mock.calls.map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/spectrum')
    expect(useDipoleCalc.getState().spectrum?.bands).toHaveLength(5)
    expect(useDipoleCalc.getState().spectrumJob?.status).toBe('succeeded')
  })

  it('«Сбросить расчёт» убирает результаты, но сохраняет параметры и панель', () => {
    useDipoleCalc.setState({
      view: 'fft',
      amplitudeThresholdNam: 25,
      result: dipoleScanResultFixture(),
      spectrum: spectrumResultFixture(),
      selectedPointId: '0-120',
    })

    useDipoleCalc.getState().reset()

    const state = useDipoleCalc.getState()
    expect(state.result).toBeNull()
    expect(state.spectrum).toBeNull()
    expect(state.error).toBeNull()
    expect(state.spectrumError).toBeNull()
    expect(state.view).toBe('fft')
    expect(state.amplitudeThresholdNam).toBe(25)
    expect(state.params).toEqual(CALC_PARAM_DEFAULTS)
    // Выделенный диполь жил в результате задачи — вместе с ним он исчезает
    expect(state.selectedPointId).toBeNull()
  })

  it('персистит окно частот, но не выделенный диполь (срез 3.5)', () => {
    useDipoleCalc.getState().setFftRange([8, 13])
    useDipoleCalc.getState().toggleSelectedPoint('0-120')

    const raw = JSON.parse(localStorage.getItem('diplock.dipoleCalc') ?? '{}') as {
      state: { fftRangeHz?: unknown; selectedPointId?: unknown }
    }

    // Окно — предпочтение просмотра (переживает перезагрузку), выделение — сессия
    expect(raw.state.fftRangeHz).toEqual([8, 13])
    expect(raw.state.selectedPointId).toBeUndefined()
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
