/**
 * Один трек вьюера ЭЭГ: uPlot-чарт канала с огибающей min/max.
 *
 * Вынесен из `TrackStack.tsx` (правило `docs/rules/frontend-state.md` п.6): стек
 * отвечает за окно, зум, панорамирование и слои, а строка — за свой чарт.
 * Расчёт огибающей и опции чарта — чистые функции (`shared/lib/viewerMath.ts`,
 * `shared/lib/trackOptions.ts`), здесь только жизненный цикл uPlot:
 *
 * * чарт создаётся при смене канала/размера/режима шкалы (окно и данные
 *   применяются отдельными эффектами — дешевле, чем пересоздание);
 * * canvas отдаётся наружу через `onCanvas` — из них собирается PNG-снапшот
 *   (срез 2.8), поэтому холст обязан быть тем же, что видит пользователь;
 * * подпись канала — кнопка перехода в раздел «ЭЭГ», стрелка под ней —
 *   разворот трека на всю высоту области (срез 2.9).
 */
import { useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { frameEnvelope, pointsBudget, type TimeWindow } from '@/shared/lib/viewerMath'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import { perfCount } from '@/shared/lib/perf'
import { LABEL_WIDTH, makeTrackOptions, yRangeFor } from '@/shared/lib/trackOptions'
import { cx } from '@/shared/ui/cx'

export type TrackRowProps = {
  name: string
  frame: SignalFrame
  window: TimeWindow
  width: number
  /** Высота трека: обычная или высота видимой области у развёрнутого (срез 2.9) */
  height: number
  /** Трек развёрнут на всю высоту области */
  expanded: boolean
  amplitudeMode: 'shared' | 'per_channel'
  amplitudeScaleUv: number
  showXAxis: boolean
  /** Клик по названию канала — открыть его в разделе «ЭЭГ» (срез 5) */
  onLabelClick: (name: string) => void
  /** Клик по стрелке у названия — развернуть/свернуть трек (срез 2.9) */
  onToggleExpand: (name: string) => void
  /** Отдаёт наружу canvas трека: из них собирается PNG-снапшот (срез 2.8) */
  onCanvas: (name: string, canvas: HTMLCanvasElement | null) => void
}

export function TrackRow({
  name,
  frame,
  window,
  width,
  height,
  expanded,
  amplitudeMode,
  amplitudeScaleUv,
  showXAxis,
  onLabelClick,
  onToggleExpand,
  onCanvas,
}: TrackRowProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<uPlot | null>(null)

  const env = useMemo(() => {
    // Счётчик пересчёта огибающей — замер P4 (`docs/rules/frontend-perf.md`):
    // он должен расти при смене окна, а не при каждом рендере стека
    perfCount('edf.envelope.recompute')
    return frameEnvelope(
      frame.times,
      frame.min[name] ?? [],
      frame.max[name] ?? [],
      window,
      pointsBudget(width),
      frame.decimated,
    )
  }, [frame, name, window, width])
  /**
   * Диапазон оси Y считается по видимой огибающей, а не оставляется uPlot:
   * в режиме «по каналу» шкала обязана ужиматься под амплитуду конкретного
   * канала (иначе слабые каналы выглядят прямой линией). Считается чистой
   * функцией `yRangeFor` — покрыто `trackOptions.test.ts`.
   */
  const yRange = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < env.min.length; i++) {
      if (env.min[i] < lo) lo = env.min[i]
      if (env.max[i] > hi) hi = env.max[i]
    }
    return yRangeFor(amplitudeMode, amplitudeScaleUv, lo, hi)
  }, [env, amplitudeMode, amplitudeScaleUv])

  /** Есть ли размер области: до первого замера `ResizeObserver` чарт не создаём */
  const sized = width > 0 && height > 0

  /*
    Создание чарта — только при смене канала и признака оси времени. Размер и
    шкала Y применяются **отдельными эффектами** (`setSize` / `setScale`), а не
    пересозданием: раньше ресайз окна и переключение режима шкалы собирали заново
    все 18+ чартов стека (`docs/rules/frontend-perf.md`, правило Р4).
    `sized` в зависимостях — потому что до замера области размер нулевой, и без
    этого признака чарт не появился бы вовсе (эффект больше не реагирует на
    `width`).
  */
  useEffect(() => {
    const host = hostRef.current
    if (!host || !sized) return
    perfCount('edf.chart.create')
    const chart = new uPlot(
      makeTrackOptions(width, height, window, yRange, showXAxis),
      [[], [], []] as uPlot.AlignedData,
      host,
    )
    chartRef.current = chart
    // uPlot рисует сигнал в canvas — только его можно склеить в PNG-снапшот
    onCanvas(name, chart.ctx?.canvas ?? null)
    return () => {
      chart.destroy()
      chartRef.current = null
      onCanvas(name, null)
    }
    // Канал и ось времени — в зависимостях; размер/шкала/окно обновляются ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, showXAxis, sized])

  useEffect(() => {
    if (!sized) return
    chartRef.current?.setSize({ width, height })
  }, [width, height, sized])

  useEffect(() => {
    chartRef.current?.setScale('y', { min: yRange[0], max: yRange[1] })
  }, [yRange])

  useEffect(() => {
    chartRef.current?.setData([env.times, env.min, env.max] as uPlot.AlignedData, false)
    chartRef.current?.setScale('x', { min: window.t0, max: window.t1 })
  }, [env, window])

  return (
    <div
      className="flex items-stretch gap-1"
      data-testid={`track-${name}`}
      style={{ height }}
    >
      <div
        className="flex shrink-0 flex-col items-end justify-center"
        style={{ width: LABEL_WIDTH }}
      >
        <button
          type="button"
          data-testid={`track-label-${name}`}
          aria-label={`Открыть канал ${name} в разделе «ЭЭГ»`}
          title={`Открыть канал ${name} в разделе «ЭЭГ»: трек и спектрограмма STFT`}
          onClick={() => onLabelClick(name)}
          className="tnum w-full cursor-pointer truncate rounded text-right font-mono text-xs text-fg-2 hover:text-fg-0"
        >
          {name}
        </button>
        <button
          type="button"
          data-testid={`track-expand-${name}`}
          data-expanded={expanded}
          aria-pressed={expanded}
          aria-label={expanded ? `Свернуть трек ${name}` : `Развернуть трек ${name}`}
          title={expanded ? 'Свернуть трек' : 'Развернуть трек на всю высоту'}
          onClick={() => onToggleExpand(name)}
          className={cx(
            'cursor-pointer rounded p-0.5',
            expanded ? 'text-accent' : 'text-fg-2 hover:bg-bg-3 hover:text-fg-0',
          )}
        >
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      <div ref={hostRef} className="pointer-events-none min-w-0 flex-1" />
    </div>
  )
}
