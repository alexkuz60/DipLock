/**
 * Числовое поле с единицей измерения, границами и шагом.
 *
 * Ввод — в локальном состоянии: пока пользователь печатает, значение не
 * «нормализуется» под курсором (иначе набор «0.5» превращался бы в «0.0.5»).
 * Значение уходит наверх сразу, но зажатое в [min, max]; на blur поле
 * показывает актуальное значение из состояния (сброс мусора и «300» → «200»).
 */
import { useEffect, useId, useState } from 'react'
import { FieldRow } from './FieldRow'

export type NumberFieldProps = {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  /** Единица измерения справа от поля (мкВ, мс, Гц) */
  unit?: string
  hint?: string
  disabled?: boolean
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  disabled = false,
}: NumberFieldProps) {
  const id = useId()
  const [text, setText] = useState(() => String(value))
  const [focused, setFocused] = useState(false)

  // Внешнее изменение (сброс к значениям сервера, загрузка записи) подхватываем,
  // только если пользователь не печатает прямо сейчас.
  useEffect(() => {
    if (!focused) setText(String(value))
  }, [value, focused])

  function clamp(next: number): number {
    let result = next
    if (min !== undefined) result = Math.max(min, result)
    if (max !== undefined) result = Math.min(max, result)
    return result
  }

  return (
    <FieldRow label={label} htmlFor={id} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={text}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            const next = event.target.value
            setText(next)
            if (next.trim() === '') return // промежуточный ввод — не коммитим
            const parsed = Number(next.replace(',', '.'))
            if (!Number.isFinite(parsed)) return
            onChange(clamp(parsed))
          }}
          onBlur={() => {
            setFocused(false)
            setText(String(value))
          }}
          className="tnum w-28 rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-right text-sm text-fg-0 disabled:cursor-not-allowed disabled:opacity-40"
        />
        {unit ? <span className="text-sm text-fg-2">{unit}</span> : null}
      </div>
    </FieldRow>
  )
}
