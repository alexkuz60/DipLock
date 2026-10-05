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
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
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
})
