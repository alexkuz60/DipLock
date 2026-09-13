/**
 * Крупная иконочная кнопка с тултипом. Базовый элемент навигации и тулс-хедеров.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip } from './Tooltip'
import { cx } from './cx'

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** Текст подсказки при наведении */
  tooltip: string
  /** Доступное имя (aria-label) — для скринридеров */
  label: string
  icon: ReactNode
  active?: boolean
  size?: 'md' | 'lg'
}

export function IconButton({
  tooltip,
  label,
  icon,
  active = false,
  size = 'md',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        aria-label={label}
        className={cx(
          'inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors',
          size === 'lg' ? 'h-12 w-12 text-2xl' : 'h-10 w-10 text-xl',
          active
            ? 'border-accent/60 bg-accent-soft text-fg-0'
            : 'border-transparent text-fg-1 hover:bg-bg-3 hover:text-fg-0',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  )
}
