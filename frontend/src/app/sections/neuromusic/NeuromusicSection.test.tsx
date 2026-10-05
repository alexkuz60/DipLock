/**
 * Тесты раздела «Нейромузыка» (M5): подсказка без записи, кнопка → поллинг
 * статуса → прогресс-бар → плеер и список из семи треков.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { NeuromusicSection } from './NeuromusicSection'

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

describe('Нейромузыка — раздел', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('без открытой записи — честная подсказка открыть EDF', () => {
    useEdfRecording.setState({ recording: null })
    renderWithProviders(<NeuromusicSection />)
    expect(screen.getByText(/Откройте ЭЭГ-запись/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('кнопка → прогресс с шагом пайплайна → плеер и семь треков', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    vi.stubGlobal('fetch', audioFetchMock())

    renderWithProviders(<NeuromusicSection />)
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
    expect(screen.getByRole('link', { name: /Скачать партитуру/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /δ — дельта/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /γ-high — высокая гамма/ })).toBeInTheDocument()
    // Скачивание каждого из семи треков — отдельной ссылкой (соль-прослушивание).
    expect(screen.getAllByRole('link', { name: /Скачать \.wav/ })).toHaveLength(7)
  })

  it('выбор трека меняет источник плеера на его WAV', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    vi.stubGlobal('fetch', audioFetchMock())

    renderWithProviders(<NeuromusicSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))
    await waitFor(
      () => expect(screen.getByTestId('neuromusic-player')).toBeInTheDocument(),
      { timeout: 3000 },
    )

    fireEvent.click(screen.getByRole('button', { name: /α — альфа/ }))
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

    renderWithProviders(<NeuromusicSection />)

    // Контрол параметра: диапазон 0…12, значение по умолчанию +6 (приёмка 05.10).
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

    renderWithProviders(<NeuromusicSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Максимум (boost)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Создать аудио' }))

    await waitFor(() => expect(fetchMock.postBodies).toHaveLength(1))
    const body = JSON.parse(fetchMock.postBodies[0]) as Record<string, unknown>
    expect(body).toMatchObject({ loudness_autobase: false, loudness_phon: 75 })
    // Другие режимы не пострадали (правка параметра не запускает расчёт).
    expect(screen.getByLabelText(/Усиление полос/)).toHaveValue(6)
  })

  it('компенсация ISO 226 выключается чекбоксом, уровень правится полем', async () => {
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchMock = audioFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    renderWithProviders(<NeuromusicSection />)

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
})
