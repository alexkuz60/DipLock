/**
 * Тесты состояния расчёта раздела «Диполи» (срез 3.4).
 *
 * Главное, что проверяется: расчёт запускается **только вызовом действия**
 * (кнопкой), уходит на сервер задачей с поллингом прогресса, а параметры
 * (порог «КД», шаг сетки, длина эпохи) правятся без единого запроса и с зажимом
 * в рамки контролов. Результат «Сбросить» убирает, параметры — нет.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mockApiFetch } from '@/test/apiMocks'
import {
  CALC_PARAM_DEFAULTS,
  buildDipoleForm,
  buildSpectrumForm,
  calcJobFromStatus,
  calcJobSummary,
  calcSignature,
  resultMatchesParams,
  resultSignature,
  useDipoleCalc,
} from './dipoleCalc'
import { calcJobFixture, dipoleScanResultFixture, jobFixture, spectrumResultFixture } from '@/test/fixtures'

function resetState() {
  useDipoleCalc.setState({
    view: 'none',
    amplitudeThresholdNam: 0,
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

  it('не запускает расчёт без записи (кнопка в шапке выключена)', async () => {
    const fetchSpy = mockApiFetch()
    await useDipoleCalc.getState().runCalculation(null)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('проводит расчёт задачей: 202 → поллинг → результат', async () => {
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })

    await useDipoleCalc.getState().runCalculation('rec-1')

    const urls = fetchSpy.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/dipoles')
    expect(urls.some((url) => url.startsWith('GET /api/v1/jobs/'))).toBe(true)
    expect(urls.some((url) => url.startsWith('GET /api/v1/recordings/rec-1/dipoles/'))).toBe(true)

    const state = useDipoleCalc.getState()
    expect(state.result?.method).toBe('fast_grid')
    expect(state.job?.status).toBe('succeeded')
    expect(state.error).toBeNull()
  })

  it('показывает прогресс по эпохам, пока задача идёт', async () => {
    const runningProgress = { ...calcJobFixture, status: 'running' as const, progress: 0.5, stage: 'scan', epochs_done: 2, epochs_total: 4 }
    // Первый опрос — ещё идёт, второй — успех: так виден промежуточный прогресс
    let polls = 0
    mockApiFetch({ calcJob: calcJobFixture })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/jobs/')) {
        polls += 1
        const body = polls === 1 ? runningProgress : calcJobFixture
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    await useDipoleCalc.getState().runCalculation('rec-1')

    expect(polls).toBeGreaterThanOrEqual(2)
    expect(useDipoleCalc.getState().job?.epochsTotal).toBe(4)
  })

  it('сообщает ошибку задачи и не подменяет результат прежним', async () => {
    const failed = { ...jobFixture, status: 'failed' as const, error: 'Ни одной эпохи не удалось локализовать' }
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

    const urls = fetchSpy.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)
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
  })

  it('переводит статус задачи сервера в состояние панели', () => {
    expect(calcJobFromStatus(calcJobFixture).status).toBe('succeeded')
    expect(calcJobFromStatus({ ...calcJobFixture, status: 'running' }).status).toBe('running')
    expect(calcJobFromStatus({ ...calcJobFixture, status: 'failed', error: 'сбой' }).error).toBe('сбой')
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
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, rejectThresholdUv: 300 })).toBe(false)
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, filterBandHz: null })).toBe(false)
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, notchHz: 50 })).toBe(false)
    expect(resultMatchesParams(result, { ...CALC_PARAM_DEFAULTS, epochLengthMs: 500 })).toBe(false)
  })
})
