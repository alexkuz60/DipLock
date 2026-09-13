/**
 * Компактный статус-индикатор («результат актуален», «параметры изменены»).
 *
 * Статус всегда подписан текстом, а не только цветом: цвет — вспомогательный
 * канал, основной — формулировка (см. требования доступности в docs/ui.md).
 */
import type { ReactNode } from 'react'
import { cx } from './cx'

export type StatusPillTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'

export type StatusPillProps = {
  tone?: StatusPillTone
  children: ReactNode
  title?: string
  className?: string
}

export function StatusPill({ tone = 'neutral', children, title, className }: StatusPillProps) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm',
        tone === 'neutral' && 'border-border bg-bg-2 text-fg-2',
        tone === 'accent' && 'border-accent/50 bg-accent-soft text-fg-0',
        tone === 'ok' && 'border-ok/40 bg-ok/10 text-ok',
        tone === 'warn' && 'border-warn/40 bg-warn/10 text-warn',
        tone === 'danger' && 'border-danger/40 bg-danger/10 text-danger',
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}
