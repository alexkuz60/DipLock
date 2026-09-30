/**
 * Сегментный переключатель: выбор одного из 2–5 равнозначных вариантов
 * (шкала амплитуды, режим референса, масштаб времени).
 *
 * Всегда видимый набор кнопок вместо выпадающего списка: параметров мало,
 * а их текущее состояние должно читаться без клика.
 */
import { FieldRow } from './FieldRow'
import { cx } from './cx'

export type SegmentedOption<T extends string> = {
  value: T
  label: string
  /** Подсказка при наведении (например, «×16 — самая высокая детализация») */
  title?: string
}

export type SegmentedControlProps<T extends string> = {
  label: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  hint?: string
  /**
   * Раскладка: `field` (по умолчанию) — строка панели опций через `FieldRow`;
   * `inline` — видимая подпись и кнопки в одну строку — для хедера раздела и
   * подзаголовков секций (правка 30.09.2026).
   */
  layout?: 'field' | 'inline'
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  layout = 'field',
}: SegmentedControlProps<T>) {
  const buttons = options.map((option) => {
    const active = option.value === value
    return (
      <button
        key={option.value}
        type="button"
        title={option.title}
        aria-pressed={active}
        onClick={() => onChange(option.value)}
        className={cx(
          'tnum rounded-lg border px-2.5 py-1 text-sm transition-colors',
          active
            ? 'border-accent/60 bg-accent-soft text-fg-0'
            : 'border-border bg-bg-2 text-fg-1 hover:bg-bg-3 hover:text-fg-0',
        )}
      >
        {option.label}
      </button>
    )
  })

  // Inline: подпись видимая слева (читается в строке шапки/подзаголовка),
  // группа кнопок — тот же `role="group"` с именем параметра, что и в панели
  if (layout === 'inline') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-fg-2">{label}</span>
        <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
          {buttons}
        </div>
      </div>
    )
  }

  return (
    <FieldRow label={label} hint={hint}>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {buttons}
      </div>
    </FieldRow>
  )
}
