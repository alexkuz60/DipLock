/**
 * Тесты состояния расчёта раздела «Диполи» (срез 3.4 + пакетный сценарий).
 *
 * Главное, что проверяется: расчёт (пакет по всем полосам каталога) запускается
 * **только вызовом действия** (кнопкой), уходит на сервер задачей с поллингом
 * прогресса, а параметры (порог «КД», шаг сетки, длина эпохи) правятся без
 * единого запроса и с зажимом в рамки контролов. Результат «Сбросить» убирает,
 * параметры — нет. Одиночный расчёт по всему спектру убран — устаревших веток
 * и их данных не храним.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api/client'
import type { JobStatus } from '@/shared/api/types'
import { mockApiFetch } from '@/test/apiMocks'
import { deferred } from '@/test/deferred'
import { CALC_PARAM_DEFAULTS, PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from './dipoleCalc'
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
    selectedEpochIndex: null,
    playback: { ...PLAYBACK_DEFAULTS },
    params: { ...CALC_PARAM_DEFAULTS },
    result: null,
    batch: null,
    batchJob: null,
    batchError: null,
    activeBandKey: null,
    playbackBandKeys: [],
    spectrumJob: null,
    spectrum: null,
    spectrumError: null,
  })
}

/** Все полосы каталога: так «Рассчитать пакет» шлёт их в прогон (форма задачи). */
const CATALOG_BANDS = ['delta', 'theta', 'alpha', 'beta']

