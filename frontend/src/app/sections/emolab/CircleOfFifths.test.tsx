/**
 * Тесты активного квинтово-квартового круга (`CircleOfFifths.tsx`):
 * раскладка колец (12 мажоров + 12 миноров + подписи альтераций), центр с
 * именем активной тональности, подсветки легенды образца и легенда.
 */
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/renderWithProviders'
import type { AudioEmo } from '@/shared/api/types'
import { CircleOfFifths } from './CircleOfFifths'

/**
 * Мок плеера: позиция чтения `getActivePlayer().position` (тот же приём, что
 * в `EmoLabSection.test.tsx`).
 */
vi.mock('@/shared/state/neuromusicPlayer', () => ({
  getActivePlayer: () => ({ position: 0 }),
}))

/** Кадры «Эмо» с картой аккордов: C мажор весь трек. */
const EMO_C: AudioEmo = {
  schema_version: 9,
  fs_audio: 32000,
  fft_size: 32768,
  hop_samples: 32000,
  overlap_samples: 768,
  window: 'blackman_harris',
  normalization: 'peak_linear',
  global_max: 1000,
  duration_s: 2,
  frame_count: 2,
  frames: [
    { t_sec: 0, rays: [50, 50, 50, 50, 50, 50, 50] },
    { t_sec: 1, rays: [50, 50, 50, 50, 50, 50, 50] },
  ],
  key_track: [{ t_sec: 0, key_code: 1, label: 'C' }],
  key_source: 'vamp:nnls-chroma:chordino:simplechord',
  tempo_track: null,
  tempo_source: null,
  segment_track: null,
  segment_source: null,
}

function cells() {
  return Array.from(document.querySelectorAll('[data-part="cof-cell"]'))
}

function cellBy(name: string) {
  return cells().find((cell) => cell.nextElementSibling?.textContent === name)
}

describe('CircleOfFifths — раскладка квинтово-квартового круга', () => {
  it('24 ячейки (12 мажоров + 12 миноров) и 12 подписей альтераций', () => {
    renderWithProviders(<CircleOfFifths emo={EMO_C} />)
    expect(cells()).toHaveLength(24)
    expect(document.querySelectorAll('[data-part="cof-signature"]')).toHaveLength(12)
    // Внешнее кольцо — мажоры, внутреннее — миноры.
    expect(document.querySelectorAll('[data-part="cof-cell"][data-ring="major"]')).toHaveLength(12)
    expect(document.querySelectorAll('[data-part="cof-cell"][data-ring="minor"]')).toHaveLength(12)
    // C вверху (позиция 0 мажоров), Am — позиция 0 миноров.
    expect(cellBy('C')).toBeTruthy()
    expect(cellBy('Am')).toBeTruthy()
  })

  it('центр: имя активной тональности C и лад «мажор»', async () => {
    renderWithProviders(<CircleOfFifths emo={EMO_C} />)
    await waitFor(() =>
      expect(screen.getByTestId('circle-of-fifths').querySelector('[data-part="cof-center-name"]'))
        .toHaveTextContent('C'),
    )
    expect(
      screen.getByTestId('circle-of-fifths').querySelector('[data-part="cof-center-mode"]'),
    ).toHaveTextContent('мажор')
  })

  it('подсветки C мажор: тоника C, суб/доминанта F+G, параллельная Am, одноимённая Cm', async () => {
    renderWithProviders(<CircleOfFifths emo={EMO_C} />)
    await waitFor(() => expect(cellBy('C')?.getAttribute('data-role')).toBe('tonic'))
    expect(cellBy('G')?.getAttribute('data-role')).toBe('dominant')
    expect(cellBy('F')?.getAttribute('data-role')).toBe('subdominant')
    expect(cellBy('Am')?.getAttribute('data-role')).toBe('parallel')
    expect(cellBy('Cm')?.getAttribute('data-role')).toBe('sameName')
    // Неактивные ячейки — без роли.
    expect(cellBy('D')?.getAttribute('data-role')).toBe('none')
    expect(cellBy('Em')?.getAttribute('data-role')).toBe('none')
  })

  it('легенда подсветок образца: тоника, суб/доминанта, параллельная, одноимённая', () => {
    renderWithProviders(<CircleOfFifths emo={EMO_C} />)
    const legend = screen.getByTestId('circle-of-fifths').querySelector('[data-part="cof-legend"]')
    expect(legend).toHaveTextContent('тоника')
    expect(legend).toHaveTextContent('суб/доминанта')
    expect(legend).toHaveTextContent('параллельная')
    expect(legend).toHaveTextContent('одноимённая')
  })

  it('без кадров — центр «—», все ячейки без подсветки', () => {
    renderWithProviders(<CircleOfFifths emo={null} />)
    expect(
      screen.getByTestId('circle-of-fifths').querySelector('[data-part="cof-center-name"]'),
    ).toHaveTextContent('—')
    expect(cells().every((cell) => cell.getAttribute('data-role') === 'none')).toBe(true)
  })
})