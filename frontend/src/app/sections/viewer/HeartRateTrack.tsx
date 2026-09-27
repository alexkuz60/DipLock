/**
 * Трек ЧСС (пульс) в стеке вьюера: ряд стадии `artifacts`, извлечённый из
 * височных отведений единым QRS-детектором бэкенда (`services/cardio.py`).
 *
 * Отдельный тип трека, а не канал: своя шкала (уд/мин вместо мкВ), линия с
 * разрывами (`bpm[i] === null` — окна без RR, uPlot не соединяет пропуски),
 * подпись «ЧСС» вместо имени электрода. Жесты стека (курсор, панорамирование,
 * прокрутка) общие: хост чарта, как и у каналов, с `pointer-events: none`.
 *
 * Canvas регистрируется под `HEART_RATE_TRACK_NAME` — по нему трек попадает в
 * PNG-снапшот окна (`ExportActions`, `extraTracks`); в CSV каналы не входят —
 * там только отсчёты ЭЭГ (`windowCsv`).
 */
import { useEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { perfCount } from '@/shared/lib/perf'
import type { HeartRateSeries } from '@/shared/lib/viewerLayers'
import type { TimeWindow } from '@/shared/lib/viewerMath'
import {
  LABEL_WIDTH,
  heartRateRange,
  makeHeartRateOptions,
} from '@/shared/lib/trackOptions'

/** Имя трека ЧСС: ключ canvas в PNG-экспорте и подпись в снапшоте окна */
export const HEART_RATE_TRACK_NAME = 'ЧСС'

export type HeartRateTrackProps = {
  series: HeartRateSeries
  window: TimeWindow
  /** Ширина области треков (та же геометрия, что у каналов и слоёв) */
  width: number
  height: number
  /** Ось времени — только у последнего трека стека */
  showXAxis: boolean
  /** Отдаёт наружу canvas трека для PNG-снапшота (как у каналов) */
  onCanvas: (name: string, canvas: HTMLCanvasElement | null) => void
}

export function HeartRateTrack({
  series,
  window,
  width,
  height,
  showXAxis,
  onCanvas,
}: HeartRateTrackProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<uPlot | null>(null)

  const yRange = useMemo(() => heartRateRange(series.bpm), [series])
  const data = useMemo(
    () => [series.timesSec, series.bpm] as uPlot.AlignedData,
    [series],
  )

  /** Есть ли размер области: до первого замера `ResizeObserver` чарт не создаём */
  const sized = width > 0 && height > 0

  // Чарт — только при смене признака оси времени и размера; окно/шкала/ряд
  // применяются отдельными эффектами (правило Р4 — не пересоздавать чарты)
  useEffect(() => {
    const host = hostRef.current
    if (!host || !sized) return
    perfCount('edf.chart.create')
    const chart = new uPlot(
      makeHeartRateOptions(width, height, window, yRange, showXAxis),
      data,
      host,
    )
    chartRef.current = chart
    onCanvas(HEART_RATE_TRACK_NAME, chart.ctx?.canvas ?? null)
    return () => {
      chart.destroy()
      chartRef.current = null
      onCanvas(HEART_RATE_TRACK_NAME, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sized, showXAxis])

  useEffect(() => {
    if (!sized) return
    chartRef.current?.setSize({ width, height })
  }, [width, height, sized])

  useEffect(() => {
    chartRef.current?.setScale('y', { min: yRange[0], max: yRange[1] })
  }, [yRange])

  useEffect(() => {
    chartRef.current?.setData(data, false)
    chartRef.current?.setScale('x', { min: window.t0, max: window.t1 })
  }, [data, window])

  const title = [
    series.medianBpm != null ? `медиана ${series.medianBpm} уд/мин` : 'нет медианы',
    `${series.nBeats} QRS`,
    `${series.coveragePercent} % окон с данными`,
    `каналы: ${series.channels.join(', ')}`,
  ].join(' · ')

  return (
    <div
      className="relative flex items-stretch gap-1"
      data-testid="track-heart-rate"
      style={{ height }}
    >
      <div
        className="relative flex shrink-0 flex-col items-end justify-center"
        style={{ width: LABEL_WIDTH }}
      >
        <span
          data-testid="track-label-heart-rate"
          title={`ЧСС, уд/мин — извлечено из ЭЭГ (височные отведения): ${title}`}
          className="tnum truncate font-mono text-xs text-fg-2"
        >
          ЧСС
        </span>
      </div>
      <div
        ref={hostRef}
        data-testid="track-plot-heart-rate"
        className="pointer-events-none min-w-0 flex-1"
      />
    </div>
  )
}
