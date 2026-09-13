/**
 * Чекбокс-строка: подпись кликабельна целиком, чекбокс крупный (десктоп, мышь).
 * Используется для выбора каналов, видимости слоёв и типов артефактов.
 */
import { useId } from 'react'
import { cx } from './cx'

export type CheckboxRowProps = {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: string
  disabled?: boolean
  /** Моноширинная подпись (имена каналов: Fp1, C3…) */
  mono?: boolean
  className?: string
}

export function CheckboxRow({
  label,
  checked,
  onChange,
  hint,
  disabled = false,
  mono = false,
  className,
}: CheckboxRowProps) {
  const id = useId()

  return (
    <div className={cx('ui-list-row py-1', className)}>
      <div className="flex items-center gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="size-4 shrink-0 accent-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
        />
        <label
          htmlFor={id}
          className={cx(
            'min-w-0 flex-1 cursor-pointer text-sm text-fg-1',
            mono && 'tnum font-mono',
            disabled && 'cursor-not-allowed opacity-40',
          )}
        >
          {label}
        </label>
      </div>
      {hint ? <p className="mt-0.5 text-sm text-fg-2">{hint}</p> : null}
    </div>
  )
}
