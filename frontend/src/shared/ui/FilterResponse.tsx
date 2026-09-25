/**
 * Блок «АЧХ-отклик» фильтра (шаг 2.5, N11–N14): свёрнут по умолчанию.
 *
 * Правило UI (`docs/rules/frontend-state.md`): правка параметров не запускает
 * запросов. Поэтому блок молчит, пока пользователь не раскроет его кнопкой —
 * только это действие шлёт `GET /filter-response`. Раскрытый блок не следует
 * за правками сам: показывает «параметры изменились» и обновляется по кнопке
 * (семантика «считает только кнопка»). График — статичный SVG с фиксированным
 * `viewBox` (без uPlot и без пересозданий при резайзе, Р4).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, apiErrorText } from '@/shared/api/client'
import type { FilterResponse as FilterResponseResult } from '@/shared/api/types'
import { filterPassportText, responseChart } from '@/shared/lib/filterResponseChart'
import { Button } from './Button'
import { StatusPill } from './StatusPill'

export type FilterResponseProps = {
  /** Полоса пропускания [l, h], Гц; null — без band-pass */
  band: [number, number] | null
  /** Частота notch, Гц; null — выключен */
  notchHz: number | null
  /** Сколько гармоник notch учитывать (0…4) */
  notchHarmonics: number
}

/** Статичный SVG АЧХ: сетка дБ, заливка полосы, метки notch, кривая отклика */
function ResponseChartSvg({ response }: { response: FilterResponseResult }) {
  const geometry = responseChart(response)
  return (
    <svg
      data-testid="filter-response-chart"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      className="w-full"
      role="img"
      aria-label="АЧХ применяемого фильтра"
    >
      {geometry.yTicks.map((tick) => (
        <g key={tick.label}>
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
      {geometry.passband ? (
        <rect
          data-testid="filter-passband"
          x={geometry.passband.x}
          y={0}
          width={geometry.passband.width}
          height={geometry.height}
          fill="var(--color-accent)"
          fillOpacity={0.12}
        />
      ) : null}
      {geometry.notchMarks.map((x, index) => (
        <line
          key={`${x}-${index}`}
          data-testid="filter-notch-mark"
          x1={x}
          x2={x}
          y1={0}
          y2={geometry.height}
          stroke="var(--color-warn)"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      ))}
      <polyline
        data-testid="filter-response-curve"
        points={geometry.points}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={1.5}
      />
      {geometry.xTicks.map((tick) => (
        <text
          key={`${tick.label}-${tick.pos}`}
          x={Math.min(Math.max(tick.pos, 10), geometry.width - 10)}
          y={geometry.height - 2}
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

export function FilterResponse({ band, notchHz, notchHarmonics }: FilterResponseProps) {
  const [open, setOpen] = useState(false)
  /** Подпись параметров последнего явного запроса: правки не перезапрашивают график */
  const [requested, setRequested] = useState<string | null>(null)
  const signature = JSON.stringify([band, notchHz, notchHarmonics])
  const hasFilter = band !== null || notchHz !== null

  const query = useQuery({
    queryKey: ['filter-response', signature],
    queryFn: ({ signal }) => api.filterResponse({ band, notchHz, notchHarmonics }, signal),
    // Запрос — только по явному действию (раскрытие/«Обновить»), не по правке
    enabled: open && hasFilter && requested === signature,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const stale = open && hasFilter && requested !== null && requested !== signature

  return (
    <div className="mt-2" data-testid="filter-response">
      <Button
        variant="ghost"
        aria-expanded={open}
        disabled={!hasFilter}
        title={
          hasFilter
            ? 'АЧХ применяемого фильтра: 0 дБ в полосе пропускания, обрезы переходных полос и провалы notch с гармониками. Считается тем же конвейером, что и сигнал.'
            : 'Задайте полосу и/или notch — без фильтра АЧХ нечего показывать.'
        }
        onClick={() => {
          setOpen((value) => !value)
          if (!open) setRequested(signature) // раскрытие = явное «считать»
        }}
      >
        АЧХ-отклик {open ? '▾' : '▸'}
      </Button>
      {open ? (
        <div className="mt-2 space-y-1">
          {stale ? (
            <div className="flex items-center gap-2">
              <StatusPill
                tone="warn"
                title="Параметры изменились после раскрытия блока. График не пересчитывается сам — нажмите «Обновить» (правило: считает только кнопка)."
              >
                параметры изменились
              </StatusPill>
              <Button variant="ghost" onClick={() => setRequested(signature)}>
                Обновить
              </Button>
            </div>
          ) : null}
          {query.isError && !query.isFetching ? (
            <StatusPill tone="danger" title={apiErrorText(query.error)}>
              АЧХ не посчиталась
            </StatusPill>
          ) : null}
          {query.isFetching ? <p className="text-sm text-fg-2">Считаем АЧХ…</p> : null}
          {query.data ? (
            <>
              <ResponseChartSvg response={query.data} />
              <p className="tnum text-xs text-fg-2" data-testid="filter-response-passport">
                {filterPassportText(query.data)}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}