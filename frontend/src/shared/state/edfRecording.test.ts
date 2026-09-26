/**
 * Тесты состояния раздела EDF: паспорт сессии, запрос диалога выбора файла,
 * локальная валидация до отправки на сервер и догрузка кадров сигналов (2.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api/client'
import type { JobStatus } from '@/shared/api/types'
import { deferred } from '@/test/deferred'
import {
  EMPTY_PASSPORT,
  acceptEdfFile,
  buildEvokedForm,
  buildPreprocessForm,
  filterBandOf,
  layersFromResult,
  reconcileEventId,
  useEdfRecording,
  validateEdfFile,
} from '@/shared/state/edfRecording'
import {
  EDF_PARAM_DEFAULTS,
  emptyStageSnapshot,
  stageStateOf,
  useEdfParams,
} from '@/shared/state/edfParams'
import { mockApiFetch } from '@/test/apiMocks'
import {
  evokedResultFixture,
  preprocessJobFixture,
  preprocessResultFixture,
  recordingFixture,
} from '@/test/fixtures'

/** Файл с заданным именем и «весом» (байты не аллоцируем — важен только size). */
function edfFile(name = 'probe.edf', size = 1024): File {
  const file = new File([new Uint8Array(8)], name, { type: 'application/octet-stream' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('состояние раздела EDF', () => {
  beforeEach(() => {
    useEdfRecording.setState({
      recording: null,
      demo: null,
      uploadProgress: null,
      uploadError: null,
      passport: { ...EMPTY_PASSPORT },
      fileDialogRequest: 0,
      signalFrames: {},
      signalsPending: 0,
      signalsError: null,
      layers: null,
      epochMarks: [],
      stageJobs: {},
    })
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
  })

  it('фикстура слоёв живёт только в демо-режиме: у записи слоёв до расчёта нет', () => {
    useEdfRecording.getState().finishUpload(recordingFixture)

    // Под реальный файл фикстура не подставляется: иначе её зоны и штриховка
    // читались бы как результат детектора (ручная проверка, 19.09.2026)
    expect(useEdfRecording.getState().layers).toBeNull()

    useEdfRecording.getState().openDemo(['F3', 'F4'])
    const demo = useEdfRecording.getState().layers
    expect(demo?.source).toBe('demo')
    expect(demo?.artifacts.length).toBeGreaterThan(0)
    expect(demo?.rejectedEpochs.length).toBeGreaterThan(0)

    useEdfRecording.getState().closeDemo()
    expect(useEdfRecording.getState().layers).toBeNull()
  })

  it('паспорт принадлежит сессии: заполняется именем файла и очищается с записью', () => {
    useEdfRecording.getState().finishUpload(recordingFixture)

    expect(useEdfRecording.getState().passport.title).toBe(recordingFixture.filename)
    expect(useEdfRecording.getState().passport.units).toBe('auto')

    useEdfRecording.getState().setPassport({ subject: 'S-01', units: 'uV' })
    expect(useEdfRecording.getState().passport.subject).toBe('S-01')

    useEdfRecording.getState().closeRecording()
    expect(useEdfRecording.getState().passport).toEqual(EMPTY_PASSPORT)
    expect(useEdfRecording.getState().recording).toBeNull()
  })

  it('ручные пометки эпох принадлежат записи: переключаются, сбрасываются и не текут в новую', () => {
    const interval = { onsetSec: 2, durationSec: 2 }

    // Ctrl+двойной клик по эпохе, которую алгоритм не отбрасывал — блокировка
    useEdfRecording.getState().toggleEpochBlock(interval, false)
    expect(useEdfRecording.getState().epochMarks).toEqual([
      { onsetSec: 2, durationSec: 2, blocked: true },
    ])

    // Повторный Ctrl+двойной клик возвращает вердикт reject-фильтра
    useEdfRecording.getState().toggleEpochBlock(interval, false)
    expect(useEdfRecording.getState().epochMarks).toEqual([])

    useEdfRecording.getState().toggleEpochBlock(interval, false)
    useEdfRecording.getState().clearEpochMarks()
    expect(useEdfRecording.getState().epochMarks).toEqual([])

    // Правки не переезжают на следующую запись и не переживают закрытие раздела
    useEdfRecording.getState().toggleEpochBlock(interval, false)
    useEdfRecording.getState().finishUpload(recordingFixture)
    expect(useEdfRecording.getState().epochMarks).toEqual([])

    useEdfRecording.getState().toggleEpochBlock(interval, false)
    useEdfRecording.getState().closeRecording()
    expect(useEdfRecording.getState().epochMarks).toEqual([])
  })

  it('requestFileDialog считает запросы тулс-хедара к рабочей области', () => {
    expect(useEdfRecording.getState().fileDialogRequest).toBe(0)

    useEdfRecording.getState().requestFileDialog()
    useEdfRecording.getState().requestFileDialog()

    expect(useEdfRecording.getState().fileDialogRequest).toBe(2)
  })

  it('validateEdfFile отсекает не-EDF и файлы больше 200 МБ', () => {
    expect(validateEdfFile(edfFile())).toBeNull()
    expect(validateEdfFile(edfFile('probe.txt'))).toMatch(/не EDF/)
    expect(validateEdfFile(edfFile('huge.edf', 300 * 1024 * 1024))).toMatch(/максимум 200 МБ/)
  })

  it('acceptEdfFile с негодным файлом объясняет отказ и ничего не отправляет', () => {
    const xhr = vi.fn()
    vi.stubGlobal('XMLHttpRequest', xhr)

    acceptEdfFile(edfFile('probe.txt'))

    expect(useEdfRecording.getState().uploadError).toMatch(/не EDF/)
    expect(useEdfRecording.getState().uploadProgress).toBeNull()
    expect(xhr).not.toHaveBeenCalled()
  })

  it('acceptEdfFile игнорирует пустой выбор (отмена в диалоге)', () => {
    acceptEdfFile(undefined)
    acceptEdfFile(null)

    expect(useEdfRecording.getState().uploadError).toBeNull()
  })

  it('loadSignals кэширует уровень: повторный вызов не делает запрос', async () => {
    const fetchMock = mockApiFetch()
    useEdfRecording.getState().finishUpload(recordingFixture)

    await useEdfRecording.getState().loadSignals(1)
    const frame = useEdfRecording.getState().signalFrames[1]
    expect(frame?.sourceId).toBe(recordingFixture.recording_id)
    expect(frame?.channels).toEqual(recordingFixture.channels)
    expect(useEdfRecording.getState().signalsPending).toBe(0)
    expect(useEdfRecording.getState().signalsError).toBeNull()

    await useEdfRecording.getState().loadSignals(1)
    const signalsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/signals'),
    )
    expect(signalsCalls).toHaveLength(1)
    expect(String(signalsCalls[0][0])).toContain('level=1')
  })

  it('loadSignals без записи ничего не делает', async () => {
    const fetchMock = mockApiFetch()

    await useEdfRecording.getState().loadSignals(1)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useEdfRecording.getState().signalFrames).toEqual({})
  })

  it('loadSignals сохраняет ошибку сервера и снимает индикатор', async () => {
    mockApiFetch({ signalsFail: true })
    useEdfRecording.getState().finishUpload(recordingFixture)

    await useEdfRecording.getState().loadSignals(1)

    expect(useEdfRecording.getState().signalFrames).toEqual({})
    expect(useEdfRecording.getState().signalsError).toMatch(/не найдена/)
    expect(useEdfRecording.getState().signalsPending).toBe(0)
  })

  it('смена записи сбрасывает кэш кадров сигналов и ошибку', () => {
    useEdfRecording.setState({
      signalFrames: { 1: { level: 1 } as never },
      signalsError: 'старая ошибка',
    })

    useEdfRecording.getState().finishUpload(recordingFixture)

    expect(useEdfRecording.getState().signalFrames).toEqual({})
    expect(useEdfRecording.getState().signalsError).toBeNull()
  })
})

describe('стадии предподготовки (срез 2.7)', () => {
  it('buildPreprocessForm: параметры фильтра идут всегда, пороги — по стадии', () => {
    const params = { ...EDF_PARAM_DEFAULTS, visibleChannels: ['F3', 'C3'] }

    const artifacts = buildPreprocessForm('artifacts', params)
    expect(artifacts.get('stage')).toBe('artifacts')
    expect(artifacts.get('band_min')).toBe('1')
    expect(artifacts.get('band_max')).toBe('40')
    expect(artifacts.get('z_threshold')).toBe(String(params.zScoreThreshold))
    expect(artifacts.get('pp_threshold_uv')).toBe(String(params.peakToPeakUv))
    expect(artifacts.get('flat_line_uv')).toBe(String(params.flatLineUv))
    expect(artifacts.get('flat_line_ms')).toBe(String(params.flatLineMs))
    expect(artifacts.get('run_ica')).toBe('false')
    const withIca = buildPreprocessForm('artifacts', { ...params, runIca: true })
    expect(withIca.get('run_ica')).toBe('true')
    // Длина эпохи — параметр другой стадии, в артефактах её быть не должно
    expect(artifacts.get('epoch_length_ms')).toBeNull()

    // Нарезка пересчитывает детекцию для BAD_-пометок — пороги идут и сюда
    // (24.09.2026: без них стадия считала дефолтами — «199 зон» в ошибке нарезки
    // против 8 в пиулях легенды)
    const epochs = buildPreprocessForm('epochs', { ...params, epochLengthMs: 1000 })
    expect(epochs.get('epoch_length_ms')).toBe('1000')
    expect(epochs.get('z_threshold')).toBe(String(params.zScoreThreshold))
    expect(epochs.get('pp_threshold_uv')).toBe(String(params.peakToPeakUv))
    expect(epochs.get('flat_line_uv')).toBe(String(params.flatLineUv))
    expect(epochs.get('flat_line_ms')).toBe(String(params.flatLineMs))
    expect(epochs.get('run_ica')).toBe('false')
  })

  it('buildPreprocessForm: notch, референс по каналам и пресет «без фильтра»', () => {
    const custom = buildPreprocessForm('filter', {
      ...EDF_PARAM_DEFAULTS,
      filterPreset: 'custom',
      customBand: [0.5, 70],
      notchHz: 50,
      reference: 'custom',
      visibleChannels: ['F3', 'C3'],
    })
    expect(custom.get('band_min')).toBe('0.5')
    expect(custom.get('band_max')).toBe('70')
    expect(custom.get('notch_hz')).toBe('50')
    expect(custom.get('reference')).toBe('custom')
    expect(custom.get('reference_channels')).toBe('F3,C3')

    const none = buildPreprocessForm('filter', { ...EDF_PARAM_DEFAULTS, filterPreset: 'none' })
    expect(none.get('band_min')).toBeNull()
    expect(none.get('band_max')).toBeNull()
    expect(filterBandOf({ ...EDF_PARAM_DEFAULTS, filterPreset: 'none' })).toBeNull()
  })

  it('buildPreprocessForm: опции очистки (гармоники notch, bad-каналы, ICA/SSP)', () => {
    const form = buildPreprocessForm('filter', {
      ...EDF_PARAM_DEFAULTS,
      notchHz: 50,
      notchHarmonics: 3,
      badChannels: ' C3, T7 ',
      interpolateBads: true,
      cleanMethod: 'ica',
      icaNComponents: 8,
    })
    expect(form.get('notch_harmonics')).toBe('3')
    expect(form.get('bad_channels')).toBe('C3, T7')
    expect(form.get('interpolate_bads')).toBe('true')
    expect(form.get('clean_method')).toBe('ica')
    expect(form.get('ica_n_components')).toBe('8')

    // Пустой список bad-каналов в форму не уходит (сервер видит «не задано»)
    const plain = buildPreprocessForm('filter', EDF_PARAM_DEFAULTS)
    expect(plain.get('bad_channels')).toBeNull()
  })

  it('layersFromResult заменяет слот своей стадии, сохраняя слот другой', () => {
    const previous = {
      artifacts: [
        {
          id: 'flat_line-1',
          kind: 'flat_line' as const,
          onsetSec: 1,
          durationSec: 0.2,
          channels: [],
        },
      ],
      rejectedEpochs: [5],
      rejectChannels: { 5: ['F3'] },
      epochLengthMs: 500,
      source: 'result' as const,
    }

    const afterEpochs = layersFromResult(preprocessResultFixture('epochs'), previous)
    expect(afterEpochs.rejectedEpochs).toEqual([2, 7])
    // Каналы-виновники и порог едут с той же стадией — причины блокировки в UI
    expect(afterEpochs.rejectChannels).toEqual({ 2: ['F3', 'C3'], 7: [] })
    // Индексы отброшенных эпох имеют смысл только с длиной своей нарезки (срез 2.10)
    expect(afterEpochs.epochLengthMs).toBe(2000)
    expect(afterEpochs.artifacts).toEqual(previous.artifacts)

    const afterArtifacts = layersFromResult(preprocessResultFixture('artifacts'), afterEpochs)
    expect(afterArtifacts.rejectedEpochs).toEqual([2, 7])
    // Стадия артефактов не трогает нарезку эпох: длина и причины остаются прежними
    expect(afterArtifacts.epochLengthMs).toBe(2000)
    expect(afterArtifacts.rejectChannels).toEqual({ 2: ['F3', 'C3'], 7: [] })
    expect(afterArtifacts.artifacts.map((zone) => zone.kind)).toEqual([
      'zscore_outlier',
      'peak_to_peak',
    ])
    expect(afterArtifacts.artifacts[0].channels).toEqual(['F3', 'C3'])
  })

  it('layersFromResult не тащит демо-фикстуру в результат расчёта', () => {
    const demo = {
      artifacts: [
        {
          id: 'zscore_outlier-1',
          kind: 'zscore_outlier' as const,
          onsetSec: 1,
          durationSec: 1,
          channels: [],
        },
      ],
      rejectedEpochs: [1],
      rejectChannels: {},
      epochLengthMs: null,
      source: 'demo' as const,
    }

    const result = layersFromResult(preprocessResultFixture('artifacts'), demo)

    expect(result.source).toBe('result')
    expect(result.rejectedEpochs).toEqual([])
    // Фикстура не расчёт: её длина эпохи не переезжает в слой результата
    expect(result.epochLengthMs).toBeNull()
    expect(result.artifacts).toHaveLength(2)
  })
})

describe('запуск стадии по кнопке (срез 2.7)', () => {
  beforeEach(() => {
    useEdfRecording.setState({ recording: null, stageJobs: {}, layers: null })
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
  })

  afterEach(() => {
    // Отменяем подмену `api.job` из теста отмены поллинга
    vi.restoreAllMocks()
  })

  it('runStage: задача → слои результата + снимок параметров стадии', async () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture })

    await useEdfRecording.getState().runStage('artifacts')

    const state = useEdfRecording.getState()
    expect(state.stageJobs.artifacts?.status).toBe('succeeded')
    expect(state.layers?.source).toBe('result')
    expect(state.layers?.artifacts.map((zone) => zone.kind)).toEqual([
      'zscore_outlier',
      'peak_to_peak',
    ])
    const paramsState = useEdfParams.getState()
    expect(stageStateOf(paramsState.params, paramsState.stageApplied, 'artifacts')).toBe('ready')
    // Другие стадии результат не получили — они раздельные
    expect(paramsState.stageApplied.epochs).toBeNull()
  })

  it('runStage: стадия epochs заполняет штриховку, не трогая зоны', async () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture })

    await useEdfRecording.getState().runStage('artifacts')
    await useEdfRecording.getState().runStage('epochs')

    const layers = useEdfRecording.getState().layers
    expect(layers?.rejectedEpochs).toEqual([2, 7])
    expect(layers?.artifacts).toHaveLength(2)
  })

  it('runStage: снимок честный — правка параметров во время задачи даёт stale', async () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture })

    const pending = useEdfRecording.getState().runStage('artifacts')
    // Пользователь правит порог, пока задача выполняется
    useEdfParams.getState().setParams({ peakToPeakUv: 42 })
    await pending

    const { params, stageApplied } = useEdfParams.getState()
    expect(stageStateOf(params, stageApplied, 'artifacts')).toBe('stale')
  })

  it('runStage: ошибка стадии остаётся на кнопке понятным текстом', async () => {
    mockApiFetch({
      preprocessJob: {
        ...preprocessJobFixture,
        status: 'failed',
        error: 'Все эпохи отброшены reject-фильтром',
      },
    })
    useEdfRecording.setState({ recording: recordingFixture })

    await useEdfRecording.getState().runStage('epochs')

    const job = useEdfRecording.getState().stageJobs.epochs
    expect(job?.status).toBe('failed')
    expect(job?.error).toMatch(/Все эпохи отброшены/)
    // Провал не помечает стадию рассчитанной
    expect(useEdfParams.getState().stageApplied.epochs).toBeNull()
  })

  it('runStage: отказ сервера при запуске тоже показывается как ошибка стадии', async () => {
    mockApiFetch({ preprocessStartFails: true })
    useEdfRecording.setState({ recording: recordingFixture })

    await useEdfRecording.getState().runStage('filter')

    expect(useEdfRecording.getState().stageJobs.filter?.status).toBe('failed')
    expect(useEdfRecording.getState().stageJobs.filter?.error).toMatch(/не найдена/)
  })

  it('runStage без записи не делает запросов', async () => {
    const fetchMock = mockApiFetch()

    await useEdfRecording.getState().runStage('artifacts')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useEdfRecording.getState().stageJobs).toEqual({})
  })

  it('закрытие записи сбрасывает задачи стадий', async () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture })
    await useEdfRecording.getState().runStage('artifacts')

    useEdfRecording.getState().closeRecording()

    expect(useEdfRecording.getState().stageJobs).toEqual({})
  })

  it('закрытие записи отменяет поллинг: ответ прежней задачи не трогает состояние', async () => {
    // Стадия «висит» на опросе: её ответ приходит уже после закрытия записи
    const stale = deferred<JobStatus>()
    const jobSpy = vi.spyOn(api, 'job').mockImplementationOnce(() => stale.promise)
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture })

    const pending = useEdfRecording.getState().runStage('artifacts')
    await vi.waitFor(() => expect(jobSpy).toHaveBeenCalledTimes(1))
    useEdfRecording.getState().closeRecording()
    stale.resolve(preprocessJobFixture)
    await pending

    // Поллинг бросил отмену: прогресс прежней стадии не вернулся в состояние
    expect(useEdfRecording.getState().recording).toBeNull()
    expect(useEdfRecording.getState().stageJobs).toEqual({})
    expect(useEdfRecording.getState().layers).toBeNull()
  })
})

