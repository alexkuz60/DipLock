/**
 * Тесты раздела «Нейромузыка»: подсказка без записи, кнопка «Создать аудио»
 * в тулс-хедере → поллинг → прогресс → трекер-плеер (волна-бабочка,
 * линейка, позиционер), транспорт Play/Pause и Stop в хедере раздела,
 * зум/скорость/источник, файлы «Скачать…» в сайдбаре, параметры рендера
 * в панели (правка не запускает расчёт) и 3D-режим (spatial-audio).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import * as neuromusicPlayerLib from '@/shared/lib/neuromusicPlayer'
import { useEdfRecording } from '@/shared/state/edfRecording'
import {
  DEFAULT_BOOST_DB,
  DEFAULT_LOUDNESS_PHON,
  DEFAULT_OCTAVE_SHIFT,
  DEFAULT_SPATIAL_IR,
  DEFAULT_SPATIAL_SPREAD_PCT,
  DEFAULT_SPATIAL_WET_PCT,
  DEFAULT_SPATIAL_WIDTH_PCT,
  useNeuromusic,
} from '@/shared/state/neuromusic'
import {
  DEFAULT_PLAYER_RATE,
  DEFAULT_PLAYER_ZOOM,
  useNeuromusicPlayer,
} from '@/shared/state/neuromusicPlayer'
import { NeuromusicPanel } from './NeuromusicPanel'
import { NeuromusicSection } from './NeuromusicSection'
import { NeuromusicToolActions } from './NeuromusicToolActions'

/**
 * Мок Tone-движка: jsdom без Web Audio — проверяем интеграцию (кто вызван,
 * какие URL), а не звук. Реальный модуль не импортируется.
 */
vi.mock('@/shared/lib/neuromusicPlayer', () => {
  const player = {
    duration: 4,
    position: 0,
    playing: false,
    currentSource: 'master',
    bufferFor: vi.fn(() => null),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn(),
    setRate: vi.fn().mockResolvedValue(undefined),
    setSource: vi.fn().mockResolvedValue(undefined),
    setSpatial: vi.fn().mockResolvedValue(undefined),
    setWidth: vi.fn(),
    setSpread: vi.fn(),
    setWet: vi.fn(),
    setIrUrl: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  }
  return {
    NeuromusicPlayer: Object.assign(vi.fn().mockResolvedValue(player), {
      load: vi.fn().mockResolvedValue(player),
      __player: player,
    }),
  }
})

/** Инстанс мока плеера: функции-заглушки + числовые/строковые поля состояния. */
type MockPlayer = {
  [key: string]: ReturnType<typeof vi.fn> | number | boolean | string
}

/** Мок плеера: `NeuromusicPlayer.load` и созданный инстанс. */
const loadMock = neuromusicPlayerLib.NeuromusicPlayer as unknown as {
  load: ReturnType<typeof vi.fn>
  __player: MockPlayer
}
const playerMock = loadMock.__player as {
  bufferFor: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  seek: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  setRate: ReturnType<typeof vi.fn>
  setSource: ReturnType<typeof vi.fn>
  setSpatial: ReturnType<typeof vi.fn>
  setWidth: ReturnType<typeof vi.fn>
  setSpread: ReturnType<typeof vi.fn>
  setWet: ReturnType<typeof vi.fn>
  setIrUrl: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  duration: number
  position: number
  playing: boolean
  currentSource: string
}

const TRACKS = ['delta', 'delta_theta', 'theta', 'alpha', 'beta', 'gamma', 'high_gamma']

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Мок рендера: POST 202, статус — running → succeeded, файлы — заглушки. */
function audioFetchMock() {
  let statusCalls = 0
  const postBodies: string[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') postBodies.push(String(init.body ?? ''))
    if (url.includes('/audio/render') && url.includes('/status')) {
      statusCalls += 1
      if (statusCalls === 1) {
        return jsonResponse({
          render_id: 'r-1',
          status: 'running',
          stage: 'Трек alpha (4/7)',
          pct: 0.5,
          message: 'Ядро ×128: hilbert → ресемпл ×96 → 7 октав (alpha)',
          error: null,
          tracks: [],
        })
      }
      return jsonResponse({
        render_id: 'r-1',
        status: 'succeeded',
        stage: 'Готово',
        pct: 1,
        message: '7 треков + мастер, 4.0 с записи, 1.1 с рендера',
        error: null,
        tracks: TRACKS,
      })
    }
    if (url.includes('/audio/render')) {
      return jsonResponse({ render_id: 'r-1', status: 'running' }, 202)
    }
    if (url.endsWith('/audio/ir')) {
      // Каталог IR-пресетов (spatial-audio): реальный контракт, но без генерации.
      return jsonResponse({
        presets: [
          { id: 'room_small', label: 'Комната малая', description: 'тест', tags: ['комната'] },
          { id: 'room_large', label: 'Комната большая', description: 'тест', tags: ['комната'] },
        ],
      })
    }
    if (url.endsWith('.wav')) {
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })
    }
    if (url.endsWith('.json')) {
      return jsonResponse({ schema_version: 1 })
    }
    return jsonResponse({ detail: `неизвестный путь в моке: ${url}` }, 404)
  })
  return Object.assign(fn, { postBodies })
}

