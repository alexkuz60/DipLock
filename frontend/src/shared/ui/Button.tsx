/** Кнопка с текстом (основное действие раздела, старт задачи и т.п.). */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost'
  icon?: ReactNode
}

export function Button({
  variant = 'secondary',
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-base font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'bg-accent text-bg-0 hover:brightness-110',
        variant === 'secondary' && 'border border-border bg-bg-2 text-fg-0 hover:bg-bg-3',
        variant === 'ghost' && 'text-fg-1 hover:bg-bg-3 hover:text-fg-0',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