describe('состояние расчёта диполей', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
  })

  afterEach(() => {
    // Отменяем подмену `api.job` из тестов отмены поллинга
    vi.restoreAllMocks()
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

    useDipoleCalc.getState().toggleView('explore')
    expect(useDipoleCalc.getState().view).toBe('explore')

    useDipoleCalc.getState().toggleView('explore')
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

  it('правит сетевой фильтр без запросов (срез 3.6)', () => {
    const fetchSpy = mockApiFetch()

    // Сетевой фильтр — только 50/60 Гц (список и состояние не разъезжаются)
    useDipoleCalc.getState().setNotchHz(55)
    expect(useDipoleCalc.getState().params.notchHz).toBe(50)
    useDipoleCalc.getState().setNotchHz(null)
    expect(useDipoleCalc.getState().params.notchHz).toBeNull()

    // Правка параметров — не запуск: расчёт идёт только по кнопке
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('отбрасывает устаревшие поля формы фильтра из прежней версии UI', async () => {
    // Так выглядело сохранённое состояние с формой фильтра одиночного расчёта:
    // она удалена, и её поля просто не переносятся — хранить устаревшее незачем
    localStorage.setItem(
      'diplock.dipoleCalc',
      JSON.stringify({
        state: {
          params: {
            filterPreset: 'alpha',
            filterBandHz: [8, 13],
            singleFreqHz: 7.83,
            bandwidthHz: 0.5,
            notchHz: 50,
            epochLengthMs: 500,
            gridMm: 9,
          },
        },
      }),
    )

    await useDipoleCalc.persist.rehydrate()

    const params = useDipoleCalc.getState().params
    expect(params).toEqual({
      notchHz: 50,
      epochLengthMs: 500,
      gridMm: 9,
      psdMethod: CALC_PARAM_DEFAULTS.psdMethod,
    })
  })

  it('не запускает расчёт без записи (кнопка в шапке выключена)', async () => {
    const fetchSpy = mockApiFetch()
    await useDipoleCalc.getState().runBatch(null, CATALOG_BANDS)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('проводит расчёт пакета задачей: 202 → поллинг → результат', async () => {
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })

    await useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)

    const urls = fetchSpy.mock.calls.map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/dipole_batch')
    expect(urls.some((url) => url.startsWith('GET /api/v1/jobs/'))).toBe(true)
    expect(
      urls.some((url) => url.startsWith('GET /api/v1/recordings/rec-1/dipole_batch/')),
    ).toBe(true)

    const state = useDipoleCalc.getState()
    expect(state.batch?.bands).toHaveLength(2)
    expect(state.batchJob?.status).toBe('succeeded')
    expect(state.batchError).toBeNull()
    // `result` — скан активной полосы набора: проекции/таблица работают без правок
    expect(state.result?.method).toBe('fast_grid')
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

    await useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)

    expect(polls).toBeGreaterThanOrEqual(2)
    expect(useDipoleCalc.getState().batchJob?.epochsTotal).toBe(4)
  })

  it('сообщает ошибку задачи и не подменяет результат прежним', async () => {
    const failed = {
      ...jobFixture,
      status: 'failed' as const,
      error: 'Ни одной эпохи не удалось локализовать',
    }
    mockApiFetch({ calcJob: failed })

    await useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)

    const state = useDipoleCalc.getState()
    expect(state.batchJob?.status).toBe('failed')
    expect(state.batchError).toBe('Ни одной эпохи не удалось локализовать')
    expect(state.result).toBeNull()
    expect(state.batch).toBeNull()
  })

  it('показывает понятный текст отказа запуска (404 записи)', async () => {
    mockApiFetch({ calcStartFails: true })

    await useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)

    expect(useDipoleCalc.getState().batchError).toBe('Запись не найдена или уже удалена')
    expect(useDipoleCalc.getState().batchJob?.status).toBe('failed')
  })

  it('держит ошибки расчёта и спектра раздельно', async () => {
    // Сбой спектра не должен выглядеть как сбой локализации (и наоборот):
    // панель показывает «спектр не рассчитан» только про свою задачу
    mockApiFetch({ calcStartFails: true })

    await useDipoleCalc.getState().runSpectrum('rec-1')

    const state = useDipoleCalc.getState()
    expect(state.spectrumError).toBe('Запись не найдена или уже удалена')
    expect(state.batchError).toBeNull()
    expect(state.spectrumJob?.status).toBe('failed')
  })

  it('считает спектр отдельной задачей и кладёт его в состояние', async () => {
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })

    await useDipoleCalc.getState().runSpectrum('rec-1')

    const urls = fetchSpy.mock.calls.map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/spectrum')
    expect(useDipoleCalc.getState().spectrum?.bands).toHaveLength(13)
    expect(useDipoleCalc.getState().spectrumJob?.status).toBe('succeeded')
  })

  it('«Сбросить расчёт» прекращает опрос задачи: прежний ответ не возвращает результат', async () => {
    // Задача «висит» на опросе: её ответ приходит уже после сброса расчёта
    const stale = deferred<JobStatus>()
    const jobSpy = vi.spyOn(api, 'job').mockImplementationOnce(() => stale.promise)
    mockApiFetch({ calcJob: calcJobFixture })

    const pending = useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)
    await vi.waitFor(() => expect(jobSpy).toHaveBeenCalledTimes(1))
    useDipoleCalc.getState().reset()
    stale.resolve(calcJobFixture)
    await pending

    // Отменённый запуск не вернул ни задачу, ни результат (поллинг бросил отмену)
    const state = useDipoleCalc.getState()
    expect(state.batchJob).toBeNull()
    expect(state.result).toBeNull()
    expect(state.batchError).toBeNull()
  })

  it('«Сбросить расчёт» убирает результаты, но сохраняет параметры и панель', () => {
    useDipoleCalc.setState({
      view: 'topomap',
      amplitudeThresholdNam: 25,
      result: dipoleScanResultFixture(),
      spectrum: spectrumResultFixture(),
      selectedPointId: '0-120',
      selectedEpochIndex: 2,
    })

    useDipoleCalc.getState().reset()

    const state = useDipoleCalc.getState()
    expect(state.result).toBeNull()
    expect(state.spectrum).toBeNull()
    expect(state.batchError).toBeNull()
    expect(state.spectrumError).toBeNull()
    expect(state.view).toBe('topomap')
    expect(state.amplitudeThresholdNam).toBe(25)
    expect(state.params).toEqual(CALC_PARAM_DEFAULTS)
    // Выделенные диполь и эпоха жили в результате задачи — вместе с ним они исчезают
    expect(state.selectedPointId).toBeNull()
    expect(state.selectedEpochIndex).toBeNull()
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
})

/**
 * Кадр воспроизведения траектории (срез 3.7): состояние **принимает команды**
 * (play/pause, покадрово, скорость, снятие кадра) и хранит номер эпохи. Само время
 * кадра ведут часы раздела (`PlaybackFrame.tsx`), поэтому здесь проверяются зажимы,
 * счётчик пользовательских переходов и снятие кадра вместе с результатом.
 */
