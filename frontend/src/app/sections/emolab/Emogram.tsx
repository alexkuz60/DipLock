/**
 * График «Эмограмма» секции «ЕмоЛаб» (постановка владельца 21.10.2026):
 * лучи полигона-звезды, развернутые по шкале времени аудиотрека. Живёт в
 * табе «Эмограмма» секции «Визуализация» (табы `EmoLabSection`: «Звезда» /
 * «Эмограмма» / дальше) и строится из тех же доминант кадров «Эмо»
 * (динамический диапазон `dbRangeDb`, вращение по аккордам, темп-коррекция
 * `tempoRays` — пропы «ЕмоЛаб», как у `RadialChart`).
 *
 * Ось Y справа «Эмо» — 14 подписей снизу вверх (страх → агрессия) и 14
 * горизонтальных линий разметки с шагом π/7 по углу (математика —
 * `emogram.ts`); внизу — вертикали и подписи шкалы времени звучания.
 * В пространстве графика два ряда (`data-part`):
 *
 * * **Экспрессия Эмо** (`express-bar`) — вертикальные столбики от низа до
 *   радиус-вектора доминанты кадра (0…1 динамического диапазона), зазор
 *   `EMO_BAR_GAP_PX`, цвет = сектор Эмо угла доминанты (правка владельца),
 *   35 % прозрачности — ступень «Динамики» читается поверх;
 * * **Динамика Эмо** (`emo-step`) — горизонтальные линии-ступени длиной 1 с
 *   (1 кадр анимации звезды) на высоте угла доминанты, цвет = цвет сектора
 *   радара этого угла (`radialChart.SECTOR_COLORS`);
 * * **Сегменты трека** (`segment-line`/`segment-label`) — вертикали начала
 *   каждого сегмента VAMP Segmenter с меткой имени (A, B, C…) у верха
 *   (визуально-слуховой контроль «ЕмоЛаб», в расчётах не участвуют;
 *   метки разреживаются по `SEGMENT_LABEL_MIN_PX`, как на волне плеера).
 *
 * Курсор позиции плеера (`playhead`) — вертикаль по `getActivePlayer().position`,
 * пишется императивно через ref в `rAF` (без ре-рендеров React, приём
 * `RadialChart.tsx`, `docs/rules/frontend-perf.md`). Разметка и подписи —
 * статика; без кадров — только сетка. Ширина/высота — по замеру
 * `ResizeObserver` (jsdom → дефолт `EMO_VIEW_W`×`EMO_VIEW_H`).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEmo } from '@/shared/api/types'
import { timeTicks } from '@/shared/lib/eegView'
import { SEGMENT_LABEL_MIN_PX, formatTime } from '@/shared/lib/waveformView'
import { getActivePlayer } from '@/shared/state/neuromusicPlayer'
import { framesDbRange, hopSeconds } from '../neuromusic/emoRadar'
import { frameRotations } from '../neuromusic/keyRotation'
import { SECTOR_COLORS } from '../neuromusic/radialChart'
import { frameTempos } from '../neuromusic/tempoCorrection'
import {
  EMO_BAR_GAP_PX,
  EMO_LABEL_W,
  EMO_LABELS,
  EMO_PAD_LEFT,
  EMO_PAD_TOP,
  EMO_TIME_H,
  EMO_VIEW_H,
  EMO_VIEW_W,
  dominantSeries,
  emoBars,
  emoSteps,
  emoTimeX,
} from './emogram'

export type EmogramProps = {
  /** Кадры «Эмо» (null — только сетка и подписи шкал). */
  emo?: AudioEmo | null
  /** Динамический диапазон шкалы лучей, дБ (0 — шкала контракта `db_floor`). */
  dbRangeDb?: number
  /** Значения темпа участвуют в расчёте лучей звезды (темп-коррекция). */
  tempoRays?: boolean
}

