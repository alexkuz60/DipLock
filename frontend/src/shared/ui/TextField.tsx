/**
 * Текстовое поле с подсказкой (свободный ввод: имена каналов, заметки).
 *
 * Значение уходит наверх на каждый ввод (как `NumberField`), локальное
 * состояние держит только «печатаемый» текст, чтобы ввод не пересобирался
 * под курсором.
 */
import { useEffect, useId, useState } from 'react'
import { FieldRow } from './FieldRow'

export type TextFieldProps = {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  mono?: boolean
  disabled?: boolean
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono = false,
  disabled = false,
}: TextFieldProps) {
  const id = useId()
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(value)
  }, [value, focused])

  return (
    <FieldRow label={label} htmlFor={id} hint={hint}>
      <input
        id={id}
        type="text"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onChange={(event) => {
          setText(event.target.value)
          onChange(event.target.value)
        }}
        onBlur={() => setFocused(false)}
        className={
          mono
            ? 'tnum w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-sm text-fg-0 disabled:cursor-not-allowed disabled:opacity-40'
            : 'w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-sm text-fg-0 disabled:cursor-not-allowed disabled:opacity-40'
        }
      />
    </FieldRow>
  )
}