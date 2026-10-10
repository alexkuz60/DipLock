/**
 * Тесты раздела «Нейромузыка»: подсказка без записи, кнопка «Создать аудио»
 * в тулс-хедере → поллинг → прогресс → трекер-плеер (волна-бабочка,
 * линейка, позиционер), транспорт Play/Pause и Stop в хедере раздела,
 * зум/скорость/источник, файлы «Скачать…» в сайдбаре, параметры рендера
 * в панели (правка не запускает расчёт), 3D-режим (spatial-audio) и секция
 * «Визуализация» под плеером (силуэт головы из «Опций» + радиальный график).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import * as neuromusicPlayerLib from '@/shared/lib/neuromusicPlayer'
import type { AudioEmo } from '@/shared/api/types'
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
import {
  NeuromusicTitleFile,
  NeuromusicTitleIcon,
  NeuromusicToolActions,
} from './NeuromusicToolActions'

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

/** Кадры «Эмо» для мока (реальный контракт GET …/emo): 6 слайдов записи 4 с,
 * сетка 32000/48000; лучи слайда k = (i+1)·10 + k·10, максимум 100 % R
 * (шкала — dB_relative, порог −60 дБ, schema_version 2). */
const EMO_PAYLOAD: AudioEmo = {
  schema_version: 2,
  fs_audio: 48000,
  fft_size: 32768,
  hop_samples: 32000,
  overlap_samples: 768,
  normalization: 'db_relative',
  db_floor: -60,
  global_max: 4812.5,
  duration_s: 4,
  frame_count: 6,
  frames: Array.from({ length: 6 }, (_, index) => ({
    t_sec: (index * 32000) / 48000,
    rays: Array.from({ length: 7 }, (_, ray) =>
      Math.min(100, (ray + 1) * 10 + index * 10),
    ),
  })),
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Параметры мока рендера: вариант/ряды статуса, cached ответа POST. */
type AudioFetchOptions = {
  variant?: 'express' | 'montage'
  rows?: string[]
  cached?: boolean
  /** Кадры «Эмо»: null — 404 (фоллбэк графика), иначе payload (дефолт — свой). */
  emo?: AudioEmo | null
}

/** Мок рендера: POST 202, статус — running → succeeded, файлы — заглушки.
 * `tracks` — порядок полос из `status.tracks` (по умолчанию — порядок
 * партитуры; для проверки сортировки комбо отдаётся перемешанный).
 * `opts.cached` — попадание в дисковый кэш (поле ответа POST); bake-эндпоинты
 * отвечают по своему контракту (spatial-audio, п.3). */
function audioFetchMock(tracks: string[] = TRACKS, opts: AudioFetchOptions = {}) {
  const variant = opts.variant ?? 'express'
  const rows = opts.rows ?? []
  let statusCalls = 0
  let bakeStatusCalls = 0
  const postBodies: string[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') postBodies.push(String(init.body ?? ''))
    // 3D-bake — раньше общей ветки `/audio/render`: его URL содержит и её,
    // и «/status» (иначе bake-status ушёл бы в поллинг рендера).
    if (url.includes('/bake')) {
      if (url.endsWith('/status')) {
        bakeStatusCalls += 1
        if (bakeStatusCalls === 1) {
          return jsonResponse({
            bake_id: 'b-1',
            render_id: 'r-1',
            status: 'running',
            stage: 'Панорама: стем 3/28',
            pct: 0.4,
            message: '',
            error: null,
            bytes_total: 0,
          })
        }
        return jsonResponse({
          bake_id: 'b-1',
          render_id: 'r-1',
          status: 'succeeded',
          stage: 'Готово',
          pct: 1,
          message: '3D-bake 120 КБ, montage, 7 полос, 90 мс',
          error: null,
          bytes_total: 122880,
        })
      }
      return jsonResponse({ bake_id: 'b-1', status: 'running', cached: false }, 202)
    }
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
          variant: 'express',
          rows: [],
        })
      }
      return jsonResponse({
        render_id: 'r-1',
        status: 'succeeded',
        stage: 'Готово',
        pct: 1,
        message: '7 треков + мастер, 4.0 с записи, 1.1 с рендера',
        error: null,
        tracks,
        variant,
        rows,
      })
    }
    if (url.includes('/emo')) {
      // Кадры радара «Эмо»: контракт GET …/emo; opts.emo === null → 404.
      if (opts.emo === null) return jsonResponse({ detail: 'нет кадров' }, 404)
      return jsonResponse(opts.emo ?? EMO_PAYLOAD)
    }
    if (url.includes('/audio/render')) {
      return jsonResponse(
        { render_id: 'r-1', status: 'running', cached: opts.cached ?? false },
        202,
      )
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

/** Расстояния вершин полигона от центра (100/100) — длины лучей в px viewBox. */
function polygonDistances(chart: HTMLElement): number[] {
  const points =
    chart.querySelector('[data-part="polygon"]')?.getAttribute('points') ?? ''
  if (!points.trim()) return []
  return points.trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(',').map(Number)
    return Math.hypot(x - 100, y - 100)
  })
}

