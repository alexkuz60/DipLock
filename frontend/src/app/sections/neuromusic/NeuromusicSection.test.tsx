/**
 * Тесты раздела «Нейромузыка» (M5): подсказка без записи, кнопка «Создать аудио»
 * в тулс-хедере → поллинг статуса → прогресс-бар → плеер и список из семи
 * треков; параметры — в панели опций, правка не запускает расчёт.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import * as spatialPlayerLib from '@/shared/lib/spatialPlayer'
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
import { NeuromusicPanel } from './NeuromusicPanel'
import { NeuromusicSection } from './NeuromusicSection'
import { NeuromusicToolActions } from './NeuromusicToolActions'

/**
 * Мок Tone-цепочки (spatialPlayer): jsdom без Web Audio — проверяем интеграцию
 * (кто вызван, какие URL), а не звук. Реальный модуль не импортируется.
 */
vi.mock('@/shared/lib/spatialPlayer', () => {
  const player = {
    duration: 4,
    position: 0,
    playing: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    seek: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn(),
    setWidth: vi.fn(),
    setSpread: vi.fn(),
    setWet: vi.fn(),
    setIrUrl: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  }
  return {
    SpatialAudioPlayer: Object.assign(vi.fn().mockResolvedValue(player), {
      load: vi.fn().mockResolvedValue(player),
      __player: player,
    }),
  }
})

/** Инстанс мока плеера: функции-заглушки + числовые поля состояния. */
type MockPlayer = {
  [key: string]: ReturnType<typeof vi.fn> | number | boolean
}

