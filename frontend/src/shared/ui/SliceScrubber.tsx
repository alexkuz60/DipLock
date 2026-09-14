/**
 * Линейка среза MNI: ползунок по диапазону плоскости + метки делений и
 * именованные срезы (`x = 0`).
 *
 * Отдельный контрол, а не `NumberField`: срез — это положение в диапазоне
 * (мм), и его видно относительно границ головы. Ползунок дублирует клик по
 * проекции: клик попадает «на глаз», линейка — точно.
 */
import { useId } from 'react'
import { cx } from './cx'

export type SliceTickMark = {
  valueMm: number
  /** Положение на линейке 0…1 */
  fraction: number
  /** Короткая подпись деления (число мм) */
  label: string
}

export type SliceMark = {
  valueMm: number
  /** Подпись маркера («x = 0») */
  label: string
  /** Пояснение для тултипа («срединная сагитталь») */
  title: string
}

export type SliceScrubberProps = {
  /** Подпись контрола для скринридеров: «Срез z, мм» */
  label: string
  valueMm: number
  minMm: number
  maxMm: number
  stepMm?: number
  /** Деления линейки: мм и позиция (рисуются под ползунком) */
  ticks?: SliceTickMark[]
  /** Именованные срезы плоскости (маркеры с подписью) */
  marks?: SliceMark[]
  onChange: (valueMm: number) => void
  className?: string
}

export function SliceScrubber({
  label,
  valueMm,
  minMm,
  maxMm,
  stepMm = 1,
  ticks = [],
  marks = [],
  onChange,
  className,
}: SliceScrubberProps) {
  const id = useId()
  const fraction = maxMm > minMm ? (valueMm - minMm) / (maxMm - minMm) : 0.5

  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="range"
          aria-label={label}
          min={minMm}
          max={maxMm}
          step={stepMm}
          value={valueMm}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-4 min-w-0 flex-1 cursor-pointer accent-[var(--color-mri-slice)]"
        />
        <span className="tnum w-16 shrink-0 text-right font-mono text-sm text-fg-0">
          {valueMm.toFixed(1)} мм
        </span>
      </div>

      {/*
        Полоса делений позиционируется в тех же координатах, что и ползунок,
        поэтому метки и «большой палец» ходят вместе: значение можно считать
        прямо по метке, не открывая числовое поле.
      */}
      <div className="relative h-5">
        {ticks.map((tick) => (
          <span
            key={tick.valueMm}
            data-testid={`slice-tick-${tick.valueMm}`}
            className="absolute top-0 -translate-x-1/2 text-[10px] text-fg-2/80"
            style={{ left: `${tick.fraction * 100}%` }}
          >
            <span aria-hidden className="mx-auto block h-1 w-px bg-border" />
            {tick.label}
          </span>
        ))}
        {marks.map((mark) => (
          <span
            key={mark.label}
            data-testid={`slice-mark-${mark.label}`}
            title={mark.title}
            className="absolute -top-4 -translate-x-1/2 rounded border border-mri-slice/50 bg-bg-2 px-1 text-[10px] whitespace-nowrap text-mri-slice"
            style={{
              left: `${(maxMm > minMm ? (mark.valueMm - minMm) / (maxMm - minMm) : 0.5) * 100}%`,
            }}
          >
            {mark.label}
          </span>
        ))}
      </div>

      <div className="tnum flex justify-between text-[10px] text-fg-2">
        <span>{minMm} мм</span>
        <span aria-hidden className="opacity-70">
          {label} · {Math.round(fraction * 100)} %
        </span>
        <span>{maxMm} мм</span>
      </div>
    </div>
  )
}
