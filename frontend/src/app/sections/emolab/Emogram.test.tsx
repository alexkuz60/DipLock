/**
 * Тесты графика «Эмограмма» (постановка владельца 21.10.2026): сетка из 14
 * эмо-линий с подписями справа «Эмо», столбики «Экспрессии Эмо» (высота =
 * радиус-вектор доминанты), ступени «Динамики Эмо» (высота = угол доминанты,
 * цвет = сектор радара), курсор позиции плеера.
 *
 * Кадры мока — одиночные лучи: доминанта кадра стоит точно на луче звезды,
 * поэтому углы/высоты/цвета проверяются без вычислений (луч 0 → низ «страх»
 * и сектор δ, луч 6 → доля 6/7 и сектор γ-high).
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AudioEmo } from '@/shared/api/types'
import { renderWithProviders } from '@/test/renderWithProviders'
import { Emogram } from './Emogram'
import {
  EMO_LABEL_W,
  EMO_LABELS,
  EMO_PAD_LEFT,
  EMO_PAD_TOP,
  EMO_TIME_H,
  EMO_VIEW_H,
  EMO_VIEW_W,
} from './emogram'

/** Кадры «Эмо»: луч 0 (100 %), луч 6 (100 %), тишина (доминанта в центре). */
const EMO: AudioEmo = {
  schema_version: 5,
  fs_audio: 32000,
  fft_size: 32768,
  hop_samples: 32000,
  overlap_samples: 768,
  normalization: 'db_relative',
  db_floor: -60,
  global_max: 1000,
  duration_s: 3,
  frame_count: 3,
  frames: [
    { t_sec: 0, rays: [100, 0, 0, 0, 0, 0, 0] },
    { t_sec: 1, rays: [0, 0, 0, 0, 0, 0, 100] },
    { t_sec: 2, rays: [0, 0, 0, 0, 0, 0, 0] },
  ],
  key_track: null,
  key_source: null,
  tempo_track: null,
  tempo_source: null,
  segment_track: null,
  segment_source: null,
}

/** Геометрия дефолтного полотна (jsdom: замера нет → `EMO_VIEW_W`×`EMO_VIEW_H`). */
const PLOT_W = EMO_VIEW_W - EMO_LABEL_W - EMO_PAD_LEFT
const PLOT_H = EMO_VIEW_H - EMO_PAD_TOP - EMO_TIME_H
const Y_BOTTOM = EMO_VIEW_H - EMO_TIME_H

function parts(root: HTMLElement, part: string): Element[] {
  return Array.from(root.querySelectorAll(`[data-part="${part}"]`))
}