describe('событийный режим и ERP (N2/2.7)', () => {
  it('buildPreprocessForm: событийный режим шлёт событие и окно (только стадия epochs)', () => {
    const params = {
      ...EDF_PARAM_DEFAULTS,
      epochMode: 'events' as const,
      eventId: 'STIM/5',
      epochPreMs: 150,
      epochPostMs: 650,
    }
    const epochs = buildPreprocessForm('epochs', params)
    expect(epochs.get('epoch_mode')).toBe('events')
    expect(epochs.get('event_id')).toBe('STIM/5')
    expect(epochs.get('epoch_pre_ms')).toBe('150')
    expect(epochs.get('epoch_post_ms')).toBe('650')

    // Фиксированный режим событийных полей не шлёт
    const fixed = buildPreprocessForm('epochs', EDF_PARAM_DEFAULTS)
    expect(fixed.get('epoch_mode')).toBe('fixed')
    expect(fixed.get('event_id')).toBeNull()
  })

  it('buildEvokedForm: baseline −200…0 уходит только когда pre-окно его вмещает', () => {
    const params = {
      ...EDF_PARAM_DEFAULTS,
      epochMode: 'events' as const,
      eventId: 'STIM/5',
      epochPreMs: 200,
      epochPostMs: 800,
      erpBaseline: 'minus200' as const,
    }
    const form = buildEvokedForm(params)
    expect(form.get('event_id')).toBe('STIM/5')
    expect(form.get('epoch_pre_ms')).toBe('200')
    expect(form.get('baseline_start_ms')).toBe('-200')
    expect(form.get('baseline_end_ms')).toBe('0')

    // pre-окно 100 мс: baseline −200…0 в эпоху не влезает — и не отправляется
    const narrow = buildEvokedForm({ ...params, epochPreMs: 100 })
    expect(narrow.get('baseline_start_ms')).toBeNull()
    // «Без коррекции» — baseline не уходит
    const none = buildEvokedForm({ ...params, erpBaseline: 'none' })
    expect(none.get('baseline_start_ms')).toBeNull()
  })

  it('layersFromResult: событийная нарезка приносит нерегулярную сетку и событие', () => {
    const result = layersFromResult(
      preprocessResultFixture('epochs', {
        epoch_mode: 'events',
        event_id: 'STIM/5',
        epoch_pre_ms: 200,
        epoch_post_ms: 800,
        epoch_starts_sec: [0.8, 2.8],
      }),
      null,
    )

    expect(result.epochStartsSec).toEqual([0.8, 2.8])
    expect(result.eventId).toBe('STIM/5')
    expect(result.epochPreMs).toBe(200)
    expect(result.epochPostMs).toBe(800)
  })

  it('startEvoked: задача → усреднённая волна в блок ERP', async () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture })
    useEdfParams.getState().setParams({ epochMode: 'events', eventId: 'STIM/5' })

    await useEdfRecording.getState().startEvoked()

    const { evoked } = useEdfRecording.getState()
    expect(evoked.status).toBe('succeeded')
    expect(evoked.result?.event_id).toBe('STIM/5')
    expect(evoked.result?.n_used).toBe(2)
  })

  it('startEvoked: у каждого результата свои параметры (волна из фикстуры соответствует событию)', async () => {
    mockApiFetch({ evokedResult: evokedResultFixture({ event_id: 'Sound/On', n_total: 3, n_used: 1 }) })
    useEdfRecording.setState({ recording: recordingFixture })
    useEdfParams.getState().setParams({ epochMode: 'events', eventId: 'Sound/On' })

    await useEdfRecording.getState().startEvoked()

    const { evoked } = useEdfRecording.getState()
    expect(evoked.result?.event_id).toBe('Sound/On')
    expect(evoked.result?.n_used).toBe(1)
  })

  it('startEvoked без события не шлёт запрос', async () => {
    const fetchMock = mockApiFetch()
    // Состояние задачи живёт при записи: на «чистой» записи оно — idle
    useEdfRecording.setState({
      recording: recordingFixture,
      evoked: {
        status: 'idle', progress: 0, message: '',
        error: null, errorTraceback: null, result: null,
      },
    })
    useEdfParams.getState().setParams({ epochMode: 'fixed' })

    await useEdfRecording.getState().startEvoked()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useEdfRecording.getState().evoked.status).toBe('idle')
  })

  it('reconcileEventId: событие живёт только внутри своей записи', () => {
    const counts = recordingFixture.event_counts
    // Событие прежней записи есть и в новой — выбор остаётся
    expect(reconcileEventId('Sound/On', counts)).toEqual({ eventId: 'Sound/On' })
    // Описания из прежней записи в новой нет — берём первое событие новой
    expect(reconcileEventId('Нет/Такого', counts)).toEqual({ eventId: 'STIM/5' })
    // Запись без событий чистит выбор: кнопка стадии честно блокируется
    expect(reconcileEventId('STIM/5', {})).toEqual({ eventId: '' })
  })
})
