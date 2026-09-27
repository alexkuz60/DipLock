/**
 * Блок «Сетевой фон» (Части 1 §7): свёрнут по умолчанию, как «АЧХ-отклик».
 *
 * Показывает два разных ответа про notch: уровни линий сети над фоном PSD
 * (`level_db`, метрика L1 — «есть ли наводка в записи вообще») и саму
 * вырезанную компоненту `x − notch(x)` за окно (`trace_uv`). Правило UI
 * (`docs/rules/frontend-state.md`): запрос шлёт только явное раскрытие,
 * раскрытый блок не следует за правками сам — «параметры изменились» +
 * кнопка «Обновить». График — статичный SVG с фиксированным `viewBox`
 * (без uPlot, без пересозданий при резайзе, Р4).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, apiErrorText } from '@/shared/api/client'
import type { MainsResponse } from '@/shared/api/types'
import { mainsChart, mainsLevelsText } from '@/shared/lib/mainsChart'
import { Button } from './Button'
import { StatusPill } from './StatusPill'

export type MainsTraceProps = {
  /** Идентификатор записи (`null` — нет живой записи: демо/закрыта) */
  recordingId: string | null
  /** Частота notch, Гц; null — выключен */
  notchHz: number | null
  /** Сколько гармоник notch учитывать (0…4) */
  notchHarmonics: number
}

/** Статичный SVG трассы: нулевая линия, тики времени и амплитуды, кривая */
function MainsChartSvg({ mains }: { mains: MainsResponse }) {
  const geometry = mainsChart(mains)
  return (
    <svg
      data-testid="mains-chart"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      className="w-full"
      role="img"
      aria-label={`Вырезанная сетевая компонента, канал ${mains.channel}`}
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
      <polyline
        data-testid="mains-trace"
        points={geometry.points}
        fill="none"
        stroke="var(--color-warn)"
        strokeWidth={1}
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

export function MainsTrace({ recordingId, notchHz, notchHarmonics }: MainsTraceProps) {
  const [open, setOpen] = useState(false)
  /** Подпись параметров последнего явного запроса: правки не перезапрашивают */
  const [requested, setRequested] = useState<string | null>(null)
  const signature = JSON.stringify([recordingId, notchHz, notchHarmonics])
  const hasParams = recordingId !== null && notchHz !== null

  const query = useQuery({
    queryKey: ['mains', signature],
    queryFn: ({ signal }) =>
      api.mains(recordingId as string, { notchHz: notchHz as number, notchHarmonics }, signal),
    // Запрос — только по явному действию (раскрытие/«Обновить»), не по правке
    enabled: open && hasParams && requested === signature,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const stale = open && hasParams && requested !== null && requested !== signature

  return (
    <div className="mt-2" data-testid="mains">
      <Button
        variant="ghost"
        aria-expanded={open}
        disabled={!hasParams}
        title={
          hasParams
            ? 'Что вырезает режектор: уровни линий сети над фоном записи (дБ) и сама вырезанная компонента во времени. Считается на сигнале до полосового фильтра.'
            : 'Включите notch и откройте живую запись — без них вырезать нечего.'
        }
        onClick={() => {
          setOpen((value) => !value)
          if (!open) setRequested(signature) // раскрытие = явное «считать»
        }}
      >
        Сетевой фон {open ? '▾' : '▸'}
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
              сетевой фон не посчитался
            </StatusPill>
          ) : null}
          {query.isFetching ? <p className="text-sm text-fg-2">Считаем сетевой фон…</p> : null}
          {query.data ? (
            <>
              <MainsChartSvg mains={query.data} />
              <p className="tnum text-xs text-fg-2" data-testid="mains-levels">
                L1 (над фоном PSD): {mainsLevelsText(query.data)}
              </p>
              <p className="tnum text-xs text-fg-2" data-testid="mains-passport">
                Канал {query.data.channel}, окно {query.data.start_sec}…{' '}
                {(query.data.start_sec + query.data.duration_sec).toFixed(1)} с; вырезано RMS{' '}
                {query.data.removed_rms_uv} мкВ — трасса показывает только notch-цепочку
                {query.data.notch_harmonics > 0
                  ? ` (${query.data.freqs_hz.join('/') } Гц)`
                  : ` (${query.data.notch_hz} Гц)`}
                , без полосового фильтра.
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