describe('кадр воспроизведения в состоянии расчёта (срез 3.7)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
  })

  it('начинает без воспроизведения и без кадра', () => {
    expect(useDipoleCalc.getState().playback).toEqual(PLAYBACK_DEFAULTS)
  })

  it('не играет без результата: кнопка выключена, действие молчит', () => {
    useDipoleCalc.getState().togglePlayback()
    expect(useDipoleCalc.getState().playback.playing).toBe(false)

    // Результат без точек (все эпохи отброшены) тоже не даёт кадров
    useDipoleCalc.setState({ result: dipoleScanResultFixture({ points: [] }) })
    useDipoleCalc.getState().togglePlayback()
    expect(useDipoleCalc.getState().playback.playing).toBe(false)
  })

  it('играет и ставит на паузу, оставляя кадр до отдельного снятия', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })

    useDipoleCalc.getState().togglePlayback()
    expect(useDipoleCalc.getState().playback).toMatchObject({
      playing: true,
      active: true,
      epochIndex: 0,
    })
    const seq = useDipoleCalc.getState().playback.seekSeq

    useDipoleCalc.getState().togglePlayback()
    // Пауза кадр не снимает: именно так останавливаются на интересующей эпохе
    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: false, active: true })
    expect(useDipoleCalc.getState().playback.seekSeq).toBe(seq)

    useDipoleCalc.getState().clearPlaybackFrame()
    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: false, active: false })
  })

  it('начинает запись сначала, если play нажат на последней эпохе', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, epochIndex: 3 },
    })

    useDipoleCalc.getState().togglePlayback()

    // Иначе кнопка «играла» бы, а картинка стояла на месте
    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: true, epochIndex: 0 })
  })

  it('клик по ячейке индикатора выбирает эпоху и перематывает кадр (3.3/3.4)', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })

    // Выбор эпохи: пакет диполей её эпохи + кадр анимации встаёт на неё же
    useDipoleCalc.getState().toggleSelectedEpoch(1)
    expect(useDipoleCalc.getState().selectedEpochIndex).toBe(1)
    expect(useDipoleCalc.getState().playback).toMatchObject({
      playing: false,
      active: true,
      epochIndex: 1,
    })

    // Команда перемотки — новая для часов: счётчик переходов растёт
    const seq = useDipoleCalc.getState().playback.seekSeq
    useDipoleCalc.getState().toggleSelectedEpoch(3)
    expect(useDipoleCalc.getState().selectedEpochIndex).toBe(3)
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(3)
    expect(useDipoleCalc.getState().playback.seekSeq).toBe(seq + 1)

    // Повторный клик по той же ячейке снимает выбор, кадр остаётся на месте
    useDipoleCalc.getState().toggleSelectedEpoch(3)
    expect(useDipoleCalc.getState().selectedEpochIndex).toBeNull()
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(3)

    // Сдвиг часов: кадр меняется, а счётчик команд — нет (это не команда)
    const beforeSeq = useDipoleCalc.getState().playback.seekSeq
    useDipoleCalc.getState().setPlaybackEpoch(2)
    expect(useDipoleCalc.getState().playback).toMatchObject({ epochIndex: 2, seekSeq: beforeSeq })
    // Тот же кадр — состояние не трогаем: часы пишут его десятки раз в секунду
    const before = useDipoleCalc.getState().playback
    useDipoleCalc.getState().setPlaybackEpoch(2)
    expect(useDipoleCalc.getState().playback).toBe(before)
  })

  it('переводит кадр на конкретную эпоху и приводит скорость к ×1/×2/×4', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })

    useDipoleCalc.getState().seekPlaybackEpoch(2)
    expect(useDipoleCalc.getState().playback).toMatchObject({
      epochIndex: 2,
      active: true,
      playing: false,
    })
    useDipoleCalc.getState().seekPlaybackEpoch(99)
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(3)

    useDipoleCalc.getState().setPlaybackSpeed(4)
    expect(useDipoleCalc.getState().playback.speed).toBe(4)
    // Замедление — тоже допустимая скорость (поправка ручной проверки)
    useDipoleCalc.getState().setPlaybackSpeed(0.25)
    expect(useDipoleCalc.getState().playback.speed).toBe(0.25)
    // Скорости ×3 в UI нет: чужое значение не должно дойти до часов
    useDipoleCalc.getState().setPlaybackSpeed(3)
    expect(useDipoleCalc.getState().playback.speed).toBe(1)
  })

  it('снимает кадр вместе с результатом, а скорость оставляет', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { playing: true, speed: 2, epochIndex: 2, seekSeq: 4, active: true },
    })

    useDipoleCalc.getState().reset()

    expect(useDipoleCalc.getState().playback).toEqual({
      playing: false,
      speed: 2,
      epochIndex: 0,
      seekSeq: 0,
      active: false,
    })
  })

  it('снимает прежний кадр, когда приходит новый результат расчёта', async () => {
    mockApiFetch({ calcJob: calcJobFixture })
    useDipoleCalc.setState({
      playback: { playing: true, speed: 1, epochIndex: 2, seekSeq: 3, active: true },
    })

    await useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)

    // Номер эпохи без своего результата ничего не значит: новая нарезка — новый кадр
    expect(useDipoleCalc.getState().playback).toEqual(PLAYBACK_DEFAULTS)
    expect(useDipoleCalc.getState().batch?.bands?.length).toBeGreaterThan(0)
  })

  it('не персистит кадр воспроизведения (только параметры и предпочтения)', () => {
    useDipoleCalc.setState({
      playback: { ...PLAYBACK_DEFAULTS, playing: true, active: true, epochIndex: 2 },
    })

    const raw = localStorage.getItem('diplock.dipoleCalc')
    expect(raw).toBeTruthy()
    expect(raw).not.toContain('playback')
    expect(raw).toContain('amplitudeThresholdNam')
  })

  it('окно уточнения: только варианты списка, значение уезжает в форму (шаг 1.5)', async () => {
    const state = useDipoleCalc.getState()
    // По умолчанию — пик GFP: окно ±10 мс стоило ≈80 с вместо ≈8 с
    expect(state.refineHalfwinMs).toBe(0)
    // Произвольное число не принимается: «окно на 15 мс» было бы скрытой ценой
    state.setRefineHalfwinMs(15)
    expect(useDipoleCalc.getState().refineHalfwinMs).toBe(0)
    useDipoleCalc.getState().setRefineHalfwinMs(5)
    expect(useDipoleCalc.getState().refineHalfwinMs).toBe(5)
  })

  it('уточнение уходит задачей с выбранным окном, результат — в refinedPoints', async () => {
    const fetchSpy = mockApiFetch()
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      refineHalfwinMs: 5,
    })

    await useDipoleCalc.getState().refineEpoch('rec-1', 0)

    const refineCall = fetchSpy.mock.calls.find(([input]) =>
      String(input).includes('/dipole_refine'),
    )
    expect(refineCall).toBeDefined()
    expect(refineCall?.[1]?.method).toBe('POST')
    const form = refineCall?.[1]?.body as FormData
    expect(form.get('halfwin_ms')).toBe('5')
    expect(form.get('epoch_index')).toBe('0')

    const refined = useDipoleCalc.getState().refinedPoints[0]
    expect(refined?.method).toBe('bem_fit')
    expect(useDipoleCalc.getState().refineJob?.status).toBe('succeeded')
  })

  it('персистит окно уточнения: предпочтение переживает перезагрузку', () => {
    useDipoleCalc.getState().setRefineHalfwinMs(10)

    const raw = localStorage.getItem('diplock.dipoleCalc')
    expect(raw).toContain('"refineHalfwinMs":10')
  })
})