/** Мок плеера: `SpatialAudioPlayer.load` и созданный инстанс. */
const loadMock = spatialPlayerLib.SpatialAudioPlayer as unknown as {
  load: ReturnType<typeof vi.fn>
  __player: MockPlayer
}
const playerMock = loadMock.__player as {
  play: ReturnType<typeof vi.fn>
  seek: ReturnType<typeof vi.fn>
  setIrUrl: ReturnType<typeof vi.fn>
  setWidth: ReturnType<typeof vi.fn>
  setSpread: ReturnType<typeof vi.fn>
  setWet: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  duration: number
  position: number
  playing: boolean
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
  beforeEach(() => {
    // Стор общий для всех компонентов раздела и живёт между тестами:
    // параметры и результат каждого теста сбрасываются явно. reset() первым —
    // он отменяет токен поллинга: висящий промис прошлого теста иначе может
    // перезаписать status уже нового (паттерн renderToken, не влиял раньше,
    // потому что статусы совпадали).
    useNeuromusic.getState().reset()
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
    // Моки Tone-цепочки: restoreAllMocks в vitest.setup.ts сбрасывает
    // implementation всех vi.fn() после каждого теста — перепривязываем
    // resolved-значения и чистим вызовы.
    loadMock.load.mockResolvedValue(playerMock)
    for (const value of Object.values(playerMock)) {
      if (typeof value === 'function' && 'mockClear' in value) value.mockClear()
    }
    playerMock.play.mockResolvedValue(undefined)
    playerMock.seek.mockResolvedValue(undefined)
    playerMock.setIrUrl.mockResolvedValue(undefined)
    playerMock.playing = false
    playerMock.position = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('без открытой записи — честная подсказка открыть EDF', () => {
    useEdfRecording.setState({ recording: null })
    renderNeuromusic()
    expect(screen.getByText(/Откройте ЭЭГ-запись/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    // Кнопка в хедере есть, но выключена без записи (с объяснением в тултипе)
    expect(screen.getByRole('button', { name: 'Создать аудио' })).toBeDisabled()
  })

  it('кнопка → прогресс с шагом пайплайна → плеер и семь треков', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    vi.stubGlobal('fetch', audioFetchMock())

    renderNeuromusic()
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))

    // Прогресс-бар с процентами и подписью шага (ТЗ M5).
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument())
    expect(screen.getByText('Трек alpha (4/7)')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')

    // После успеха: плеер мастера, партитура и список инструментов.
    await waitFor(
      () => expect(screen.getByTestId('neuromusic-player')).toBeInTheDocument(),
      { timeout: 3000 },
    )
    expect(screen.getByRole('link', { name: 'Скачать мастер' })).toBeInTheDocument()
    for (const name of ['δ — дельта', 'θ — тета', 'α — альфа', 'γ-high — высокая гамма']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }

    // Выбор трека меняет src плеера на соль-WAV.
    fireEvent.click(screen.getByRole('button', { name: 'α — альфа' }))
    await waitFor(() =>
      expect(screen.getByTestId('neuromusic-player')).toHaveAttribute(
        'src',
        expect.stringContaining('/track/alpha.wav'),
      ),
    )
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
    // Ждём завершения первого рендера (плеер = succeeded, кнопка активна).
    await waitFor(
      () => expect(screen.getByTestId('neuromusic-player')).toBeInTheDocument(),
      { timeout: 3000 },
    )
    fireEvent.click(screen.getByLabelText('Перцептуальный баланс (ISO 226)'))
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(2))
    expect(JSON.parse(fetchMock.postBodies[1])).toMatchObject({ loudness_phon: null })
  })

  /** Дожидается succeeded-рендера: кнопка → поллинг → обычный плеер. */
  async function renderSucceeded(fetchMock: ReturnType<typeof audioFetchMock>) {
    renderNeuromusic()
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId('neuromusic-player')).toBeInTheDocument(), {
      timeout: 3000,
    })
  }

  it('3D-режим: включение показывает spatial-плеер, load получает семь треков', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    // Обычный плеер на месте; чекбокс выключен по умолчанию.
    expect(screen.getByTestId('neuromusic-player')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() => expect(loadMock.load).toHaveBeenCalledTimes(1))
    // Готовность графа = появление кнопки транспорта (после резолва load).
    await waitFor(() => expect(screen.getByTestId('spatial-toggle')).toBeInTheDocument())
    const options = loadMock.load.mock.calls[0][0] as {
      trackUrls: string[]
      irUrl: string
      widthPct: number
      spreadPct: number
      wetPct: number
    }
    expect(options.trackUrls).toHaveLength(7)
    expect(options.trackUrls[0]).toContain('/track/')
    expect(options.irUrl).toContain('/audio/ir/room_small.wav')
    expect(options).toMatchObject({ widthPct: 100, spreadPct: 100, wetPct: 25 })

    // <audio> заменён, соло-кнопки скрыты (в 3D все треки звучат разом).
    expect(screen.queryByTestId('neuromusic-player')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Мастер — партитура целиком' })).toBeNull()
    // Ни одного POST: spatial-параметры — чисто клиентские.
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('правка spatial-параметров применяется к живому графу без запросов', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)
    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() => expect(loadMock.load).toHaveBeenCalledTimes(1))
    // Параметры применимы только к построенному графу — ждём готовности.
    await waitFor(() => expect(screen.getByTestId('spatial-toggle')).toBeInTheDocument())

    // Ширина/разброс/влажность — real-time вызовы в мок-плеер, без сети.
    fireEvent.change(screen.getByLabelText(/Ширина базы/), { target: { value: '140' } })
    await waitFor(() =>
      expect(playerMock.setWidth as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(140),
    )
    fireEvent.change(screen.getByLabelText(/Разброс по дуге/), { target: { value: '40' } })
    await waitFor(() =>
      expect(playerMock.setSpread as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(40),
    )
    fireEvent.change(screen.getByLabelText(/Влажность реверберации/), { target: { value: '60' } })
    await waitFor(() =>
      expect(playerMock.setWet as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(60),
    )

    // Смена помещения — GET готового IR-ассета (не расчёт) и подмена буфера.
    fireEvent.change(screen.getByLabelText(/Помещение \(IR\)/), { target: { value: 'room_small' } })
    await waitFor(() =>
      expect(playerMock.setIrUrl as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.stringContaining('/audio/ir/room_small.wav'),
      ),
    )

    // Правка параметров не запускает рендера (правило UI) — POST по-прежнему один.
    expect(fetchMock.postBodies).toHaveLength(1)
  })

  it('выключение 3D-режима возвращает обычный плеер и сносит граф', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await renderSucceeded(fetchMock)

    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() => expect(loadMock.load).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('spatial-toggle')).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('3D-режим плеера'))
    await waitFor(() =>
      expect(screen.getByTestId('neuromusic-player')).toBeInTheDocument(),
    )
    expect(playerMock.dispose as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
    // Соло-кнопки вернулись вместе с обычным плеером.
    expect(screen.getByRole('button', { name: 'Мастер — партитура целиком' })).toBeInTheDocument()
  })
})