/**
 * Раздел целиком, как в каркасе: тулс-хедер (иконка ноты + имя файла +
 * кнопка/контролы) + рабочая область + панель опций (без AppShell — панель
 * вне RightPanel неаккордеонная).
 */
function renderNeuromusic() {
  return renderWithProviders(
    <>
      <NeuromusicTitleIcon />
      <NeuromusicTitleFile />
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
      variant: 'express',
      spatialEnabled: false,
      spatialWidthPct: DEFAULT_SPATIAL_WIDTH_PCT,
      spatialSpreadPct: DEFAULT_SPATIAL_SPREAD_PCT,
      spatialWetPct: DEFAULT_SPATIAL_WET_PCT,
      spatialIr: DEFAULT_SPATIAL_IR,
      renderId: null,
      renderRecordingId: null,
      status: null,
      busy: false,
      cached: false,
      error: null,
      bakeId: null,
      bakeStatus: null,
      bakeBusy: false,
      bakeError: null,
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

  it('хедер: имя ЭЭГ-файла после названия, контролы — после кнопки и вне трекера', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    // Имя файла — в строке шапки (иконка/имя/контролы переехали в тулс-хедер,
    // правка 10.10.2026), отдельного хедера в рабочей области больше нет.
    expect(screen.getByTestId('neuromusic-title-file')).toHaveTextContent(
      recordingFixture.filename,
    )
    expect(screen.queryByText(/Эксперимент: запись/)).toBeNull()

    // Слово «Сигнал» из строки убрано (экономия места) — у комбо остался aria-label.
    expect(screen.queryByText('Сигнал')).toBeNull()
    const select = screen.getByLabelText('Сигнал')
    const create = screen.getByRole('button', { name: 'Создать аудио' })
    // Контролы (источник/зум/скорость/таймкод) — после кнопки «Создать аудио».
    expect(create.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // Контролы — вне трекера, слева от Play/Stop.
    expect(within(screen.getByTestId('neuromusic-tracker')).queryByLabelText('Сигнал')).toBeNull()
    const play = screen.getByTestId('transport-play')
    expect(select.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Скорость' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('tracker-time')).toHaveTextContent('0:00 / 0:04'))
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
    // Подпись видимого отрезка живёт в тултипе слайдера (сам ряд — во всю
    // ширину плеера): на ×1 это весь файл 0:00 – 0:04.
    await waitFor(() => expect(slider.getAttribute('title')).toContain('отрезок 0:00 – 0:04'))

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Зум' })).getByRole('button', { name: '×100' }),
    )
    await waitFor(() => expect(slider).not.toBeDisabled())
    // С зумом в тултипе меняется и подсказка, и отрезок (окно уже файла).
    await waitFor(() =>
      expect(slider.getAttribute('title')).toContain(
        'Прокрутка окна вдоль записи: пока позиционер в окне',
      ),
    )
    expect(slider.getAttribute('title')).toContain('отрезок')

    // После зума перерисовка окна уже синхронна (эффекты в act) — замеряем.
    const before = canvasCtx.stroke.mock.calls.length
    fireEvent.change(slider, { target: { value: '1.7' } })
    // Окно сдвинулось (линейка и волна перерисованы) — и это НЕ перемотка.
    await waitFor(() => expect(canvasCtx.stroke.mock.calls.length).toBeGreaterThan(before))
    expect(slider).toHaveValue('1.7')
    expect(playerMock.seek).not.toHaveBeenCalled()
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('комбо «Сигнал»: полосы отсортированы по возрастанию частоты', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    // `status.tracks` в произвольном порядке — комбо обязано отдать δ → … → γ-high.
    const shuffled = ['gamma', 'delta', 'high_gamma', 'alpha', 'theta', 'beta', 'delta_theta']
    const fetchMock = audioFetchMock(shuffled)
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)
    await waitFor(() => expect(screen.getByLabelText('Сигнал')).not.toBeDisabled())

    const options = within(screen.getByLabelText('Сигнал')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Микс (до эффектов)',
      'δ — дельта',
      'δ/θ — дельта-тета',
      'θ — тета',
      'α — альфа',
      'β — бета',
      'γ — гамма',
      'γ-high — высокая гамма',
    ])
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

  it('вариант «Монтаж» уходит в запрос рендера, правка не запускает расчёт', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderNeuromusic()
    // Переключатель в «Опциях»: дефолт — Экспресс, выбор — без запросов.
    expect(screen.getByRole('button', { name: 'Экспресс' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Монтаж' }))
    expect(fetchMock.postBodies).toHaveLength(0)
    expect(useNeuromusic.getState().variant).toBe('montage')

    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    expect(JSON.parse(fetchMock.postBodies[0])).toMatchObject({ variant: 'montage' })
  })

  it('«Монтаж»: файлы по рядам, движок получает рядовые треки, силуэт — модули', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock(TRACKS, {
      variant: 'montage',
      rows: ['frontal', 'temporal'],
    })
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)
    await waitFor(() => expect(screen.getByLabelText('Сигнал')).not.toBeDisabled())

    // Файлы сгруппированы по рядам: 2 ряда × 7 полос = 14 рядовых ссылок.
    const files = screen.getByTestId('montage-files')
    expect(within(files).getByText('Лобной')).toBeInTheDocument()
    expect(within(files).getByText('Височной')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Скачать .wav' })).toHaveLength(14)
    expect(within(files).getAllByRole('link', { name: 'Скачать .wav' })[0]).toHaveAttribute(
      'href',
      expect.stringContaining('/track/frontal/'),
    )

    // Движок: 14 стемов row-major, каждый несёт ряд модуля.
    const options = loadMock.load.mock.calls.at(-1)?.[0] as {
      tracks: { key: string; url: string; row?: string }[]
    }
    expect(options.tracks).toHaveLength(14)
    expect(options.tracks[0]).toMatchObject({
      key: 'delta',
      row: 'frontal',
      url: expect.stringContaining('/track/frontal/delta.wav'),
    })
    expect(options.tracks[7]).toMatchObject({ key: 'delta', row: 'temporal' })

    // Силуэт BrainRoom: точки по геометрии рядов, а текста под силуэтом
    // больше нет (легенда убрана — экономия места, правка 10.10.2026).
    expect(screen.getByTestId('brainroom-view')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('модули рядов'),
    )
    expect(screen.queryByTestId('brainroom-legend')).not.toBeInTheDocument()
    expect(screen.queryByText('Дуга ±60° перед слушателем')).not.toBeInTheDocument()
    expect(screen.queryByText('вид сверху, стены 1.0 : 1.3')).not.toBeInTheDocument()
  })

  it('cached из ответа POST — пилюля «Готово (из кэша)»', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock(TRACKS, { cached: true })
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    await waitFor(() => expect(screen.getByText('Готово (из кэша)')).toBeInTheDocument())
    // Силуэт «Экспресса» без рядов — подпись дуги в aria-label.
    expect(screen.getByTestId('brainroom-view')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('дуга ±60°'),
    )
  })

  it('3D-bake: кнопка → POST параметров цепочки → прогресс → ссылка на WAV', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)
    const startButton = await screen.findByTestId('bake-start')
    expect(fetchMock.postBodies).toHaveLength(1) // только рендер

    fireEvent.click(startButton)
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(2))
    // Тело — параметры «Пространства» в контракте backend (width/spread/wet/ir).
    expect(JSON.parse(fetchMock.postBodies[1])).toMatchObject({
      width_pct: DEFAULT_SPATIAL_WIDTH_PCT,
      spread_pct: DEFAULT_SPATIAL_SPREAD_PCT,
      wet_pct: DEFAULT_SPATIAL_WET_PCT,
      ir: DEFAULT_SPATIAL_IR,
    })

    // Прогресс запекания своим progressbar (aria-label), затем ссылка на файл.
    await waitFor(() => expect(screen.getByLabelText('Прогресс запекания')).toBeInTheDocument())
    await waitFor(
      () =>
        expect(screen.getByTestId('bake-download')).toHaveAttribute(
          'href',
          expect.stringContaining('/audio/render/r-1/bake/b-1.wav'),
        ),
      { timeout: 3000 },
    )
    // Лишних POST нет: bake — отдельный цикл, рендер не перезапускался.
    expect(fetchMock.postBodies).toHaveLength(2)
  })

  it('до рендера: секции «Визуализация» и силуэта в «Опциях» нет', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    renderNeuromusic()
    // Силуэт переехал из панели в рабочую область (07.10.2026), а секция
    // видна только вместе с плеером — до рендера нет ни её, ни графика.
    expect(screen.queryByRole('region', { name: 'Визуализация' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('brainroom-view')).not.toBeInTheDocument()
    expect(screen.queryByTestId('radial-chart')).not.toBeInTheDocument()
    // Контролы «Пространства» в панели остались на месте.
    expect(screen.getByText('3D-режим плеера')).toBeInTheDocument()
  })

  it('после рендера: секция «Визуализация» под плеером, 2 колонки — голова и график', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const section = screen.getByRole('region', { name: 'Визуализация' })
    // Секция идёт под плеером: трекер раньше её в DOM.
    const tracker = screen.getByTestId('neuromusic-tracker')
    expect(
      tracker.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    // Обе колонки внутри секции: силуэт (перенесён из «Опций») и график.
    const columns = within(section).getByTestId('visualization-columns')
    expect(columns.className).toContain('md:grid-cols-2')
    expect(within(columns).getByTestId('brainroom-view')).toBeInTheDocument()
    expect(within(columns).getByTestId('radial-chart')).toBeInTheDocument()
    // Без шапок и подписей — экономия высоты (остались только aria-label).
    expect(within(section).queryByRole('heading')).not.toBeInTheDocument()
    expect(within(section).queryByText('Голова, вид сверху')).not.toBeInTheDocument()
    expect(within(section).queryByText('Радиальный график')).not.toBeInTheDocument()
  })

  it('радиальный график: оси X/Y, 7 лучей-сегментов, круги сетки 25/50/75 %', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const chart = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'radial-chart',
    )
    // Оси X и Y — две линии через центр (viewBox 200×200, центр 100/100).
    expect(chart.querySelectorAll('[data-part="axis"]')).toHaveLength(2)
    // Лучи-разделители 7 сегментов: каждый выходит из центра.
    const rays = chart.querySelectorAll('[data-part="ray"]')
    expect(rays).toHaveLength(7)
    for (const ray of rays) {
      expect(ray.getAttribute('x1')).toBe('100')
      expect(ray.getAttribute('y1')).toBe('100')
    }
    // Круги сетки: радиус × 25 %, 50 %, 75 % (радиус графика 90).
    const rings = chart.querySelectorAll('[data-part="ring"]')
    expect([...rings].map((ring) => Number(ring.getAttribute('r')))).toEqual([22.5, 45, 67.5])
    // Круг-граница: оси и лучи ограничены его диаметром (r = 90).
    const frame = chart.querySelector('[data-part="frame"]')
    expect(frame).not.toBeNull()
    expect(Number(frame?.getAttribute('r'))).toBe(90)
    // Полигон: 7 вершин в кольце 0.1…1.0 R, заливка жёлтой 0.25, грани 2 px.
    const polygon = chart.querySelector('[data-part="polygon"]')
    expect(polygon).not.toBeNull()
    expect(polygon?.getAttribute('fill')).toBe('yellow')
    expect(polygon?.getAttribute('fill-opacity')).toBe('0.25')
    expect(polygon?.getAttribute('stroke')).toBe('yellow')
    expect(polygon?.getAttribute('stroke-opacity')).toBe('1')
    expect(polygon?.getAttribute('stroke-width')).toBe('2')
    const vertices = (polygon?.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(',').map(Number))
    expect(vertices).toHaveLength(7)
    for (const [x, y] of vertices) {
      const distance = Math.hypot(x - 100, y - 100)
      expect(distance).toBeGreaterThanOrEqual(9 - 1e-6)
      expect(distance).toBeLessThanOrEqual(90 + 1e-6)
    }
    // Доминанта: белая линия из центра + круглая точка 8 px (правка 08.10.2026).
    const dominant = chart.querySelector('[data-part="dominant"]')
    expect(dominant?.getAttribute('x1')).toBe('100')
    expect(dominant?.getAttribute('y1')).toBe('100')
    expect(dominant?.getAttribute('stroke')).toBe('white')
    const dot = chart.querySelector('[data-part="dominant-dot"]')
    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('stroke')).toBe('white')
    expect(dot?.getAttribute('stroke-width')).toBe('8')
    expect(dot?.getAttribute('stroke-linecap')).toBe('round')
    // Точка доминанты стоит там же, где конец линии.
    expect(dot?.getAttribute('x1')).toBe(dominant?.getAttribute('x2'))
    expect(dot?.getAttribute('y1')).toBe(dominant?.getAttribute('y2'))
  })

  it('«Эмо»: кадры грузятся, полигон рисуется лучами первого слайда', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const chart = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'radial-chart',
    )
    // GET …/emo ушёл после успеха рендера (TanStack Query, ключ render_id).
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/emo')),
      ).toBe(true),
    )
    // Слайд 0: лучи [10…70] % × 90 px → расстояния вершин 9, 18, …, 63 px.
    await waitFor(() => {
      const distances = polygonDistances(chart)
      expect(distances).toHaveLength(7)
      distances.forEach((value, index) => expect(value).toBeCloseTo((index + 1) * 9, 1))
    })
    // Доминанта пересчитана под эти лучи: ненулевой вектор внутри круга.
    const dominant = chart.querySelector('[data-part="dominant"]')
    const length = Math.hypot(
      Number(dominant?.getAttribute('x2')) - 100,
      Number(dominant?.getAttribute('y2')) - 100,
    )
    expect(length).toBeGreaterThan(0)
    expect(length).toBeLessThanOrEqual(90 + 1e-6)
    // Облако доминант: круг на каждый кадр (6 в моке) — ⌀8 px без заливки,
    // обводка 1 px; в jsdom масштаб ячейки = 1 — «честные» пиксели.
    const cloud = chart.querySelectorAll('[data-part="dominant-cloud"]')
    expect(cloud).toHaveLength(6)
    // Текущая доминанта на радиус-векторе — точка нулевым штрихом:
    // её диаметр = stroke-width (8 px, non-scaling).
    const dotDiameter = Number(
      chart.querySelector('[data-part="dominant-dot"]')?.getAttribute('stroke-width'),
    )
    expect(dotDiameter).toBe(8)
    for (const point of cloud) {
      expect(point.getAttribute('r')).toBe('3.5')
      expect(point.getAttribute('fill')).toBe('none')
      expect(point.getAttribute('stroke-width')).toBe('1')
      // Внешний диаметр кружка облака (2r + обводка) = диаметру текущей
      // доминанты (правка 09.10.2026).
      const diameter =
        Number(point.getAttribute('r')) * 2 + Number(point.getAttribute('stroke-width'))
      expect(diameter).toBe(dotDiameter)
      // Все точки внутри круга-границы.
      const distance = Math.hypot(
        Number(point.getAttribute('cx')) - 100,
        Number(point.getAttribute('cy')) - 100,
      )
      expect(distance).toBeLessThanOrEqual(90 + 1e-6)
    }
    // Суммарная доминанта: красный кружок ⌀8 px с заливкой 50 %,
    // отдельной линии вектора у неё нет — и она лежит ВНУТРИ облака
    // (центроид его bbox), а не на ободе графика.
    const total = chart.querySelector('[data-part="total-dominant"]')
    expect(total).not.toBeNull()
    expect(total?.getAttribute('r')).toBe('4')
    expect(total?.getAttribute('fill')).toBe('red')
    expect(total?.getAttribute('fill-opacity')).toBe('0.5')
    const totalX = Number(total?.getAttribute('cx'))
    const totalY = Number(total?.getAttribute('cy'))
    const cloudXs = [...cloud].map((point) => Number(point.getAttribute('cx')))
    const cloudYs = [...cloud].map((point) => Number(point.getAttribute('cy')))
    expect(totalX).toBeGreaterThanOrEqual(Math.min(...cloudXs) - 1e-6)
    expect(totalX).toBeLessThanOrEqual(Math.max(...cloudXs) + 1e-6)
    expect(totalY).toBeGreaterThanOrEqual(Math.min(...cloudYs) - 1e-6)
    expect(totalY).toBeLessThanOrEqual(Math.max(...cloudYs) + 1e-6)
    expect(Math.hypot(totalX - 100, totalY - 100)).toBeLessThan(90)
    expect(chart.querySelectorAll('[data-part="dominant"]')).toHaveLength(1)
  })

  it('«Эмо»: позиция плеера двигает полигон (интерполяция слайдов)', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const chart = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'radial-chart',
    )
    await waitFor(() => expect(polygonDistances(chart)[0]).toBeCloseTo(9, 1))

    // Слайды идут по 2/3 с: позиция 1.0 с — середина слайда 1 → 2.
    // Лучи слайда 1 = [20…80], слайда 2 = [30…90] → середина [25…85] % R.
    playerMock.position = 1
    await waitFor(
      () => {
        const distances = polygonDistances(chart)
        expect(distances[0]).toBeCloseTo(22.5, 1)
        expect(distances[6]).toBeCloseTo(76.5, 1)
      },
      { timeout: 3000 },
    )
  })

  it('«Эмо»: метка темпа на оси Y скрыта без tempo_track (ложится на ось X)', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const chart = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'radial-chart',
    )
    await waitFor(() => expect(polygonDistances(chart)[0]).toBeCloseTo(9, 1))
    // Засечка есть в DOM, но прозрачна: без темпа она лежала бы ровно на оси X.
    const mark = chart.querySelector('[data-part="tempo-mark"]')
    expect(mark).not.toBeNull()
    expect(mark?.getAttribute('opacity')).toBe('0')
  })

  it('«Эмо»: метка темпа едет по оси Y (60 → низ, 240 → верх)', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const withTempo: AudioEmo = {
      ...EMO_PAYLOAD,
      tempo_track: [
        { t_sec: 0, bpm: 60 }, // слайд 0: y = −1 → низ графика (100 + 90)
        { t_sec: 2, bpm: 240 }, // слайд 3+: y = +1 → верх (100 − 90)
      ],
      tempo_source: 'vamp:qm-vamp-plugins:qm-tempotracker:tempo',
    }
    const fetchMock = audioFetchMock(TRACKS, { emo: withTempo })
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const chart = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'radial-chart',
    )
    const mark = chart.querySelector('[data-part="tempo-mark"]')
    await waitFor(() => expect(mark?.getAttribute('opacity')).toBe('1'))
    // Слайд 0: темп 60 → метка внизу оси Y (y = 190 при центре 100 и R = 90).
    await waitFor(() => expect(Number(mark?.getAttribute('y1'))).toBeCloseTo(190, 1))
    expect(Number(mark?.getAttribute('y2'))).toBeCloseTo(190, 1)
    // Позиция 2.0 с — слайд 3 (темп 240 после hold/интерполяции) → верх (y = 10).
    playerMock.position = 2
    await waitFor(
      () => expect(Number(mark?.getAttribute('y1'))).toBeCloseTo(10, 1),
      { timeout: 3000 },
    )
  })

  it('счётчики «Аккорд»/«Темп»: пиули в секции «Эмо», значения — как в анимации радара', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const withTracks: AudioEmo = {
      ...EMO_PAYLOAD,
      key_track: [
        { t_sec: 0, key_code: 1, label: 'C major' },
        { t_sec: 2, key_code: 13, label: 'C minor' },
      ],
      key_source: 'vamp:qm-vamp-plugins:qm-keydetector:key',
      tempo_track: [
        { t_sec: 0, bpm: 100 },
        { t_sec: 2, bpm: 140 },
      ],
      tempo_source: 'vamp:qm-vamp-plugins:qm-tempotracker:tempo',
    }
    const fetchMock = audioFetchMock(TRACKS, { emo: withTracks })
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    // Счётчики — в секции размещения графика «Эмо» (не в подзаголовке секции).
    const counters = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'emo-counters',
    )
    const keyCounter = within(counters).getByTestId('emo-counter-key')
    const tempoCounter = within(counters).getByTestId('emo-counter-tempo')
    // Кадр 0: сегмент «C major», темп слайда 0 (100,0 — среднее оценок диапазона).
    await waitFor(() => expect(keyCounter).toHaveTextContent('C major'))
    expect(tempoCounter).toHaveTextContent('100,0 bpm')

    // Позиция 2.0 с — кадр 3: сегмент «C minor», темп 140 (как у засечки радара).
    playerMock.position = 2
    await waitFor(() => expect(keyCounter).toHaveTextContent('C minor'), { timeout: 3000 })
    expect(tempoCounter).toHaveTextContent('140,0 bpm')
  })

  it('счётчики «Аккорд»/«Темп»: без треков Соник Аннотатора — «—»', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const counters = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'emo-counters',
    )
    expect(within(counters).getByTestId('emo-counter-key')).toHaveTextContent('—')
    expect(within(counters).getByTestId('emo-counter-tempo')).toHaveTextContent('—')
  })

  it('«Эмо»: сервер не отдал кадры (404) — фоллбэк-рандомизатор без падения', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock(TRACKS, { emo: null })
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    const chart = within(screen.getByRole('region', { name: 'Визуализация' })).getByTestId(
      'radial-chart',
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/emo')),
      ).toBe(true),
    )
    // Лучи случайные 0.1…1.0 R: детерминированный паттерн кадра
    // [9, 18, …, 63] не собирается, но все вершины внутри круга-границы.
    await waitFor(() => {
      const distances = polygonDistances(chart)
      expect(distances).toHaveLength(7)
      const matched = distances.filter(
        (value, index) => Math.abs(value - (index + 1) * 9) <= 0.5,
      ).length
      expect(matched).toBeLessThan(7)
      for (const value of distances) {
        expect(value).toBeGreaterThanOrEqual(9 - 1e-6)
        expect(value).toBeLessThanOrEqual(90 + 1e-6)
      }
    })
  })
})
