/** График ERP-волны канала (шаг 2.7): статичный SVG с фиксированным viewBox (Р4). */
import type { EvokedResult } from '@/shared/api/types'
import { evokedChart } from '@/shared/lib/evokedChart'

export function EvokedChart({
  result,
  channel,
}: {
  result: EvokedResult
  /** Канал, волну которого показываем (остальные — в `result.data_uv`) */
  channel: string
}) {
  const index = Math.max(0, result.channels.indexOf(channel))
  const data = result.data_uv[index] ?? []
  const geometry = evokedChart(result.times, data)

  return (
    <svg
      data-testid="evoked-chart"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      className="w-full"
      role="img"
      aria-label={`ERP-волна канала ${channel} по событию ${result.event_id}`}
    >
      {geometry.yTicks.map((tick) => (
        <g key={`y-${tick.label}`}>
          <line
            x1={0}
            x2={geometry.width}
            y1={tick.pos}
            y2={tick.pos}
            stroke="var(--color-border)"
            strokeWidth={0.5}
          />
          <text x={2} y={tick.pos - 2} fontSize={8} fill="var(--color-fg-2)">
            {tick.label}
          </text>
        </g>
      ))}
      {/* Момент события (t=0): кривая ERP читается относительно стимула */}
      <line
        data-testid="evoked-zero"
        x1={geometry.zeroX}
        x2={geometry.zeroX}
        y1={0}
        y2={geometry.height - 18}
        stroke="var(--color-event)"
        strokeDasharray="4 3"
        strokeWidth={1}
      />
      <polyline
        data-testid="evoked-wave"
        points={geometry.polyline}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
      />
      {geometry.xTicks.map((tick) => (
        <text
          key={`x-${tick.label}`}
          x={tick.pos}
          y={geometry.height - 6}
          fontSize={8}
          textAnchor="middle"
          fill="var(--color-fg-2)"
        >
          {tick.label}
        </text>
      ))}
    </svg>
  )
}
