/**
 * Тепловая карта «BA × сессии» (§3.5): строки агрегата × колонки-записи.
 *
 * Чистый SVG над числами сервера (`GroupAggregateOut`): ячейка — доля
 * точек **своей** записи, попавших в строку (единственная величина,
 * сравнимая между записями с разным числом эпох — подпись `notes`
 * сервера). Шкала линейная 0..max по всей матрице, цвет — токен
 * `--color-accent` насыщенностью (последовательная палитра: чем больше
 * доли, тем ярче).
 *
 * **Масштаб — всегда 1:1 с контейнером** (правило
 * `docs/rules/frontend-perf.md` п. 3.7, приём `CompareStackChart`):
 * ширина меряется `ResizeObserver`, `viewBox` строится в экранных
 * пикселях — шрифты не растягиваются; высота — константа строки
 * (заголовок под углом + число строк). Рендер начинается после первого
 * замера (ширина 0 — пустышка, как у `HeartRateTrack`).
 */
import { useEffect, useRef, useState } from 'react'
import type { GroupParticipant, GroupRow } from '@/shared/api/types'

/** Левая колонка подписей строк (имена структур длинные). */
const LABEL_W = 184
/** Высота шапки: подписи колонок под −45°. */
const HEADER_H = 96
/** Высота строки карты. */
const ROW_H = 22
/** Отступ справа/снизу. */
const PAD = 8
/** Колонка-запись уже этой ширины не сжимается. */
const MIN_COL_W = 56

export type GroupHeatmapProps = {
  rows: GroupRow[]
  participants: GroupParticipant[]
  /** Подпись карты: полоса расчёта. */
  caption: string
}

export function GroupHeatmap({ rows, participants, caption }: GroupHeatmapProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      setWidth(Math.max(0, Math.floor(rect?.width ?? 0)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const columns = participants.length
  const height = HEADER_H + rows.length * ROW_H + PAD
  const colWidth = Math.max(
    MIN_COL_W,
    columns > 0 ? (width - LABEL_W - PAD) / columns : MIN_COL_W,
  )
  // Общая шкала: максимум доли по всей матрице (карта сравнивает ячейки)
  let maxShare = 0
  for (const row of rows) {
    for (const cell of row.cells ?? []) {
      if (cell.share > maxShare) maxShare = cell.share
    }
  }

  if (width < 1 || columns === 0) {
    return <div ref={wrapRef} className="min-h-24" data-testid="group-heatmap-placeholder" />
  }

  return (
    <div ref={wrapRef} data-testid="group-heatmap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: `${height}px` }}
        role="img"
        aria-label={`Тепловая карта «BA × сессии», полоса ${caption}`}
      >
        {/* Подписи колонок-записей под −45° */}
        {participants.map((participant, index) => {
          const x = LABEL_W + index * colWidth + colWidth / 2
          const label = participant.filename ?? participant.recording_id
          return (
            <text
              key={participant.recording_id}
              x={x}
              y={HEADER_H - 8}
              transform={`rotate(-45 ${x} ${HEADER_H - 8})`}
              textAnchor="start"
              fontSize={11}
              fill="var(--color-fg-1)"
            >
              {label.length > 22 ? `${label.slice(0, 21)}…` : label}
            </text>
          )
        })}
        {rows.map((row, rowIndex) => {
          const y = HEADER_H + rowIndex * ROW_H
          return (
            <g key={`${row.name}-${rowIndex}`}>
              <text
                x={0}
                y={y + ROW_H - 7}
                fontSize={11}
                fill="var(--color-fg-0)"
              >
                {row.name.length > 26 ? `${row.name.slice(0, 25)}…` : row.name}
              </text>
              {participants.map((participant, colIndex) => {
                const cell = (row.cells ?? []).find(
                  (item) => item.recording_id === participant.recording_id,
                )
                const share = cell?.share ?? 0
                const intensity = maxShare > 0 ? share / maxShare : 0
                const x = LABEL_W + colIndex * colWidth
                return (
                  <g key={participant.recording_id}>
                    <rect
                      x={x + 1}
                      y={y + 1}
                      width={colWidth - 2}
                      height={ROW_H - 2}
                      rx={3}
                      fill="var(--color-accent)"
                      fillOpacity={intensity === 0 ? 0 : 0.15 + 0.85 * intensity}
                      stroke="var(--color-border)"
                      strokeWidth={0.5}
                    />
                    {cell && cell.count > 0 ? (
                      <text
                        x={x + colWidth / 2}
                        y={y + ROW_H - 7}
                        textAnchor="middle"
                        fontSize={10}
                        fill={
                          intensity > 0.55
                            ? 'var(--color-bg-1)'
                            : 'var(--color-fg-1)'
                        }
                      >
                        {`${(share * 100).toFixed(0)}%`}
                      </text>
                    ) : null}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      <p className="mt-1 text-xs text-fg-2">
        {`Доля точек записи в строке (0…${(maxShare * 100).toFixed(0)} %), полоса ${caption}. Пустая ячейка — точек нет.`}
      </p>
    </div>
  )
}