describe('ЕмоЛаб: график «Эмограмма»', () => {
  it('сетка: 14 эмо-линий с подписями «страх»…«агрессия» и шкала времени', () => {
    renderWithProviders(<Emogram emo={EMO} />)
    const root = screen.getByTestId('emogram')
    expect(screen.getByTestId('emogram-legend-express')).toHaveTextContent('Экспрессия Эмо')
    expect(screen.getByTestId('emogram-legend-dynamics')).toHaveTextContent('Динамика Эмо')

    const grid = parts(root, 'emo-grid')
    expect(grid).toHaveLength(14)
    const labels = parts(root, 'emo-label')
    expect(labels.map((node) => node.textContent)).toEqual([...EMO_LABELS])
    // Линия «страх» — внизу графика, «агрессия» — на 13/14 высоты.
    expect(Number(grid[0]?.getAttribute('y1'))).toBeCloseTo(Y_BOTTOM, 6)
    expect(Number(grid[13]?.getAttribute('y1'))).toBeCloseTo(
      Y_BOTTOM - (13 / 14) * PLOT_H,
      6,
    )
    // Вертикали/подписи времени: не меньше двух делений шкалы звучания.
    expect(parts(root, 'emo-time-grid').length).toBeGreaterThanOrEqual(2)
    expect(parts(root, 'emo-time-label').length).toBeGreaterThanOrEqual(2)
  })

  it('Экспрессия Эмо: столбик кадра от низа до радиус-вектора (0…1), цвет сектора', () => {
    renderWithProviders(<Emogram emo={EMO} />)
    const root = screen.getByTestId('emogram')
    const bars = parts(root, 'express-bar')
    // Два кадра с доминантой (третий — тишина, без столбика).
    expect(bars).toHaveLength(2)
    for (const bar of bars) {
      // Одиночный луч = радиус-вектор 1 → столбик на всю высоту графика.
      expect(Number(bar.getAttribute('height'))).toBeCloseTo(PLOT_H, 6)
      expect(Number(bar.getAttribute('y'))).toBeCloseTo(Y_BOTTOM - PLOT_H, 6)
    }
    // Цвет столбика — сектор Эмо его угла доминанты (как у ступени кадра):
    // луч 0 → δ красный, луч 6 → γ-high розово-фиолетовый.
    expect(bars[0]?.getAttribute('fill')).toBe('hsl(0.0, 85%, 55.0%)')
    expect(bars[1]?.getAttribute('fill')).toBe('hsl(275.0, 85%, 70.0%)')
    // Столбик кадра 1 смещён на 1/3 шкалы времени (3 с) и шириной кадр − зазор.
    expect(Number(bars[1]?.getAttribute('x'))).toBeCloseTo(EMO_PAD_LEFT + PLOT_W / 3, 6)
    expect(Number(bars[0]?.getAttribute('width'))).toBeCloseTo(PLOT_W / 3 - 1, 6)
  })

  it('Динамика Эмо: ступени 1 с на высоте угла доминанты, цвет сектора', () => {
    renderWithProviders(<Emogram emo={EMO} />)
    const root = screen.getByTestId('emogram')
    const steps = parts(root, 'emo-step')
    expect(steps).toHaveLength(2)
    // Кадр 0: угол на начале 1 сектора → низ («страх»), сектор δ — красный.
    expect(Number(steps[0]?.getAttribute('y1'))).toBeCloseTo(Y_BOTTOM, 6)
    expect(steps[0]?.getAttribute('stroke')).toBe('hsl(0.0, 85%, 55.0%)')
    // Кадр 1: угол вершины 6 → доля 6/7, сектор γ-high — розово-фиолетовый.
    expect(Number(steps[1]?.getAttribute('y1'))).toBeCloseTo(
      Y_BOTTOM - (6 / 7) * PLOT_H,
      6,
    )
    expect(steps[1]?.getAttribute('stroke')).toBe('hsl(275.0, 85%, 70.0%)')
    // Длина ступени — ровно кадр (1 с из 3 с шкалы).
    for (const step of steps) {
      const x1 = Number(step.getAttribute('x1'))
      const x2 = Number(step.getAttribute('x2'))
      expect(x2 - x1).toBeCloseTo(PLOT_W / 3, 6)
    }
  })

  it('курсор позиции плеера: без плеера — у начала шкалы', () => {
    renderWithProviders(<Emogram emo={EMO} />)
    const playhead = parts(screen.getByTestId('emogram'), 'playhead')
    expect(playhead).toHaveLength(1)
    expect(Number(playhead[0]?.getAttribute('x1'))).toBeCloseTo(EMO_PAD_LEFT, 6)
  })

  it('сегменты трека: вертикали на всю высоту с метками имён A, B, C… у верха', () => {
    renderWithProviders(
      <Emogram
        emo={{
          ...EMO,
          segment_track: [
            { t_sec: 0, name: 'A', segment_type: 1 },
            { t_sec: 1, name: 'B', segment_type: 2 },
            { t_sec: 2, name: 'C', segment_type: 3 },
          ],
          segment_source: 'vamp:qm-vamp-plugins:qm-segmenter:segmentation',
        }}
      />,
    )
    const root = screen.getByTestId('emogram')
    const lines = parts(root, 'segment-line')
    expect(lines).toHaveLength(3)
    // Сегмент 0 — у левого края графика, сегмент 1 — на 1/3 шкалы времени (3 с).
    expect(Number(lines[0]?.getAttribute('x1'))).toBeCloseTo(EMO_PAD_LEFT, 6)
    expect(Number(lines[1]?.getAttribute('x1'))).toBeCloseTo(EMO_PAD_LEFT + PLOT_W / 3, 6)
    for (const line of lines) {
      expect(Number(line.getAttribute('y1'))).toBeCloseTo(EMO_PAD_TOP, 6)
      expect(Number(line.getAttribute('y2'))).toBeCloseTo(Y_BOTTOM, 6)
    }
    // Имена сегментов — метки плагина (A, B, C…) в порядке появления.
    const labels = parts(root, 'segment-label')
    expect(labels.map((node) => node.textContent)).toEqual(['A', 'B', 'C'])
  })
})