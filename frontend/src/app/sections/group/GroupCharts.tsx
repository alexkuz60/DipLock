/**
 * Графическая визуализация результатов «Сравнения двух записей» (B9).
 *
 * Все диаграммы — чистая геометрия над числами сервера (`CompareResult`),
 * ничего не пересчитывается на клиенте (та же причина и тот же приём, что
 * у `FftHistogram`): цвета — токены темы, дивергентная пара «рост в B /
 * спад в B» повторяет серверную палитру RdBu_r карт разности (красный —
 * рост, синий — спад), значимость — насыщенностью. «Нет числа — нет линии».
 *
 * Три компонента:
 * - `BandDeltaBar` — ячейка правой колонки таблицы дельт: столбик ΔдБ от
 *   нуля + ус 95% bootstrap-ИИ, строка графика = строка таблицы (шкала
 *   общая для всех строк, `bandDeltaScale`);
 * - `CompareStackChart` — совмещённый график на **общей частотной оси**:
 *   ряд PSD (A/B) → ряд ΔдБ → ряд кластеров → ось X; сквозная сетка и
 *   вертикальный курсор с readout «диапазон · частота · уровень»;
 * - `IndexDumbbell` — стрелка A→B одной строки индексов.
 *
 * **Масштаб — всегда 1:1.** Контейнер меряется `ResizeObserver` (ширина
 * только — правило `docs/rules/frontend-perf.md` п. 3.7, высота — константа),
 * `viewBox` строится в экранных пикселях: шрифты и толщины линий остаются
 * константными при любом размере окна, картинка не растягивается (тот же
 * приём, что у `MriProjection`). Мелкие графики (ячейка таблицы, dumbbell)
 * держат фиксированную CSS-ширину, равную ширине своего viewBox.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompareBand, CompareResult } from '@/shared/api/types'
import { bandLabel, formatPower, psdScale, psdX } from '@/shared/lib/spectrum'
import { formatDb, formatP } from './chartFormat'

/** Рост мощности в B (положительная дельта) — как красный на RdBu_r сервера */
const COLOR_UP = 'var(--color-danger)'
/** Спад мощности в B (отрицательная дельта) — синий на RdBu_r */
const COLOR_DOWN = 'var(--color-accent)'
/** Незначимое / справочное — приглушённо */
const COLOR_MUTED = 'var(--color-fg-2)'

/** Цвет дельты: знак + значимость (нет значения — приглушённо). */
function deltaColor(delta: number | null | undefined, significant: boolean): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return COLOR_MUTED
  if (Math.abs(delta) < 0.05) return COLOR_MUTED
  return significant ? (delta > 0 ? COLOR_UP : COLOR_DOWN) : COLOR_MUTED
}

const BAR_W = 176 // viewBox ячейки «график»
const BAR_H = 18

/**
 * Ячейка правой колонки таблицы дельт: столбик ΔдБ от центральной нулевой
 * линии + ус 95% bootstrap-ИИ, цвет — знак, яркость — значимость (q < α).
 * Значение подписано у кончика столбика: «напротив своей строки».
 */
