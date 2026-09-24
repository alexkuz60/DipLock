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
 *
 * **Окно частот** (срез 3.5) — интерактивное сужение графика: кнопки ритмов,
 * поля «от/до» и «Весь диапазон» показывают выбранный участок АЧХ. Это параметр
 * **просмотра**: сервер не пересчитывается, числа PSD лишь срезаются
 * (`spectrumWithinWindow`), а логарифмическая шкала берётся по всему спектру
 * (`psdScale`) — иначе пики «прыгали» бы при выборе ритма. Полосы вне окна
 * остаются на месте и приглушаются: видно, что в запись входит ещё, а не только
 * выбранный ритм.
 */
import type { SpectrumResult } from '@/shared/api/types'
import {
  clampFreqWindow,
  formatPower,
  freqRange,
  freqWindowLabel,
  histogramBars,
  normalizeFreqWindow,
  psdPolyline,
  psdScale,
  psdX,
  spectrumWithinWindow,
  type FreqWindow,
} from '@/shared/lib/spectrum'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'

/** Габариты области графика в единицах viewBox (масштабируется по ширине). */
const CHART_WIDTH = 520
const CHART_HEIGHT = 160

/** Место под подписи частот и названий ритмов под графиком, px viewBox. */
const AXIS_HEIGHT = 30

export type FftHistogramProps = {
  spectrum: SpectrumResult
  /**
   * Окно частот, Гц (`null` — весь измеренный диапазон). Значение приходит из
   * состояния раздела: компонент окно не хранит, а только показывает и правит.
   */
  range?: FreqWindow | null
  /** Правка окна (кнопка ритма, поле «от/до», «Весь диапазон»). Без неё контролов нет. */
  onRangeChange?: (range: FreqWindow | null) => void
  className?: string
}

