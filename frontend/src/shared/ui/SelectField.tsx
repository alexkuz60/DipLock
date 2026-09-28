/**
 * Выпадающий список для выбора из длинного перечня (пресеты фильтра, длина эпохи,
 * единицы EDF). Нативный `<select>`: предсказуемый ввод с клавиатуры и системная
 * прокрутка длинных списков при крупном шрифте.
 *
 * Опция с `group` попадает в отдельный `<optgroup>`: подряд идущие опции одной
 * группы склеиваются (так функциональные ритмы фильтра живут отдельным блоком,
 * не смешиваясь с базовыми полосами — `shared/lib/calcFilter.ts`).
 */
import { Fragment, useId } from 'react'
import { FieldRow } from './FieldRow'

export type SelectOption<T extends string> = {
  value: T
  label: string
  disabled?: boolean
  /** Заголовок группы (отдельный `<optgroup>`); соседние опции с одной группой склеиваются */
  group?: string
}

export type SelectFieldProps<T extends string> = {
  label: string
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  hint?: string
  disabled?: boolean
}

/** Сплит опций на блоки: подряд идущие опции одной группы — один `<optgroup>`. */
function optionBlocks<T extends string>(
  options: SelectOption<T>[],
): { group?: string; options: SelectOption<T>[] }[] {
  const blocks: { group?: string; options: SelectOption<T>[] }[] = []
  for (const option of options) {
    const last = blocks[blocks.length - 1]
    if (option.group !== undefined && last && last.group === option.group) {
      last.options.push(option)
    } else {
      blocks.push({ group: option.group, options: [option] })
    }
  }
  return blocks
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
        {optionBlocks(options).map((block, index) =>
          block.group !== undefined ? (
            <optgroup key={block.group} label={block.group}>
              {block.options.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <Fragment key={index}>
              {block.options.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </Fragment>
          ),
        )}
      </select>
    </FieldRow>
  )
}
