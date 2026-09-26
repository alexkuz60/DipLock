/**
 * Тесты состояния раздела «ЭЭГ» (срез 5).
 *
 * Главное, что проверяется: расчёт запускается **только вызовом действия**
 * (кнопкой), задача идёт с поллингом прогресса и тянет сетку отдельным запросом,
 * а параметры просмотра (зум, шкала, палитра, окно дБ, сглаживание, окно частот,
 * разделитель) правятся без единого запроса и **не** обесценивают результат —
 * отпечаток `eegSignature` их не содержит. Равенство отпечатков результата и
 * параметров решает, показывать ли «параметры расчёта изменены».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api/client'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture, spectrogramJobFixture, spectrogramResultFixture } from '@/test/fixtures'
import {
  EEG_PARAM_DEFAULTS,
  SPECTROGRAM_WINDOW_RANGE_MS,
  buildSpectrogramForm,
  eegResultMatchesParams,
  eegSignature,
  normalizeEegParams,
  useEegParams,
  type EegParams,
} from './eegParams'

function resetState() {
  useEegParams.setState({
    params: { ...EEG_PARAM_DEFAULTS, filter: { ...EEG_PARAM_DEFAULTS.filter } },
    job: null,
    result: null,
    grid: null,
    error: null,
    gridError: null,
    eegNav: null,
  })
}

describe('состояние раздела «ЭЭГ»', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
  })

  it('правит параметры просмотра без запросов', () => {
    const fetchMock = mockApiFetch()
    const state = useEegParams.getState()

    state.setChannel('C3')
    state.setAmplitudeUv(48) // не из ряда — приводится к ближайшей шкале
    state.setFreqWindow([4, 8])
    state.setSpectrogramParams({ windowMs: 100, overlapPct: 120, fmaxHz: 500 })
    state.setParams({ palette: 'magma', smoothMs: 300, smoothBins: 5 })
    state.setParams({ dbRangeDb: [-30, -5] })

    const params = useEegParams.getState().params
    expect(params.channel).toBe('C3')
    expect(params.amplitudeUv).toBe(50)
    expect(params.freqWindow).toEqual([4, 8])
    // Окно STFT зажимается в границы контролов, а не «уезжает» в задачу
    expect(params.spectrogram).toEqual({ windowMs: 100, overlapPct: 95, fmaxHz: 120 })
    expect(params.palette).toBe('magma')
    expect(params.smoothMs).toBe(300)
    expect(params.smoothBins).toBe(5)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('нормализует новые параметры просмотра (N18): шкала, режим, baseline, окно %', () => {
    const params = normalizeEegParams({
      ...EEG_PARAM_DEFAULTS,
      // Мусор из localStorage прежней версии: неизвестное падает в дефолты
      freqScale: 'sqrt',
      valueMode: 'power',
      baselineSec: [-5, 99999],
      erdRangePct: [10, 10],
    } as unknown as EegParams)

    expect(params.freqScale).toBe('lin')
    expect(params.valueMode).toBe('db')
    expect(params.baselineSec).toEqual([0, 3600])
    // Равное окно % не делит на ноль: низ уходит вниз на шаг окна
    expect(params.erdRangePct).toEqual([0, 10])
  })

  it('не обесценивает результат правкой просмотра, но реагирует на расчёт', () => {
    // Параметры, которыми результат фикстуры реально посчитан: окно 1000 мс
    const params: EegParams = {
      ...EEG_PARAM_DEFAULTS,
      channel: 'Fp1',
      spectrogram: { windowMs: 1000, overlapPct: 75, fmaxHz: 40 },
    }
    const result = spectrogramResultFixture()
    expect(eegResultMatchesParams(result, params)).toBe(true)

    // Зум, шкала, палитра, окно дБ, сглаживание, разделитель и окно частот;
    // N18: шкала частот, режим ERD/ERS и baseline — тоже просмотр
    const viewed: EegParams = {
      ...params,
      timeLevel: 3,
      amplitudeUv: 200,
      palette: 'gray',
      dbRangeDb: [-20, 0],
      freqScale: 'log',
      valueMode: 'erd',
      baselineSec: [0, 2],
      erdRangePct: [-50, 50],
      smoothMs: 500,
      smoothBins: 7,
      splitRatio: 0.7,
      freqWindow: [8, 13],
      spectrogramMode: 'overview',
    }
    expect(eegSignature(viewed)).toBe(eegSignature(params))
    expect(eegResultMatchesParams(result, viewed)).toBe(true)

    // А параметры расчёта — обесценивают: другое окно, канал, полоса
    const otherWindow = { ...params, spectrogram: { ...params.spectrogram, windowMs: 250 } }
    expect(eegResultMatchesParams(result, otherWindow)).toBe(false)
    expect(eegResultMatchesParams(result, { ...params, channel: 'C3' })).toBe(false)
    expect(
      eegResultMatchesParams(result, {
        ...params,
        filter: { ...params.filter, filterBandHz: [8, 13] },
      }),
    ).toBe(false)
  })

  it('отправляет формой канал, полосу и окно STFT', () => {
    const form = buildSpectrogramForm(
      {
        ...EEG_PARAM_DEFAULTS,
        channel: 'Pz',
        filter: { ...EEG_PARAM_DEFAULTS.filter, filterBandHz: [8, 13], notchHz: 50 },
      },
      'Pz',
    )

    expect(form.get('channel')).toBe('Pz')
    expect(form.get('band_min')).toBe('8')
    expect(form.get('band_max')).toBe('13')
    expect(form.get('notch_hz')).toBe('50')
    expect(form.get('window_ms')).toBe('500')
    expect(form.get('overlap_pct')).toBe('75')
    expect(form.get('fmax_hz')).toBe('40')
  })
})

describe('задача расчёта спектрограммы', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
  })

  it('запускает расчёт, ведёт прогресс и читает сетку отдельным запросом', async () => {
    const fetchMock = mockApiFetch({ spectrogramJob: spectrogramJobFixture })
    await useEegParams.getState().runSpectrogram(recordingFixture.recording_id, 'Fp1')

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.includes('/spectrogram') && !url.includes('grid.bin'))).toBe(true)
    expect(urls.some((url) => url.endsWith('grid.bin?v=spec1234abcd'))).toBe(true)

    const state = useEegParams.getState()
    expect(state.job?.status).toBe('succeeded')
    expect(state.error).toBeNull()
    expect(state.result?.channel).toBe('Fp1')
    // Сетка разобрана: 3 частоты × 4 окна из фикстуры контейнера
    expect(state.grid?.nFreqs).toBe(3)
    expect(state.grid?.nTimes).toBe(4)
    expect(state.grid?.values[0]).toBe(0)
    expect(state.grid?.dbMax).toBe(0)
  })

  it('без записи и без канала расчёт не запускается', async () => {
    const fetchMock = mockApiFetch()
    await useEegParams.getState().runSpectrogram(null, 'Fp1')
    await useEegParams.getState().runSpectrogram(recordingFixture.recording_id, '')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useEegParams.getState().job).toBeNull()
  })

  it('показывает ошибку запуска, не теряя объяснение сервера', async () => {
    mockApiFetch({ calcStartFails: true })
    await useEegParams.getState().runSpectrogram(recordingFixture.recording_id, 'Fp1')

    const state = useEegParams.getState()
    expect(state.job?.status).toBe('failed')
    expect(state.error).toContain('Запись не найдена')
    expect(state.result).toBeNull()
    expect(state.grid).toBeNull()
  })

  it('ведёт навигацию по окну счётчиком команд, а не «ручкой» вьюера', () => {
    useEegParams.getState().requestNav('next')
    useEegParams.getState().requestNav('next')

    const nav = useEegParams.getState().eegNav
    // Повторная команда обязана быть видна часам: seq растёт монотонно
    expect(nav?.command).toBe('next')
    expect(nav?.seq).toBe(2)
  })

  it('сбрасывает данные записи, оставляя предпочтения просмотра', () => {
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, channel: 'C3', palette: 'gray', splitRatio: 0.7 },
      result: spectrogramResultFixture(),
      grid: null,
      job: {
        status: 'succeeded',
        progress: 1,
        message: '',
        stage: 'done',
        epochsDone: 0,
        epochsTotal: 0,
        error: null,
      },
    })

    useEegParams.getState().reset()

    const state = useEegParams.getState()
    expect(state.result).toBeNull()
    expect(state.job).toBeNull()
    expect(state.eegNav).toBeNull()
    expect(state.params.channel).toBeNull()
    // Предпочтения просмотра — не данные записи: остаются
    expect(state.params.palette).toBe('gray')
    expect(state.params.splitRatio).toBe(0.7)
  })
})

describe('нормализация сохранённых параметров', () => {
  it('поднимает параметры прежней версии UI и мусор в границы контролов', () => {
    const restored = normalizeEegParams({
      ...EEG_PARAM_DEFAULTS,
      channel: 'Fz',
      amplitudeUv: 999,
      timeLevel: 9,
      freqWindow: [13, 8],
      splitRatio: 5,
      spectrogram: { windowMs: 10, overlapPct: -5, fmaxHz: 1000 },
      filter: { ...EEG_PARAM_DEFAULTS.filter, filterBandHz: [13, 8], notchHz: 55 },
    })

    expect(restored.channel).toBe('Fz')
    expect(restored.amplitudeUv).toBe(500)
    expect(restored.timeLevel).toBe(4)
    // Окно частот приводится к порядку «низ → верх», разделитель зажимается
    expect(restored.freqWindow).toEqual([8, 13])
    expect(restored.splitRatio).toBe(0.85)
    expect(restored.spectrogram.windowMs).toBe(SPECTROGRAM_WINDOW_RANGE_MS[0])
    expect(restored.spectrogram.overlapPct).toBe(0)
    expect(restored.spectrogram.fmaxHz).toBe(120)
    // Полоса приводится к порядку, сетевой фильтр — к ближайшему из 50/60 Гц
    expect(restored.filter.filterBandHz).toEqual([8, 13])
    expect(restored.filter.notchHz).toBe(50)
  })
})

describe('отмена спектрограммы (3.2)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
    useEegParams.setState({
      job: {
        status: 'running',
        progress: 0.4,
        message: 'STFT по окнам',
        stage: 'spectrum',
        epochsDone: 4,
        epochsTotal: 10,
        error: null,
        jobId: 'job-77',
      },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('cancelSpectrogram: DELETE на сервере + локальный статус cancelled', () => {
    const cancelSpy = vi
      .spyOn(api, 'jobCancel')
      .mockResolvedValue({ ...spectrogramJobFixture, status: 'cancelled' })

    useEegParams.getState().cancelSpectrogram()

    expect(cancelSpy).toHaveBeenCalledWith('job-77')
    expect(useEegParams.getState().job?.status).toBe('cancelled')
  })

  it('без id задачи (ответ 202 ещё не пришёл) отмена не шлёт запрос', () => {
    const cancelSpy = vi.spyOn(api, 'jobCancel').mockResolvedValue(spectrogramJobFixture)
    useEegParams.setState({ job: { ...useEegParams.getState().job!, jobId: null } })

    useEegParams.getState().cancelSpectrogram()

    expect(cancelSpy).not.toHaveBeenCalled()
    expect(useEegParams.getState().job?.status).toBe('running')
  })
})