/** Фейковый 2D-контекст: jsdom без пакета canvas, draw-функции получают объект
 * (счётчик `stroke` — сигнал «волна/линейка перерисованы» в тестах). */
function fakeCanvasCtx() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    closePath: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    setTransform: vi.fn(),
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textBaseline: '',
    textAlign: '',
  }
}

/** Похожий на AudioBuffer объект: пики «бабочки» читают оба канала. */
function fakeAudioBuffer() {
  const left = new Float32Array(960)
  const right = new Float32Array(960)
  for (let i = 0; i < left.length; i++) {
    left[i] = Math.sin(i / 7) * 0.5
    right[i] = -Math.sin(i / 5) * 0.4
  }
  return {
    numberOfChannels: 2,
    length: left.length,
    getChannelData: (index: number) => (index === 0 ? left : right),
  }
}

/**
 * Раздел целиком, как в каркасе: кнопка тулс-хедера + рабочая область +
 * панель опций (без AppShell — панель вне RightPanel неаккордеонная).
 */
function renderNeuromusic() {
  return renderWithProviders(
    <>
      <NeuromusicToolActions />
      <NeuromusicSection />
      <NeuromusicPanel />
    </>,
  )
}

describe('Нейромузыка — раздел', () => {
  /** Общий контекст для всех canvas трекера одного теста. */
  let canvasCtx: ReturnType<typeof fakeCanvasCtx>

  beforeEach(() => {
    // Сторы общие для всех компонентов раздела и живут между тестами:
    // параметры и результат каждого теста сбрасываются явно. reset() первым —
    // он отменяет токен поллинга: висящий промис прошлого теста иначе может
    // перезаписать status уже нового (паттерн renderToken).
    useNeuromusic.getState().reset()
    useNeuromusicPlayer.getState().reset()
    // Вид-настройки (зум/скорость) reset намеренно не трогает — для тестов
    // возвращаем дефолты, иначе ×100 предыдущего теста меняет окно seek.
    useNeuromusicPlayer.setState({
      zoom: DEFAULT_PLAYER_ZOOM,
      rate: DEFAULT_PLAYER_RATE,
    })
    useNeuromusic.setState({
      boostDb: DEFAULT_BOOST_DB,
      loudness: true,
      loudnessPhon: DEFAULT_LOUDNESS_PHON,
      autobase: true,
      octaveShift: DEFAULT_OCTAVE_SHIFT,
      spatialEnabled: false,
      spatialWidthPct: DEFAULT_SPATIAL_WIDTH_PCT,
      spatialSpreadPct: DEFAULT_SPATIAL_SPREAD_PCT,
      spatialWetPct: DEFAULT_SPATIAL_WET_PCT,
      spatialIr: DEFAULT_SPATIAL_IR,
      renderId: null,
      renderRecordingId: null,
      status: null,
      busy: false,
      error: null,
    })
    // jsdom без пакета canvas: getContext бросает — рисуем в фейковый контекст
    // (математика отрисовки покрыта в waveformView.test.ts; здесь по счётчику
    // штрихов проверяется перерисовка волны/линейки).
    canvasCtx = fakeCanvasCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      canvasCtx as unknown as CanvasRenderingContext2D,
    )
    // Моки Tone-движка: restoreAllMocks в vitest.setup.ts сбрасывает
    // implementation всех vi.fn() после каждого теста — перепривязываем
    // resolved-значения и чистим вызовы.
    loadMock.load.mockResolvedValue(playerMock)
    for (const value of Object.values(playerMock)) {
      if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
    }
    playerMock.bufferFor.mockReturnValue(fakeAudioBuffer())
    playerMock.play.mockResolvedValue(undefined)
    playerMock.seek.mockResolvedValue(undefined)
    playerMock.setSource.mockResolvedValue(undefined)
    playerMock.setRate.mockResolvedValue(undefined)
    playerMock.setSpatial.mockResolvedValue(undefined)
    playerMock.setIrUrl.mockResolvedValue(undefined)
    playerMock.playing = false
    playerMock.position = 0
    playerMock.currentSource = 'master'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Дожидается succeeded-рендера: кнопка → поллинг → трекер и готовый движок. */
  async function renderSucceeded(fetchMock: ReturnType<typeof audioFetchMock>) {
    renderNeuromusic()
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('neuromusic-tracker')).toBeInTheDocument(), {
      timeout: 3000,
    })
    await waitFor(() => expect(screen.getByTestId('transport-play')).toBeEnabled())
  }

  it('без открытой записи — честная подсказка открыть EDF', () => {
    useEdfRecording.setState({ recording: null })
    renderNeuromusic()
    expect(screen.getByText(/Откройте ЭЭГ-запись/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    // Кнопка в хедере есть, но выключена без записи (с объяснением в тултипе)
    expect(screen.getByRole('button', { name: 'Создать аудио' })).toBeDisabled()
  })

  it('кнопка → прогресс с шагом пайплайна → трекер и файлы в сайдбаре', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    vi.stubGlobal('fetch', audioFetchMock())

    renderNeuromusic()
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))

    // Прогресс-бар с процентами и подписью шага (ТЗ M5).
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument())
    expect(screen.getByText('Трек alpha (4/7)')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')

    // После успеха: трекер на месте, старого <audio> больше нет.
    await waitFor(
      () => expect(screen.getByTestId('neuromusic-tracker')).toBeInTheDocument(),
      { timeout: 3000 },
    )
    expect(document.querySelector('audio')).toBeNull()

    // Движок: мастер + семь треков в порядке партитуры, обычный режим.
    const options = loadMock.load.mock.calls[0][0] as {
      masterUrl: string
      tracks: { key: string; url: string }[]
      irUrl: string
      source: string
      rate: number
      spatial: boolean
    }
    expect(options.masterUrl).toContain('/master.wav')
    expect(options.tracks).toHaveLength(7)
    expect(options.tracks[0]).toEqual({
      key: 'delta',
      url: expect.stringContaining('/track/delta.wav'),
    })
    expect(options).toMatchObject({ source: 'master', rate: 1, spatial: false })

    // Файлы скачивания — секция «Файлы» правого сайдбара, не рабочая область.
    expect(screen.getByRole('link', { name: 'Скачать мастер' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Скачать партитуру (.json)' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Скачать .wav' })).toHaveLength(7)

    // Источник трекера: микс до эффектов + семь полос (движок готов — не disabled).
    await waitFor(() => expect(screen.getByLabelText('Сигнал')).not.toBeDisabled())
    expect(screen.getByRole('option', { name: 'Микс (до эффектов)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'α — альфа' })).toBeInTheDocument()
  })

  it('усиление полос уходит в запрос рендера (дефолт +6, правка — 10)', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderNeuromusic()

    // Контрол параметра — в панели опций: диапазон 0…12, дефолт +6 (приёмка 05.10).
    const field = screen.getByLabelText(/Усиление полос/)
    expect(field).toHaveValue(6)

    // Правка параметра НЕ запускает расчёт (правило UI) — только кнопка.
    fireEvent.change(field, { target: { value: '10' } })
    expect(fetchMock.postBodies).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    const body = JSON.parse(fetchMock.postBodies[0]) as Record<string, unknown>
    // Дефолт компенсации ISO 226: включена на 75 фон, автобаза «ямы» (приёмка).
    expect(body).toMatchObject({
      recording_id: recordingFixture.recording_id,
      boost_db: 10,
      loudness_phon: 75,
      loudness_autobase: true,
    })
  })

  it('режим базы переключается: «Максимум (boost)» уходит в запрос как false', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderNeuromusic()
    fireEvent.click(screen.getByRole('button', { name: 'Максимум (boost)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))

    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    const body = JSON.parse(fetchMock.postBodies[0]) as Record<string, unknown>
    expect(body).toMatchObject({ loudness_autobase: false, loudness_phon: 75 })
    // Другие режимы не пострадали (правка параметра не запускает расчёт).
    expect(screen.getByLabelText(/Усиление полос/)).toHaveValue(6)
  })

  it('транспонирование 5 октав уходит в запрос (×32), правка не запускает расчёт', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderNeuromusic()

    // Дефолт — 7 октав (×128, как до появления выбора): сегмент выбран.
    expect(screen.getByRole('button', { name: '7 октав' })).toBeInTheDocument()

    // Выбор в панели опций не запускает рендер (правило UI).
    fireEvent.click(screen.getByRole('button', { name: '5 октав' }))
    expect(fetchMock.postBodies).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    expect(JSON.parse(fetchMock.postBodies[0])).toMatchObject({ octave_shift: 5 })
  })

  it('компенсация ISO 226 выключается чекбоксом, уровень правится полем', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderNeuromusic()

    // Уровень прослушивания виден только при включённой компенсации.
    expect(screen.getByLabelText(/Уровень прослушивания/)).toHaveValue(75)
    fireEvent.change(screen.getByLabelText(/Уровень прослушивания/), {
      target: { value: '80' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    expect(JSON.parse(fetchMock.postBodies[0])).toMatchObject({ loudness_phon: 80 })

    // Выключили чекбокс → в запрос уходит null (сервер считает без поправок).
    // Ждём завершения первого рендера (кнопка снова активна).
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Создать аудио' })).toBeEnabled(),
      { timeout: 3000 },
    )
    fireEvent.click(screen.getByLabelText('Перцептуальный баланс (ISO 226)'))
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(2))
    expect(JSON.parse(fetchMock.postBodies[1])).toMatchObject({ loudness_phon: null })
  })

  it('транспорт в хедере: play/pause и stop управляют движком', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    // Play: кнопка в хедере раздела, label меняется на «Пауза».
    fireEvent.click(screen.getByTestId('transport-play'))
    await waitFor(() => expect(playerMock.play).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('transport-play')).toHaveAttribute('aria-label', 'Пауза'),
    )

    // Pause: движок на паузу, кнопка возвращается к «Слушать».
    fireEvent.click(screen.getByTestId('transport-play'))
    await waitFor(() => expect(playerMock.pause).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('transport-play')).toHaveAttribute('aria-label', 'Слушать'),
    )

    // Stop: отдельная кнопка хедера.
    fireEvent.click(screen.getByTestId('transport-stop'))
    await waitFor(() => expect(playerMock.stop).toHaveBeenCalledTimes(1))
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('зум ×100 — чистый вид, скорость ×0.5 и источник — движок, без POST', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    // Зум: сегмент «×100» в группе «Зум» — настройка вида, сеть не нужна.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Зум' })).getByRole('button', { name: '×100' }),
    )
    expect(useNeuromusicPlayer.getState().zoom).toBe(100)

    // Скорость: ×0.5 (слуховой контроль) уходит в движок.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Скорость' })).getByRole('button', { name: '×0.5' }),
    )
    await waitFor(() => expect(playerMock.setRate).toHaveBeenCalledWith(0.5))
    expect(useNeuromusicPlayer.getState().rate).toBe(0.5)

    // Источник: выбор полосы — соло/подмена буфера в движке.
    fireEvent.change(screen.getByLabelText('Сигнал'), { target: { value: 'alpha' } })
    await waitFor(() => expect(playerMock.setSource).toHaveBeenCalledWith('alpha'))

    // Ни одна настройка плеера не запускает рендер (правило UI).
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('ошибка смены источника — текст для пользователя и откат к мастеру', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    playerMock.setSource.mockRejectedValueOnce(new Error('нет файла alpha'))
    fireEvent.change(screen.getByLabelText('Сигнал'), { target: { value: 'alpha' } })

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Плеер: нет файла alpha'),
    )
    // Источник откатился к тому, что реально играет.
    expect(useNeuromusicPlayer.getState().source).toBe('master')
    // Селект снова доступен (загрузка завершилась).
    await waitFor(() => expect(screen.getByLabelText('Сигнал')).not.toBeDisabled())
  })

  it('клик по волне перематывает: точка → время окна', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    // Ширина области в тестах — 1024 px (заглушка ResizeObserver), длительность
    // мока 4 с, ×1 — весь файл: клик по центру = 2 с. jsdom без PointerEvent —
    // шлём нативный MouseEvent с типом pointerdown (в нём есть clientX).
    fireEvent(
      screen.getByTestId('tracker-surface'),
      new MouseEvent('pointerdown', { bubbles: true, clientX: 512 }),
    )
    await waitFor(() => expect(playerMock.seek).toHaveBeenCalledWith(2))
  })

  it('смена источника перерисовывает волну без смены зума (dirty-флаг)', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)
    await waitFor(() => expect(screen.getByLabelText('Сигнал')).not.toBeDisabled())

    // Покой: волна нарисована, rAF без изменений штрихов не добавляет.
    const before = canvasCtx.stroke.mock.calls.length
    expect(before).toBeGreaterThan(0)

    fireEvent.change(screen.getByLabelText('Сигнал'), { target: { value: 'alpha' } })
    // Пики пересчитаны → paint дорисовал волну; окно и зум не менялись.
    await waitFor(() => expect(canvasCtx.stroke.mock.calls.length).toBeGreaterThan(before))
    expect(useNeuromusicPlayer.getState().zoom).toBe(1)
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('слайдер прокрутки: ×1 — выключен, при зуме прокручивает окно без seek', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const slider = screen.getByLabelText('Прокрутка окна по времени')
    // Весь файл — прокрутить некуда, слайдер выключен.
    expect(slider).toBeDisabled()

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Зум' })).getByRole('button', { name: '×100' }),
    )
    await waitFor(() => expect(slider).not.toBeDisabled())

    // После зума перерисовка окна уже синхронна (эффекты в act) — замеряем.
    const before = canvasCtx.stroke.mock.calls.length
    fireEvent.change(slider, { target: { value: '1.7' } })
    // Окно сдвинулось (линейка и волна перерисованы) — и это НЕ перемотка.
    await waitFor(() => expect(canvasCtx.stroke.mock.calls.length).toBeGreaterThan(before))
    expect(slider).toHaveValue('1.7')
    expect(playerMock.seek).not.toHaveBeenCalled()
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('3D-режим: включение перестраивает граф, источник действует и в сцене', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    // Обычный режим: setSpatial не звали; селект источника на месте.
    expect(playerMock.setSpatial).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Сигнал')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() => expect(playerMock.setSpatial).toHaveBeenCalledWith(true))
    // «Микс» = вся сцена из семи треков, полоса = соло — контрол остаётся живым.
    await waitFor(() => expect(screen.getByLabelText('Сигнал')).not.toBeDisabled())
    // Ни одного нового POST: spatial — чисто клиентские правки (spatial-audio).
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('правка spatial-параметров применяется к живому графу без запросов', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)
    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() => expect(playerMock.setSpatial).toHaveBeenCalledWith(true))

    // Ширина/разброс/влажность — real-time вызовы в мок-плеер, без сети.
    fireEvent.change(screen.getByLabelText(/Ширина базы/), { target: { value: '140' } })
    await waitFor(() => expect(playerMock.setWidth).toHaveBeenCalledWith(140))
    fireEvent.change(screen.getByLabelText(/Разброс по дуге/), { target: { value: '40' } })
    await waitFor(() => expect(playerMock.setSpread).toHaveBeenCalledWith(40))
    fireEvent.change(screen.getByLabelText(/Влажность реверберации/), { target: { value: '60' } })
    await waitFor(() => expect(playerMock.setWet).toHaveBeenCalledWith(60))

    // Смена помещения — GET готового IR-ассета (не расчёт) и подмена буфера.
    const irSelect = screen.getByLabelText('Помещение (IR)')
    await waitFor(() => expect(irSelect).not.toBeDisabled())
    fireEvent.change(irSelect, { target: { value: 'room_large' } })
    await waitFor(() =>
      expect(playerMock.setIrUrl).toHaveBeenCalledWith(
        expect.stringContaining('/audio/ir/room_large.wav'),
      ),
    )

    // Правка параметров не запускает рендера (правило UI) — POST по-прежнему один.
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('выключение 3D-режима перестраивает граф без разборки движка', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() => expect(playerMock.setSpatial).toHaveBeenCalledWith(true))
    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() => expect(playerMock.setSpatial).toHaveBeenCalledWith(false))

    // Движок жив (dispose — только при размонтировании трекера), соло-списка
    // семи кнопок больше нигде нет — заменил селект «Сигнал».
    expect(playerMock.dispose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Сигнал')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Мастер — партитура целиком' })).toBeNull()
  })
})
