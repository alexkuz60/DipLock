/**
 * Тесты «Общей эмо-характеристики аудио-трека» (шаг 9, 24.10.2026):
 * горизонтальная гистограмма накопленных сумм векторов доминант по 14
 * текстовым характеристикам настроения (`EMO_LABELS`).
 *
 * Кадры мока — одиночные лучи: доминанта кадра стоит точно на луче звезды
 * (угол `SEGMENT_START + k·2π/7` → категория `2k` шкалы «Эмо»): луч 0 →
 * «страх/агрессия» (категория 0, сектор δ), луч 6 → «вдохновение» (категория
 * 12, сектор γ-high). Третий кадр — тишина (доминанта в центре) — не участвует.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AudioEmo } from '@/shared/api/types'
import { renderWithProviders } from '@/test/renderWithProviders'
import {
  EmoHistogram,
  HIST_LABEL_W,
  HIST_PAD_Y,
  HIST_VALUE_W,
  HIST_VIEW_H,
  HIST_VIEW_W,
} from './EmoHistogram'
import { EMO_LABELS } from './emogram'

/** Кадры «Эмо»: луч 0 (100 %), луч 6 (100 %), тишина (доминанта в центре). */
const EMO: AudioEmo = {
  schema_version: 10,
  fs_audio: 32000,
  fft_size: 32768,
  hop_samples: 32000,
  overlap_samples: 768,
  window: 'blackman_harris',
  normalization: 'peak_linear',
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

/** Геометрия дефолтного полотна (jsdom: замера нет → `HIST_VIEW_W`×`HIST_VIEW_H`). */
const PLOT_W = HIST_VIEW_W - HIST_LABEL_W - HIST_VALUE_W

function parts(root: HTMLElement, part: string): Element[] {
  return Array.from(root.querySelectorAll(`[data-part="${part}"]`))
}

describe('ЕмоЛаб: «Общая эмо-характеристика аудио-трека»', () => {
  it('14 строк снизу вверх «страх/агрессия»…«эйфория», подписи слева', () => {
    renderWithProviders(<EmoHistogram emo={EMO} />)
    const root = screen.getByTestId('emo-histogram')
    const labels = parts(root, 'hist-label')
    expect(labels).toHaveLength(14)
    expect(labels.map((node) => node.textContent)).toEqual([...EMO_LABELS])
    // Подписи выровнены по левому столбцу (правый край = HIST_LABEL_W − 8).
    for (const label of labels) {
      expect(Number(label.getAttribute('x'))).toBeCloseTo(HIST_LABEL_W - 8, 6)
    }
    // «страх/агрессия» (строка 0) — у нижней кромки, «эйфория» (строка 13) — выше.
    const yFirst = Number(labels[0]?.getAttribute('y'))
    const yLast = Number(labels[13]?.getAttribute('y'))
    expect(yFirst).toBeGreaterThan(yLast)
    expect(yFirst).toBeLessThanOrEqual(HIST_VIEW_H - HIST_PAD_Y)
    expect(yLast).toBeGreaterThanOrEqual(HIST_PAD_Y)
  })

  it('столбики: длина ∝ накопленной сумме, цвет сектора, значение у конца', () => {
    renderWithProviders(<EmoHistogram emo={EMO} />)
    const root = screen.getByTestId('emo-histogram')
    const bars = parts(root, 'hist-bar')
    expect(bars).toHaveLength(14)
    // Одиночный луч = радиус-вектор 1 → сумма категории = 1 (максимум) →
    // столбик на всю ширину; тихий кадр не добавляет.
    const widths = bars.map((bar) => Number(bar.getAttribute('width')))
    expect(Math.max(...widths)).toBeCloseTo(PLOT_W, 6)
    // Категории 0 («страх/агрессия», луч 0) и 12 («вдохновение», луч 6) — единственные ненулевые.
    expect(widths[0]).toBeCloseTo(PLOT_W, 6)
    expect(widths[12]).toBeCloseTo(PLOT_W, 6)
    expect(widths.filter((width) => width > 0)).toHaveLength(2)
    // Цвет = сектор категории: 0 → δ красный, 12 → γ-high розово-фиолетовый.
    expect(bars[0]?.getAttribute('fill')).toBe('hsl(0.0, 85%, 55.0%)')
    expect(bars[12]?.getAttribute('fill')).toBe('hsl(275.0, 85%, 70.0%)')
    // Значение — у правого конца столбика, сырая сумма (1 знак).
    const values = parts(root, 'hist-value')
    expect(values).toHaveLength(2) // нулевые категории без значения
    expect(values[0]?.textContent).toBe('1.0')
    expect(Number(values[0]?.getAttribute('x'))).toBeCloseTo(
      HIST_LABEL_W + PLOT_W + 4,
      6,
    )
  })

  it('без кадров — только подписи: столбиков и значений нет', () => {
    renderWithProviders(<EmoHistogram emo={null} />)
    const root = screen.getByTestId('emo-histogram')
    expect(parts(root, 'hist-label')).toHaveLength(14)
    expect(parts(root, 'hist-bar')).toHaveLength(14) // нулевой столбик на строку
    expect(parts(root, 'hist-value')).toHaveLength(0)
  })
})