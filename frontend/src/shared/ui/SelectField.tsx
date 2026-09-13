/**
 * Выпадающий список для выбора из длинного перечня (пресеты фильтра, длина эпохи,
 * единицы EDF). Нативный `<select>`: предсказуемый ввод с клавиатуры и системная
 * прокрутка длинных списков при крупном шрифте.
 */
import { useId } from 'react'
import { FieldRow } from './FieldRow'

export type SelectOption<T extends string> = {
  value: T
  label: string
  disabled?: boolean
}

export type SelectFieldProps<T extends string> = {
  label: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  hint?: string
  disabled?: boolean
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
}: SelectFieldProps<T>) {
  const id = useId()

  return (
    <FieldRow label={label} htmlFor={id} hint={hint}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
        className="w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-sm text-fg-0 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldRow>
  )
}