export function Emogram({ emo = null, dbRangeDb = 0, tempoRays = true }: EmogramProps) {
  // Размер ячейки: 1 единица viewBox = 1 px экрана (приём `RadialChart.tsx`);
  // в jsdom раскладки нет (rect = 0) — остаются дефолтные размеры, и тесты
  // видят «честные» пиксели.
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [size, setSize] = useState({ w: EMO_VIEW_W, h: EMO_VIEW_H })
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
  const frameSec = hopSec > 0 ? hopSec : 1
  // Динамический диапазон: лучи переносятся тем же местом, что у звезды
  // (`emoRadar.framesDbRange`) — столбики и ступени читают шкалу радара.
  const scaledFrames = useMemo(
    () => (frames ? framesDbRange(frames, Number(emo?.db_floor), dbRangeDb) : null),
    [frames, emo, dbRangeDb],
  )
  const rotations = useMemo(
    () => frameRotations(emo?.key_track ?? null, frames ?? []),
    [emo, frames],
  )
  const tempos = useMemo(
    () => frameTempos(emo?.tempo_track ?? null, frames ?? [], hopSec),
    [emo, frames, hopSec],
  )
  // Доминанты кадров = облако доминант звезды (вращение и темп-коррекция по
  // тем же пропам) — серия для обоих графиков Эмограммы.
  const series = useMemo(
    () =>
      scaledFrames
        ? dominantSeries(
            scaledFrames.map((frame, index) => ({
              tSec: frame.t_sec,
              rays: frame.rays,
              rotation: rotations[index] ?? 0,
              tempo: tempoRays ? (tempos[index] ?? null) : null,
            })),
          )
        : [],
    [scaledFrames, rotations, tempos, tempoRays],
  )
  const bars = useMemo(() => emoBars(series, frameSec), [series, frameSec])
  const steps = useMemo(() => emoSteps(series, frameSec), [series, frameSec])

  // Геометрия полотна: правый столбец — подписи шкалы Y «Эмо», низ — шкала
  // времени звучания аудио.
  const x0 = EMO_PAD_LEFT
  const x1 = size.w - EMO_LABEL_W
  const y0 = EMO_PAD_TOP
  const y1 = size.h - EMO_TIME_H
  const plotW = x1 - x0
  const plotH = y1 - y0

  // Шкала времени: [0 … duration_s контракта]; хвост (нет значения) — до
  // последнего кадра плюс кадр.
  const durationSec = useMemo(() => {
    const declared = Number(emo?.duration_s)
    if (Number.isFinite(declared) && declared > 0) return declared
    const last = frames?.[frames.length - 1]?.t_sec ?? 0
    return last + frameSec
  }, [emo, frames, frameSec])

  // Сегменты трека (VAMP Segmenter, «ЕмоЛаб»): x-позиции вертикалей и меток
  // имён A, B, C…; метки разреживаются по SEGMENT_LABEL_MIN_PX — та же
  // механика, что `waveformView.drawSegmentLines` на волне плеера.
  const segments = emo && Array.isArray(emo.segment_track) ? emo.segment_track : null
  const segmentMarks = useMemo(() => {
    if (!segments) return []
    let lastLabelX = Number.NEGATIVE_INFINITY
    return segments.map((segment) => {
      const x = emoTimeX(segment.t_sec, durationSec, plotW)
      const withLabel = x >= lastLabelX + SEGMENT_LABEL_MIN_PX
      if (withLabel) lastLabelX = x
      return { x, name: segment.name, withLabel }
    })
  }, [segments, durationSec, plotW])

  // Деления времени: круглые секунды (`eegView.timeTicks`), подписи — м:СС
  // трекера (`formatTime`), как у линейки волны.
  const ticks = timeTicks(0, durationSec, plotW, 6)

  // Курсор позиции плеера: rAF читает `getActivePlayer().position` и пишет
  // x1/x2 вертикали императивно (без ре-рендеров на каждый кадр).
  const cursorRef = useRef<SVGLineElement | null>(null)
  useEffect(() => {
    if (!emo) return
    let raf = 0
    const tick = () => {
      const position = getActivePlayer()?.position ?? 0
      const x = x0 + emoTimeX(position, durationSec, plotW)
      const line = cursorRef.current
      if (line) {
        line.setAttribute('x1', String(x))
        line.setAttribute('x2', String(x))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emo, durationSec, x0, plotW])

  return (
    <div data-testid="emogram" className="flex min-h-0 w-full flex-1 flex-col">
      {/* Легенда двух рядов графика (владелец назвал их «Экспрессия Эмо» и
          «Динамика Эмо») + заголовок шкалы Y справа. Оба ряда — гамма
          секторов Эмо (столбики и ступени красятся цветом своего сектора). */}
      <div className="flex items-center gap-4 px-1 text-xs text-fg-2">
        <span data-testid="emogram-legend-express" className="flex items-center gap-1">
          <span className="inline-flex">
            {SECTOR_COLORS.map((color, index) => (
              <span key={index} className="inline-block h-2 w-1.5" style={{ background: color }} />
            ))}
          </span>
          Экспрессия Эмо
        </span>
        <span data-testid="emogram-legend-dynamics" className="flex items-center gap-1">
          <span className="inline-flex">
            {SECTOR_COLORS.map((color, index) => (
              <span key={index} className="inline-block h-2 w-1.5" style={{ background: color }} />
            ))}
          </span>
          Динамика Эмо
        </span>
        <span className="ml-auto">Эмо</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.w} ${size.h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Эмограмма: экспрессия и динамика эмо по шкале времени звучания"
        className="min-h-0 w-full flex-1"
      >
        {/* 14 горизонтальных линий разметки эмо-реакции: шаг π/7 по углу
            (14 · π/7 = 2π), линия i — на высоте i/14 («страх» внизу). */}
        {EMO_LABELS.map((label, index) => {
          const y = y1 - (index / EMO_LABELS.length) * plotH
          return (
            <g key={label}>
              <line
                data-part="emo-grid"
                x1={x0}
                y1={y}
                x2={x1}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text
                data-part="emo-label"
                x={x1 + 6}
                y={y}
                dominantBaseline="middle"
                fontSize={9}
                fill="var(--color-fg-2)"
              >
                {label}
              </text>
            </g>
          )
        })}
        {/* Вертикали и подписи шкалы времени звучания аудио. */}
        {ticks.map((tick) => (
          <g key={tick.timeSec}>
            <line
              data-part="emo-time-grid"
              x1={x0 + tick.x}
              y1={y0}
              x2={x0 + tick.x}
              y2={y1}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              data-part="emo-time-label"
              x={x0 + tick.x}
              y={y1 + 13}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-fg-2)"
            >
              {formatTime(tick.timeSec)}
            </text>
          </g>
        ))}
        {/* Рамка графика. */}
        <rect
          data-part="emo-frame"
          x={x0}
          y={y0}
          width={plotW}
          height={plotH}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        {/* 1. Экспрессия Эмо: вертикальные столбики от низа до радиус-вектора
            доминанты кадра (0…1 динамического диапазона) — цветом сектора Эмо
            её угла (правка владельца: как ступень кадра), 35 % прозрачности —
            ступень «Динамики» читается поверх. */}
        {bars.map((bar) => {
          const height = bar.height * plotH
          return (
            <rect
              key={bar.tSec}
              data-part="express-bar"
              x={x0 + emoTimeX(bar.tSec, durationSec, plotW)}
              y={y1 - height}
              width={Math.max(1, (bar.lenSec / (durationSec || 1)) * plotW - EMO_BAR_GAP_PX)}
              height={height}
              fill={SECTOR_COLORS[bar.sector] ?? 'var(--color-accent)'}
              fillOpacity={0.35}
            />
          )
        })}
        {/* 2. Динамика Эмо: ступени длиной 1 с (кадр звезды) на высоте угла
            доминанты; цвет — сектор радара этого угла. */}
        {steps.map((step) => (
          <line
            key={step.tSec}
            data-part="emo-step"
            x1={x0 + emoTimeX(step.tSec, durationSec, plotW)}
            y1={y1 - step.yFrac * plotH}
            x2={x0 + emoTimeX(step.tSec + step.lenSec, durationSec, plotW)}
            y2={y1 - step.yFrac * plotH}
            stroke={SECTOR_COLORS[step.sector] ?? 'var(--color-fg-1)'}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* 3. Сегменты трека (VAMP Segmenter, «ЕмоЛаб»): вертикали начала
            каждого сегмента с меткой имени (A, B, C…) у верха — данные
            визуально-слухового контроля, в расчётах не участвуют. */}
        {segmentMarks.map((mark, index) => (
          <g key={index}>
            <line
              data-part="segment-line"
              x1={x0 + mark.x}
              y1={y0}
              x2={x0 + mark.x}
              y2={y1}
              stroke="var(--color-nm-segment)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {mark.withLabel && (
              <text
                data-part="segment-label"
                x={x0 + mark.x + 3}
                y={y0 + 10}
                fontSize={10}
                fill="var(--color-nm-segment)"
              >
                {mark.name}
              </text>
            )}
          </g>
        ))}
        {/* Курсор позиции плеера (верхний слой): rAF двигает через ref. */}
        <line
          ref={cursorRef}
          data-part="playhead"
          x1={x0}
          y1={y0}
          x2={x0}
          y2={y1}
          stroke="var(--color-accent)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}