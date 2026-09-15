/**
 * FFT-гистограмма ритмов (срез 3.4): полосы по диапазонам + ломаная PSD.
 *
 * SVG, а не canvas: цвет берётся токенами темы прямо в атрибутах, а размер
 * подстраивается под текст (та же причина, что у проекций мозга). Числа — из
 * результата сервера (`SpectrumResult`), ничего не пересчитывается на клиенте:
 * чистая геометрия живёт в `shared/lib/spectrum.ts` и покрыта тестами.
 *
 * Диапазон без измеренной мощности (`power_uv2 === null`, например γ вне полосы
 * фильтра) рисуется пустым столбиком с подписью «—»: это не «ноль», и выдавать
 * его за ноль нельзя.
 */
import type { SpectrumResult } from '@/shared/api/types'
import { formatPower, freqRange, histogramBars, psdPolyline } from '@/shared/lib/spectrum'
import { cx } from '@/shared/ui/cx'

/** Габариты области графика в единицах viewBox (масштабируется по ширине). */
const CHART_WIDTH = 520
const CHART_HEIGHT = 160

/** Место под подписи частот и названий ритмов под графиком, px viewBox. */
const AXIS_HEIGHT = 30

export type FftHistogramProps = {
  spectrum: SpectrumResult
  className?: string
}

export function FftHistogram({ spectrum, className }: FftHistogramProps) {
  const bars = histogramBars(spectrum.bands)
  const polyline = psdPolyline(spectrum.freqs, spectrum.psd_mean_uv2, CHART_WIDTH, CHART_HEIGHT)
  const [fMin, fMax] = freqRange(spectrum.freqs)
  const barWidth = bars.length > 0 ? (CHART_WIDTH - 40) / bars.length : 0

  return (
    <div className={cx('flex flex-col gap-1', className)} data-testid="fft-histogram">
      <svg
        role="img"
        aria-label={`FFT: мощность ритмов по ${spectrum.freqs.length} частотам, ${spectrum.n_epochs} эпох`}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT + AXIS_HEIGHT}`}
        className="h-48 w-full max-w-3xl"
      >
        {/* Полосы по диапазонам: высота — доля от максимальной мощности */}
        {bars.map((bar, index) => {
          const height = bar.missing ? 0 : Math.max(2, bar.ratio * (CHART_HEIGHT - 20))
          const x = 20 + index * barWidth + barWidth * 0.15
          return (
            <g key={bar.name} data-testid={`fft-bar-${bar.name}`}>
              <rect
                x={x}
                y={CHART_HEIGHT - height}
                width={barWidth * 0.7}
                height={height}
                rx={3}
                fill="var(--color-mri-dipole)"
                fillOpacity={bar.missing ? 0 : 0.55}
              />
              <text
                x={x + barWidth * 0.35}
                y={CHART_HEIGHT - height - 4}
                textAnchor="middle"
                fontSize={11}
                fill="var(--color-fg-1)"
                className="tnum"
              >
                {formatPower(bar.missing ? null : bar.power)}
              </text>
              <text
                x={x + barWidth * 0.35}
                y={CHART_HEIGHT + 14}
                textAnchor="middle"
                fontSize={10}
                fill="var(--color-fg-2)"
              >
                {bar.label}
              </text>
            </g>
          )
        })}

        {/* Ломаная PSD: тот же расчёт, что и полосы, но по всем частотам */}
        {polyline ? (
          <polyline
            data-testid="fft-psd-line"
            points={polyline}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.4}
          />
        ) : null}

        {/* Ось частот: границы и подпись единиц */}
        <line
          x1={0}
          y1={CHART_HEIGHT}
          x2={CHART_WIDTH}
          y2={CHART_HEIGHT}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        <text x={2} y={CHART_HEIGHT + 26} fontSize={10} fill="var(--color-fg-2)" className="tnum">
          {fMin} Гц
        </text>
        <text
          x={CHART_WIDTH - 2}
          y={CHART_HEIGHT + 26}
          textAnchor="end"
          fontSize={10}
          fill="var(--color-fg-2)"
          className="tnum"
        >
          {fMax} Гц
        </text>
      </svg>
      <p className="text-sm text-fg-2">
        Полосы — средняя мощность диапазона, синяя линия — PSD по частотам (логарифмическая шкала:
        иначе альфа-пик «съедает» график). «—» означает, что частоты диапазона не попали в полосу
        фильтра, а не нулевую мощность.
      </p>
    </div>
  )
}