export function FftHistogram({
  spectrum,
  range = null,
  onRangeChange,
  className,
}: FftHistogramProps) {
  const full = freqRange(spectrum.freqs)
  // «Окно не выбрано» и «выбран весь диапазон» — разные состояния: подпись и
  // предупреждения про окно зависят от того, правил ли пользователь его вообще.
  const hasWindow = normalizeFreqWindow(range) !== null
  // Окно зажимается в частоты ЭТОГО расчёта: оно живёт в предпочтениях просмотра
  // и переживает смену записи, а чужое окно показало бы пустой график.
  const window = clampFreqWindow(spectrum.freqs, range)
  const appliedWindow = hasWindow ? window : null
  const shown = spectrumWithinWindow(spectrum.freqs, spectrum.psd_mean_uv2, appliedWindow)
  const bars = histogramBars(spectrum.bands, appliedWindow)
  const polyline = psdPolyline(
    shown.freqs,
    shown.power,
    CHART_WIDTH,
    CHART_HEIGHT,
    2,
    psdScale(spectrum.psd_mean_uv2),
  )
  // Кривая апериодического фона (specparam): тот же масштаб, что и у PSD,
  // поэтому пики читаются как «высота над фоном», а не над осью.
  const background = spectrumWithinWindow(
    spectrum.freqs,
    spectrum.aperiodic_fit_uv2,
    appliedWindow,
  )
  const backgroundLine =
    spectrum.aperiodic_fit_uv2.length === spectrum.freqs.length && shown.freqs.length >= 2
      ? psdPolyline(
          background.freqs,
          background.power,
          CHART_WIDTH,
          CHART_HEIGHT,
          2,
          psdScale(spectrum.psd_mean_uv2),
        )
      : ''
  // Пики над фоном: вертикальные метки ровно над своим центром (та же шкала x)
  const [fMin, fMax] = window
  const shownPeaks =
    shown.freqs.length >= 2
      ? spectrum.peaks.filter(
          (peak) => peak.center_hz >= fMin - 1e-9 && peak.center_hz <= fMax + 1e-9,
        )
      : []
  const barWidth = bars.length > 0 ? (CHART_WIDTH - 40) / bars.length : 0

  return (
    <div className={cx('flex flex-col gap-2', className)} data-testid="fft-histogram">
      {onRangeChange ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg-2">Окно частот:</span>
          {bars.map((bar) => (
            <Button
              key={bar.name}
              data-testid={`fft-range-${bar.name}`}
              aria-pressed={isSameRange(appliedWindow, [bar.fmin, bar.fmax])}
              className={cx(
                'px-2 py-1 text-sm',
                isSameRange(appliedWindow, [bar.fmin, bar.fmax]) && 'border-accent text-fg-0',
              )}
              title={`Показать диапазон ${bar.fmin}–${bar.fmax} Гц`}
              onClick={() => onRangeChange([bar.fmin, bar.fmax])}
            >
              {`${bar.label} ${bar.fmin}–${bar.fmax}`}
            </Button>
          ))}
          <label className="flex items-center gap-1 text-sm text-fg-2">
            от
            <input
              type="number"
              inputMode="decimal"
              aria-label="Окно от, Гц"
              min={full[0]}
              max={full[1]}
              step={1}
              value={window[0]}
              onChange={(event) => onRangeChange(boundWith(window, 0, Number(event.target.value)))}
              className="tnum w-16 rounded-lg border border-border bg-bg-2 px-2 py-1 text-right text-sm text-fg-0"
            />
          </label>
          <label className="flex items-center gap-1 text-sm text-fg-2">
            до
            <input
              type="number"
              inputMode="decimal"
              aria-label="Окно до, Гц"
              min={full[0]}
              max={full[1]}
              step={1}
              value={window[1]}
              onChange={(event) => onRangeChange(boundWith(window, 1, Number(event.target.value)))}
              className="tnum w-16 rounded-lg border border-border bg-bg-2 px-2 py-1 text-right text-sm text-fg-0"
            />
          </label>
          <Button
            variant="ghost"
            disabled={!hasWindow}
            title="Показать весь измеренный диапазон частот"
            onClick={() => onRangeChange(null)}
          >
            Весь диапазон
          </Button>
        </div>
      ) : null}
      <svg
        role="img"
        aria-label={`FFT: мощность ритмов по ${spectrum.freqs.length} частотам, ${spectrum.n_epochs} эпох`}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT + AXIS_HEIGHT}`}
        className="h-48 w-full max-w-3xl"
      >
        {/* Полосы по диапазонам: высота — доля от максимальной мощности. Вне окна
            полосы приглушаются, но остаются на месте — их видно «в масштабе». */}
        {bars.map((bar, index) => {
          const height = bar.missing ? 0 : Math.max(2, bar.ratio * (CHART_HEIGHT - 20))
          const x = 20 + index * barWidth + barWidth * 0.15
          return (
            <g
              key={bar.name}
              data-testid={`fft-bar-${bar.name}`}
              data-in-range={String(bar.inRange)}
            >
              <rect
                x={x}
                y={CHART_HEIGHT - height}
                width={barWidth * 0.7}
                height={height}
                rx={3}
                fill="var(--color-mri-dipole)"
                fillOpacity={bar.missing ? 0 : bar.inRange ? 0.55 : 0.14}
              />
              <text
                x={x + barWidth * 0.35}
                y={CHART_HEIGHT - height - 4}
                textAnchor="middle"
                fontSize={11}
                fill="var(--color-fg-1)"
                fillOpacity={bar.inRange ? 1 : 0.5}
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
                fillOpacity={bar.inRange ? 1 : 0.5}
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

        {/* Фон 1/f (specparam): пунктир в том же масштабе, что и PSD */}
        {backgroundLine ? (
          <polyline
            data-testid="fft-aperiodic-line"
            points={backgroundLine}
            fill="none"
            stroke="var(--color-fg-2)"
            strokeWidth={1.2}
            strokeDasharray="4 3"
          />
        ) : null}

        {/* Пики над фоном: вертикальная метка центра + подпись частоты */}
        {shownPeaks.map((peak, index) => {
          const x = psdX(peak.center_hz, fMin, fMax, CHART_WIDTH)
          return (
            <g key={`peak-${peak.center_hz}-${index}`} data-testid={`fft-peak-${index}`}>
              <line
                x1={x}
                y1={0}
                x2={x}
                y2={CHART_HEIGHT}
                stroke="var(--color-accent)"
                strokeWidth={1}
                strokeDasharray="2 3"
                strokeOpacity={0.7}
              />
              <text
                x={x}
                y={12}
                textAnchor="middle"
                fontSize={10}
                fill="var(--color-fg-1)"
                className="tnum"
              >
                {peak.center_hz.toFixed(1)}
              </text>
            </g>
          )
        })}

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
      <p className="text-sm text-fg-2" data-testid="fft-window-label">
        {freqWindowLabel(appliedWindow, full)}. Полосы — средняя мощность диапазона, синяя линия —
        PSD по частотам (логарифмическая шкала: иначе альфа-пик «съедает» график), пунктир — фон
        1/f, вертикальные метки — пики над ним (specparam). «—» означает, что
        частоты диапазона не попали в полосу фильтра, а не нулевую мощность.
      </p>
      {hasWindow && shown.freqs.length < 2 ? (
        <p className="text-sm text-warn" data-testid="fft-empty-window">
          В выбранном окне нет измеренных частот — ломаная PSD не рисуется. Расширьте окно: частоты
          PSD посчитал сервер, и клиент их не досчитывает.
        </p>
      ) : null}
      {onRangeChange && hasWindow ? (
        <p className="text-sm text-fg-2">
          Полосы вне окна приглушены, но остаются на месте: их мощность нормируется по всему
          спектру, поэтому высота столбиков не зависит от выбранного окна. Правка окна ничего не
          запрашивает у сервера — пересчёт спектра по-прежнему только кнопкой.
        </p>
      ) : null}
    </div>
  )
}

/** Окно с одной правленой границей (вторая сохраняется). */
function boundWith(window: FreqWindow, index: 0 | 1, value: number): FreqWindow {
  return index === 0 ? [value, window[1]] : [window[0], value]
}

/** Окна совпадают с точностью до десятых (окно округляется при нормализации). */
function isSameRange(window: FreqWindow | null, band: FreqWindow): boolean {
  if (window === null) return false
  return Math.abs(window[0] - band[0]) < 0.05 && Math.abs(window[1] - band[1]) < 0.05
}