export function BandDeltaBar({
  band,
  maxAbs,
  alpha,
}: {
  band: CompareBand
  maxAbs: number
  alpha: number
}) {
  const delta = band.delta_db
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return null
  const zeroX = BAR_W / 2
  const plotW = BAR_W / 2 - 14 // запас под подпись значения
  const x = (db: number) => zeroX + (db / maxAbs) * plotW
  const significant = band.q_value !== null && band.q_value !== undefined && band.q_value < alpha
  const color = deltaColor(delta, significant)
  const ci = band.ci95_delta_db
  const yMid = BAR_H / 2
  const tip = Math.max(Math.abs(x(delta) - zeroX), 1.5)
  // Фикс. ширина = viewBox ⇒ 1:1: при w-full колонка растягивала бы
  // столбики и подпись вместе с собой (см. докстринг модуля)
  return (
    <svg
      viewBox={`0 0 ${BAR_W} ${BAR_H}`}
      className="h-[18px] w-44 shrink-0"
      role="img"
      aria-label={`Дельта ${bandLabel(band.name)} ${formatDb(delta)} дБ`}
      data-testid={`compare-band-bar-${band.name}`}
    >
      {/* Нулевая линия шкалы */}
      <line x1={zeroX} y1={2} x2={zeroX} y2={BAR_H - 2} stroke="var(--color-border)" strokeWidth={1} />
      {/* Столбик: минимальная ширина 1.5 px, чтобы нулевая дельта была видна */}
      <rect
        x={delta >= 0 ? zeroX : zeroX - tip}
        y={4}
        width={tip}
        height={BAR_H - 8}
        fill={color}
        opacity={significant ? 1 : 0.55}
        rx={1}
      />
      {/* Ус 95% bootstrap-ИИ */}
      {ci ? (
        <g stroke={color} strokeWidth={1.5} opacity={0.9}>
          <line x1={x(ci[0] ?? 0)} y1={yMid} x2={x(ci[1] ?? 0)} y2={yMid} />
          <line x1={x(ci[0] ?? 0)} y1={4} x2={x(ci[0] ?? 0)} y2={BAR_H - 4} />
          <line x1={x(ci[1] ?? 0)} y1={4} x2={x(ci[1] ?? 0)} y2={BAR_H - 4} />
        </g>
      ) : null}
      {/* Значение напротив строки таблицы */}
      <text
        x={delta >= 0 ? x(delta) + 4 : x(delta) - 4}
        y={BAR_H / 2 + 3}
        fontSize={9}
        textAnchor={delta >= 0 ? 'start' : 'end'}
        fill={color}
        className="tnum"
      >
        {formatDb(delta)}
      </text>
    </svg>
  )
}


/* ─── Совмещённый график: PSD → ΔдБ → кластеры на общей частотной оси ─── */

// Вертикальная геометрия — константы в экранных пикселях (viewBox = пиксели
// контейнера, масштаб 1:1): PSD 150, ΔдБ 100, строка кластера 20, зазоры и
// ось 16 — итого ≈ 366 px при двух кластерах фикстуры.
const PAD_L = 46
const PAD_R = 8
const PAD = 2 // внутренний отступ рядов (та же геометрия, что у psdPolyline)
const PSD_TOP = 8
const PSD_H = 150
const DELTA_TOP = PSD_TOP + PSD_H + 16
const DELTA_H = 100
const CLUST_TOP = DELTA_TOP + DELTA_H + 16
const CLUST_ROW = 20
const AXIS_GAP = 16
/** Запас под подписи тиков оси X (сама подпись «Гц» уже в каждом тике) */
const AXIS_H = 16

/** Лог-координата точки PSD (формула `psdPolyline`, общая для рядов и курсора). */
function psdY(power: number, scale: number, height: number): number {
  const inner = Math.max(1, height - PAD * 2)
  const log = Math.log10(1 + Math.max(0, power))
  return PAD + inner * (1 - log / scale)
}

