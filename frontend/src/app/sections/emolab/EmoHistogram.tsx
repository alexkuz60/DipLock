/**
 * «Общая эмо-характеристика аудио-трека» (шаг 9, 24.10.2026): горизонтальная
 * гистограмма накопленных сумм векторов доминант по 14 текстовым
 * характеристикам настроения (`EMO_LABELS`: «страх» … «агрессия»).
 *
 * Столбики идут **снизу вверх** по шкале «Эмо» (как Y «Эмограммы»), подписи —
 * слева, длина столбика ∝ накопленной сумме (`emoHistogram` из `emogram.ts`),
 * числовое значение — у правого конца столбика (сырые суммы, как в старом
 * EmoLab). Цвет столбика = цвет сектора радара категории (`SECTOR_COLORS`,
 * 2 эмоции на сектор) — согласовано со столбиками «Экспрессии Эмо».
 *
 * Размер полотна — по замеру `ResizeObserver` (приём `Emogram.tsx`; jsdom →
 * дефолт `HIST_VIEW_W`×`HIST_VIEW_H`, тесты видят «честные» пиксели).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEmo } from '@/shared/api/types'
import { SECTOR_COLORS } from '../neuromusic/radialChart'
import { frameRotations, type RotationLaw } from '../neuromusic/keyRotation'
import { hopSeconds } from '../neuromusic/emoRadar'
import { frameTempos } from '../neuromusic/tempoCorrection'
import {
  EMO_LABELS,
  dominantSeries,
  emoHistogram,
} from './emogram'

/** Дефолтная ширина SVG, px (jsdom и до замера `ResizeObserver`). */
export const HIST_VIEW_W = 640

/** Дефолтная высота SVG, px (jsdom и до замера `ResizeObserver`). */
export const HIST_VIEW_H = 200

/** Левое поле — столбец подписей категорий, px. */
export const HIST_LABEL_W = 96

/** Правое поле — столбец числовых значений сумм, px. */
export const HIST_VALUE_W = 48

/** Верхнее/нижнее поле полотна, px. */
export const HIST_PAD_Y = 8

/** Зазор между горизонтальными столбиками, px (смежные категории не слипаются). */
export const HIST_BAR_GAP_PX = 2

export type EmoHistogramProps = {
  /** Кадры «Эмо» (null/undefined — только подписи категорий, столбиков нет). */
  emo?: AudioEmo | null
  /** Значения темпа участвуют в расчёте лучей звезды (темп-коррекция доминант). */
  tempoRays?: boolean
  /** Закон вращения звезды (`keyRotation.ts`): хроматический (дефолт) либо гармонический. */
  rotationLaw?: RotationLaw
}

export function EmoHistogram({
  emo = null,
  tempoRays = true,
  rotationLaw = 'chromatic',
}: EmoHistogramProps) {
  // Размер ячейки: 1 единица viewBox = 1 px экрана (приём `Emogram.tsx`).
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [size, setSize] = useState({ w: HIST_VIEW_W, h: HIST_VIEW_H })
  useEffect(() => {
    const element = svgRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) setSize({ w: rect.width, h: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const frames = emo && Array.isArray(emo.frames) ? emo.frames : null
  const hopSec = emo ? hopSeconds(emo.hop_samples, emo.fs_audio) : 1
  // Доминанты кадров — те же точки, что облако доминант звезды (вращение и
  // темп-коррекция по тем же пропам, что у радара/«Эмограммы»).
  const rows = useMemo(() => {
    if (!frames) return emoHistogram([])
    const rotations = frameRotations(emo?.key_track ?? null, frames, rotationLaw)
    const tempos = frameTempos(emo?.tempo_track ?? null, frames, hopSec)
    return emoHistogram(
      dominantSeries(
        frames.map((frame, index) => ({
          tSec: frame.t_sec,
          rays: frame.rays,
          rotation: rotations[index] ?? 0,
          tempo: tempoRays ? (tempos[index] ?? null) : null,
        })),
      ),
    )
  }, [emo, frames, hopSec, tempoRays, rotationLaw])

  // Геометрия: подписи слева, числа справа, столбики между ними.
  const x0 = HIST_LABEL_W
  const x1 = size.w - HIST_VALUE_W
  const plotW = Math.max(0, x1 - x0)
  const plotH = size.h - 2 * HIST_PAD_Y
  const rowH = plotH / EMO_LABELS.length
  const barH = Math.max(1, rowH - HIST_BAR_GAP_PX)
  const maxValue = rows.reduce((max, row) => Math.max(max, row.value), 0)

  return (
    <svg
      ref={svgRef}
      data-testid="emo-histogram"
      viewBox={`0 0 ${size.w} ${size.h}`}
      style={{ width: '100%', height: '100%' }}
      role="img"
      aria-label="Общая эмо-характеристика аудио-трека: накопленные суммы векторов доминант по 14 характеристикам настроения"
    >
      {/* Строки категорий снизу вверх: «страх» у нижней кромки (как Y «Эмограммы»). */}
      {rows.map((row) => {
        const y = size.h - HIST_PAD_Y - (row.index + 1) * rowH
        const width = maxValue > 0 && row.value > 0 ? (row.value / maxValue) * plotW : 0
        return (
          <g key={row.label}>
            <text
              data-part="hist-label"
              x={HIST_LABEL_W - 8}
              y={y + rowH / 2}
              textAnchor="end"
              dominantBaseline="central"
              className="fill-fg-2 text-[10px]"
            >
              {row.label}
            </text>
            <rect
              data-part="hist-bar"
              x={x0}
              y={y + (rowH - barH) / 2}
              width={width}
              height={barH}
              rx={1}
              fill={SECTOR_COLORS[row.sector] ?? 'var(--color-accent)'}
              fillOpacity={0.65}
            />
            {row.value > 0 && (
              <text
                data-part="hist-value"
                x={x0 + width + 4}
                y={y + rowH / 2}
                dominantBaseline="central"
                className="fill-fg-1 text-[10px] tabular-nums"
              >
                {row.value.toFixed(1)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}