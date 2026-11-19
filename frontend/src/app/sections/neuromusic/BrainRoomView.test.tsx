/**
 * Силуэт головы с маркерами дипольной сцены «Монтажа» (срез 19.11.2026):
 * восьмёрка ∞ на полосу — поворот по θ, цвет полосы, размер ∝ стереобазе,
 * прозрачность ∝ силе, размытость окружности ∝ глубине; анимация по позиции
 * плеера (rAF пишет атрибуты без ре-рендеров).
 */
import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NeuromusicPlayer } from '@/shared/lib/neuromusicPlayer'
import type { DipoleScene } from '@/shared/lib/dipoleScene'
import { useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { BrainRoomView } from './BrainRoomView'

const SCENE: DipoleScene = {
  source_job_id: 'job-1',
  epoch_length_ms: 1000,
  mni_half_x_mm: 70,
  depth_z_mm: { top: 70, bottom: -70 },
  bands: {
    delta: {
      stereo_base: 0.8,
      frames: [
        { t: 0, x: 0, y: 70, z: 70, theta: 0, strength: 0.25 },
        { t: 2, x: 70, y: 0, z: -70, theta: Math.PI / 2, strength: 1 },
      ],
    },
    alpha: {
      stereo_base: 0.45,
      frames: [{ t: 0, x: -70, y: 0, z: 0, theta: 1, strength: 0.8 }],
    },
  },
}

/** Фейковый плеер с управляемой позицией (getActivePlayer → attach). */
function fakePlayer(position: number): NeuromusicPlayer {
  return { position, playing: true } as unknown as NeuromusicPlayer
}

afterEach(() => {
  useNeuromusicPlayer.getState().detach()
})

describe('BrainRoomView — дипольная сцена «Монтажа»', () => {
  it('маркеры ∞ по полосам: сила/глубина слайда 0, размер ∝ стереобазе', () => {
    const { getByTestId } = render(
      <BrainRoomView variant="montage" bands={2} spreadPct={100} scene={SCENE} />,
    )
    expect(getByTestId('brainroom-view')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('дипольная сцена'),
    )
    const delta = getByTestId('dipole-marker-delta')
    expect(delta).toHaveAttribute('data-strength', '0.250')
    expect(delta).toHaveAttribute('data-depth', '0.000') // z=70 — верх мозга
    // Фронт (y=+70) — вверх схемы: cy центра меньше центра viewBox (130).
    const transform = delta.getAttribute('transform') ?? ''
    expect(transform).toMatch(/translate\(100(\.\d+)?, (?!130)/)
    // Восьмёрка повёрнута на θ=0 → rotate(0).
    expect(transform).toContain('rotate(0)')
    const alpha = getByTestId('dipole-marker-alpha')
    expect(alpha).toHaveAttribute('data-strength', '0.800')
    expect(alpha).toHaveAttribute('data-depth', '0.500') // z=0 — середина
    // Размер: круг дельты (0.8) крупнее круга альфы (0.45).
    const radiusOf = (marker: Element) => Number(marker.querySelector('circle')?.getAttribute('r'))
    expect(radiusOf(delta)).toBeGreaterThan(radiusOf(alpha))
  })

  it('анимация по позиции плеера: слайд t=2 (поворот θ, сила, глубина)', async () => {
    useNeuromusicPlayer.getState().attach(fakePlayer(2))
    const { getByTestId } = render(
      <BrainRoomView variant="montage" bands={2} spreadPct={100} scene={SCENE} />,
    )
    const delta = getByTestId('dipole-marker-delta')
    // Один тик rAF обновляет атрибуты императивно (без ре-рендеров React).
    await waitFor(() => expect(delta).toHaveAttribute('data-strength', '1.000'))
    await waitFor(() => expect(delta).toHaveAttribute('data-depth', '1.000'))
    const transform = delta.getAttribute('transform') ?? ''
    // θ = π/2 → поворот ≈ 90° (плавающая точка допускает 89.99…/90.00…).
    expect(transform).toMatch(/rotate\((89\.9+|90)/)
  })

  it('без сцены (старый рендер) — статичные точки дуги «Экспресса»', () => {
    const { getByTestId, queryByTestId } = render(
      <BrainRoomView variant="express" bands={7} spreadPct={100} scene={null} />,
    )
    expect(getByTestId('brainroom-view')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('дуга ±60°'),
    )
    expect(queryByTestId('dipole-marker-delta')).toBeNull()
  })
})