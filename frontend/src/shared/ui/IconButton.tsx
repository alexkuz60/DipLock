/**
 * Крупная иконочная кнопка с тултипом. Базовый элемент навигации и тулс-хедеров.
 *
 * У выключенной кнопки подсказка остаётся доступной: браузер не присылает
 * события от `disabled`-элемента, поэтому такая кнопка оборачивается в
 * фокусируемый контейнер — иначе пользователь не узнал бы, почему действие
 * недоступно.
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
  disabled,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
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
  )

  return (
    <Tooltip label={tooltip}>
      {disabled ? (
        <span className="inline-flex rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          {button}
        </span>
      ) : (
        button
      )}
    </Tooltip>
  )
}