describe('отмена расчёта (3.2)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
    useDipoleCalc.setState({
      batchJob: {
        status: 'running',
        progress: 0.5,
        message: 'Поиск по сетке',
        stage: 'scan',
        epochsDone: 2,
        epochsTotal: 4,
        error: null,
        jobId: 'job-c1',
      },
      spectrumJob: {
        status: 'running',
        progress: 0.2,
        message: 'Welch PSD',
        stage: 'spectrum',
        epochsDone: 0,
        epochsTotal: 0,
        error: null,
        jobId: 'job-s1',
      },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('cancelBatch: DELETE расчёту пакета + локальный cancelled, спектр не тронут', () => {
    const cancelSpy = vi
      .spyOn(api, 'jobCancel')
      .mockResolvedValue({ ...jobFixture, status: 'cancelled' })

    useDipoleCalc.getState().cancelBatch()

    expect(cancelSpy).toHaveBeenCalledWith('job-c1')
    expect(useDipoleCalc.getState().batchJob?.status).toBe('cancelled')
    expect(useDipoleCalc.getState().spectrumJob?.status).toBe('running')
  })

  it('cancelSpectrum: DELETE спектру + локальный cancelled, расчёт не тронут', () => {
    const cancelSpy = vi
      .spyOn(api, 'jobCancel')
      .mockResolvedValue({ ...jobFixture, status: 'cancelled' })

    useDipoleCalc.getState().cancelSpectrum()

    expect(cancelSpy).toHaveBeenCalledWith('job-s1')
    expect(useDipoleCalc.getState().spectrumJob?.status).toBe('cancelled')
    expect(useDipoleCalc.getState().batchJob?.status).toBe('running')
  })

  it('без id задачи отмена не шлёт запрос — нечего останавливать', () => {
    const cancelSpy = vi.spyOn(api, 'jobCancel').mockResolvedValue(jobFixture)
    useDipoleCalc.setState({
      batchJob: { ...useDipoleCalc.getState().batchJob!, jobId: null },
    })

    useDipoleCalc.getState().cancelBatch()

    expect(cancelSpy).not.toHaveBeenCalled()
  })
})

describe('пакет поддиапазонов (С1)', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS },
      batch: null,
      batchJob: null,
      batchError: null,
      activeBandKey: null,
      result: null,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('не запускает пакет без полос каталога: понятная ошибка, ни одного запроса', async () => {
    const fetchSpy = mockApiFetch()
    await useDipoleCalc.getState().runBatch('rec-1', [])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(useDipoleCalc.getState().batchError).toMatch(/Каталог полос пуст/)
  })

  it('шлёт в прогон все полосы каталога, снимая дубли ключей', async () => {
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })

    await useDipoleCalc.getState().runBatch('rec-1', ['alpha', 'alpha', 'beta'])

    const startCall = fetchSpy.mock.calls.find(([input, init]) =>
      init?.method === 'POST' && String(input).endsWith('/dipole_batch'),
    )
    const form = startCall?.[1]?.body as FormData
    expect(form.get('bands')).toBe('alpha,beta')
  })

  it('проводит пакет задачей: 202 → поллинг → набор результатов', async () => {
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })

    await useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)

    const urls = fetchSpy.mock.calls.map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/dipole_batch')
    expect(urls.some((url) => url.startsWith('GET /api/v1/jobs/'))).toBe(true)
    expect(
      urls.some((url) => url.startsWith('GET /api/v1/recordings/rec-1/dipole_batch/')),
    ).toBe(true)

    const state = useDipoleCalc.getState()
    expect(state.batch?.bands).toHaveLength(2)
    expect(state.batchJob?.status).toBe('succeeded')
    expect(state.batchError).toBeNull()
    // Активная полоса — первая; `result` держит её скан (прежняя отрисовка)
    expect(state.activeBandKey).toBe('alpha')
    expect(state.result?.filter_band_hz).toEqual([8, 13])
  })

  it('переключение полосы набора меняет result и снимает прежние выделение/кадр', async () => {
    mockApiFetch({ calcJob: calcJobFixture })
    await useDipoleCalc.getState().runBatch('rec-1', CATALOG_BANDS)
    useDipoleCalc.setState({ selectedPointId: 'p-1', selectedEpochIndex: 2 })

    useDipoleCalc.getState().setActiveBand('beta')

    const state = useDipoleCalc.getState()
    expect(state.activeBandKey).toBe('beta')
    expect(state.result?.filter_band_hz).toEqual([13, 30])
    // Выделение и кадр относились к точкам прежней полосы — они сняты
    expect(state.selectedPointId).toBeNull()
    expect(state.selectedEpochIndex).toBeNull()
    expect(state.playback.playing).toBe(false)
    expect(state.playback.epochIndex).toBe(0)
  })
})