/** Точка серверной сетки частот, ближайшая к частоте под курсором. */
function nearestIndex(freqs: number[], freq: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < freqs.length; i += 1) {
    const dist = Math.abs(freqs[i] - freq)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

/** Полоса (`freq_bands` из `/meta`), содержащая частоту, либо null. */
function bandAt(
  freqBands: Record<string, number[]> | null | undefined,
  freq: number,
): { key: string; band: number[] } | null {
  if (!freqBands) return null
  for (const [key, band] of Object.entries(freqBands)) {
    if (band.length >= 2 && freq >= band[0] && freq <= band[1]) return { key, band }
  }
  return null
}

export type CompareStackChartProps = {
  result: CompareResult
  /** Полосы `freq_bands` из `/meta` — подпись «Диапазон» под курсором */
  freqBands?: Record<string, number[]> | null
}

/**
 * Совмещённый график на общей частотной оси: ряд PSD обеих сторон → ряд
 * ΔдБ (B − A) → прямоугольники кластеров → ось X. Сквозная вертикальная
 * сетка и курсор: при наведении под графиком — параметры «диапазон
 * (полоса из /meta) · частота · уровень A/B», точки кривых подсвечены.
 * Оси X и Y размечены значениями; шкала PSD логарифмическая (та же
 * формула `log10(1+v)`, что у кривых — подписи тиков честные).
 *
 * Ширина контейнера меряется `ResizeObserver` (заглушка в тестах отдаёт
 * 1024), высота — константа; `viewBox` в пикселях ⇒ масштаб всегда 1:1,
 * при ресайзе окна меняется только ширина поля, не размер шрифтов.
 */
export function CompareStackChart({ result, freqBands = null }: CompareStackChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

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

  const { freqs, psd_mean_a_uv2: psdA, psd_mean_b_uv2: psdB, psd_delta_db: delta } = result
  const clusters = result.stats.clusters ?? []
  const scale = useMemo(() => Math.max(psdScale(psdA), psdScale(psdB)), [psdA, psdB])
  const deltaScale = useMemo(() => Math.max(...delta.map((v) => Math.abs(v)), 0.5), [delta])

  const fMin = freqs[0] ?? 0
  const fMax = freqs[freqs.length - 1] ?? 1
  const plotW = width - PAD_L - PAD_R
  const clustH = clusters.length > 0 ? clusters.length * CLUST_ROW + 4 : 0
  const axisTop = (clusters.length > 0 ? CLUST_TOP + clustH : CLUST_TOP) + AXIS_GAP
  const height = axisTop + AXIS_H

  // Общая ось частот: деления по ширине поля (плотные подписи не наезжают)
  const nTicks = width >= 480 ? 6 : 4
  const xSvg = (freq: number) =>
    PAD_L + PAD + ((freq - fMin) / (fMax - fMin || 1)) * Math.max(1, plotW - PAD * 2)
  const ticks = Array.from({ length: nTicks }, (_, i) => fMin + ((fMax - fMin) / (nTicks - 1)) * i)

  // Тики Y лог-шкалы PSD: декады, попавшие в ряд
  const psdTicks: { v: number; y: number }[] = []
  for (let k = -6; k <= 6; k += 1) {
    const v = 10 ** k
    const y = psdY(v, scale, PSD_H)
    if (y >= PAD && y <= PSD_H - PAD) psdTicks.push({ v, y })
  }

  const handleMove = (clientX: number) => {
    const el = svgRef.current
    if (!el || width < 1) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 1) return // jsdom / нулевой бокс: интерактив не считаем
    // viewBox в пикселях: масштаб ≈1, но пересчёт через rect устойчив к дроби
    const x = ((clientX - rect.left) * width) / rect.width
    if (x < PAD_L || x > width - PAD_R) {
      setHover(null)
      return
    }
    const local = x - PAD_L - PAD
    const freq = fMin + (local / Math.max(1, plotW - PAD * 2)) * (fMax - fMin)
    setHover(nearestIndex(freqs, Math.min(Math.max(freq, fMin), fMax)))
  }

  // Параметры под курсором: диапазон, частота, уровень, кластер
  const readout = (() => {
    if (hover === null) return null
    const freq = freqs[hover]
    const range = bandAt(freqBands, freq)
    const cluster = clusters.find((c) => freq >= c.freq_min_hz && freq <= c.freq_max_hz)
    return {
      range: range
        ? `${bandLabel(range.key)} ${range.band[0]}–${range.band[1]} Гц`
        : 'вне полос',
      freq: `${freq.toFixed(1)} Гц`,
      level: `A ${formatPower(psdA[hover])} · B ${formatPower(psdB[hover])} мкВ²`,
      delta: formatDb(delta[hover]),
      cluster: cluster
        ? `${cluster.freq_min_hz.toFixed(1)}–${cluster.freq_max_hz.toFixed(1)} Гц`
        : null,
    }
  })()

  // До первого замера контейнера чарт не создаём (прецедент HeartRateTrack)
  if (width < 1) return <div ref={wrapRef} className="min-h-40" />

  return (
    <div ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: `${height}px` }}
        className="cursor-crosshair"
        role="img"
        aria-label="PSD двух записей, дельта и кластеры на общей частотной оси"
        data-testid="compare-stack-chart"
        onMouseMove={(event) => handleMove(event.clientX)}
        onMouseLeave={() => setHover(null)}
      >
        {/* Сквозная вертикальная сетка по тикам общей оси X */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={xSvg(tick)}
              y1={PSD_TOP}
              x2={xSvg(tick)}
              y2={axisTop}
              stroke="var(--color-border)"
              strokeWidth={0.5}
            />
            <text
              x={xSvg(tick)}
              y={axisTop + 13}
              fontSize={9}
              textAnchor="middle"
              fill="var(--color-fg-2)"
              className="tnum"
            >
              {`${Math.round(tick)} Гц`}
            </text>
          </g>
        ))}

        {/* Ряд 1: PSD обеих сторон, лог-ось Y с разметкой и сеткой */}
        <g transform={`translate(${PAD_L},${PSD_TOP})`}>
          <rect x={0} y={0} width={plotW} height={PSD_H} fill="none" stroke="var(--color-border)" strokeWidth={0.75} />
          {psdTicks.map((tick) => (
            <g key={tick.v}>
              <line x1={0} y1={tick.y} x2={plotW} y2={tick.y} stroke="var(--color-border)" strokeWidth={0.5} strokeDasharray="2 3" />
              <text x={-4} y={tick.y + 3} fontSize={9} textAnchor="end" fill="var(--color-fg-2)" className="tnum">
                {tick.v >= 1 ? String(tick.v) : String(tick.v)}
              </text>
            </g>
          ))}
          <text x={3} y={10} fontSize={9} fill="var(--color-fg-2)">
            мкВ² (лог)
          </text>
          <polyline
            points={freqs.map((f, i) => `${psdX(f, fMin, fMax, plotW, PAD).toFixed(1)},${psdY(psdA[i], scale, PSD_H).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
          />
          <polyline
            points={freqs.map((f, i) => `${psdX(f, fMin, fMax, plotW, PAD).toFixed(1)},${psdY(psdB[i], scale, PSD_H).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="var(--color-fg-1)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        </g>

        {/* Ряд 2: ΔдБ (B − A) столбиками от нулевой линии */}
        <g transform={`translate(${PAD_L},${DELTA_TOP})`}>
          <rect x={0} y={0} width={plotW} height={DELTA_H} fill="none" stroke="var(--color-border)" strokeWidth={0.75} />
          {[-1, -0.5, 0, 0.5, 1].map((part) => {
            const y = DELTA_H / 2 - part * (DELTA_H / 2 - 8)
            return (
              <g key={part}>
                <line
                  x1={0}
                  y1={y}
                  x2={plotW}
                  y2={y}
                  stroke="var(--color-border)"
                  strokeWidth={part === 0 ? 1 : 0.5}
                  strokeDasharray={part === 0 ? undefined : '2 3'}
                />
                <text x={-4} y={y + 3} fontSize={9} textAnchor="end" fill="var(--color-fg-2)" className="tnum">
                  {formatDb(part * deltaScale)}
                </text>
              </g>
            )
          })}
          <text x={3} y={10} fontSize={9} fill="var(--color-fg-2)">
            дБ
          </text>
          {freqs.map((f, i) => {
            const value = delta[i]
            if (!Number.isFinite(value) || value === 0) return null
            const zeroY = DELTA_H / 2
            const h = Math.max((Math.abs(value) / deltaScale) * (DELTA_H / 2 - 8), 1)
            const bw = Math.max(1, plotW / freqs.length - 1)
            return (
              <rect
                key={f}
                x={psdX(f, fMin, fMax, plotW, PAD) - bw / 2}
                y={value > 0 ? zeroY - h : zeroY}
                width={bw}
                height={h}
                fill={value > 0 ? COLOR_UP : COLOR_DOWN}
                opacity={0.75}
              />
            )
          })}
        </g>


        {/* Ряд 3: кластеры на той же оси частот (слева — подписи p) */}
        {clusters.length > 0 ? (
          <g transform={`translate(${PAD_L},${CLUST_TOP})`}>
            {clusters.map((cluster, index) => {
              const y = index * CLUST_ROW + 3
              const color = cluster.significant
                ? deltaColor(cluster.mean_delta_db, true)
                : COLOR_MUTED
              return (
                <g key={`${cluster.freq_min_hz}-${cluster.freq_max_hz}-${index}`}>
                  <rect
                    x={xSvg(cluster.freq_min_hz) - PAD_L}
                    y={y}
                    width={Math.max(xSvg(cluster.freq_max_hz) - xSvg(cluster.freq_min_hz), 2)}
                    height={CLUST_ROW - 9}
                    rx={3}
                    fill={color}
                    opacity={cluster.significant ? 0.85 : 0.35}
                  />
                  <text x={-4} y={y + 9} fontSize={9} textAnchor="end" fill="var(--color-fg-2)" className="tnum">
                    {cluster.significant ? 'p<α' : `p=${formatP(cluster.p_value)}`}
                  </text>
                </g>
              )
            })}
          </g>
        ) : null}

        {/* Сквозной курсор: линия через все ряды + точки на кривых PSD */}
        {hover !== null ? (
          <g data-testid="compare-cursor" pointerEvents="none">
            <line
              x1={xSvg(freqs[hover])}
              y1={PSD_TOP}
              x2={xSvg(freqs[hover])}
              y2={axisTop}
              stroke="var(--color-event)"
              strokeWidth={1}
            />
            <circle
              cx={xSvg(freqs[hover])}
              cy={PSD_TOP + psdY(psdA[hover], scale, PSD_H)}
              r={3}
              fill="var(--color-accent)"
            />
            <circle
              cx={xSvg(freqs[hover])}
              cy={PSD_TOP + psdY(psdB[hover], scale, PSD_H)}
              r={3}
              fill="var(--color-fg-1)"
            />
          </g>
        ) : null}
      </svg>

      {/* Параметры под курсором: диапазон · частота · уровень */}
      <p
        className="tnum mt-1 min-h-5 text-sm text-fg-1"
        data-testid="compare-cursor-readout"
        aria-live="polite"
      >
        {readout
          ? `Диапазон: ${readout.range} · Частота: ${readout.freq} · Уровень: ${readout.level} · Δ ${readout.delta} дБ${readout.cluster ? ` · Кластер: ${readout.cluster}` : ''}`
          : 'Наведите курсор на график: диапазон, частота и уровень под линией.'}
      </p>
    </div>
  )
}

/**
 * Стрелка A→B для одной строки индексов: нормированная шкала между
 * минимумом и максимумом пары значений (если равны — точка в центре),
 * цвет — направление Δ («dumbbell»: видно и величину, и знак).
 */
export function IndexDumbbell({
  a,
  b,
}: {
  a: number | null | undefined
  b: number | null | undefined
}) {
  if (a === null || a === undefined || b === null || b === undefined) return null
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const span = hi - lo
  // Шкала с 10% запасом по краям; равные значения — точка в центре
  const min = span > 0 ? lo - span * 0.1 : lo - Math.abs(lo) * 0.1 - 1
  const max = span > 0 ? hi + span * 0.1 : hi + Math.abs(hi) * 0.1 + 1
  const pos = (value: number) => ((value - min) / (max - min || 1)) * 84 + 8
  const up = b >= a
  const color = span > 0 ? (up ? COLOR_UP : COLOR_DOWN) : COLOR_MUTED
  // Ширина = viewBox ⇒ масштаб 1:1 (w-24 = 96px сжимал X до 0.96)
  return (
    <svg
      viewBox="0 0 100 16"
      className="h-4 w-[100px]"
      role="img"
      aria-label={`Сдвиг ${a.toFixed(2)} → ${b.toFixed(2)}`}
      data-testid="compare-dumbbell"
    >
      <line x1={8} y1={8} x2={92} y2={8} stroke="var(--color-border)" strokeWidth={1} />
      <line x1={pos(a)} y1={8} x2={pos(b)} y2={8} stroke={color} strokeWidth={2.5} />
      <circle cx={pos(a)} cy={8} r={3.5} fill="var(--color-accent)" />
      <circle cx={pos(b)} cy={8} r={3.5} fill={color} />
    </svg>
  )
}

