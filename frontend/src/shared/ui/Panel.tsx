/** Секция правого сайдбара: заголовок + содержимое + необязательная подсказка. */
import type { ReactNode } from 'react'
import { cx } from './cx'

export type PanelProps = {
  title: string
  hint?: string
  children: ReactNode
  className?: string
}

export function Panel({ title, hint, children, className }: PanelProps) {
  return (
    <section className={cx('rounded-lg border border-border bg-bg-2 p-3', className)}>
      <h3 className="mb-2 text-sm font-semibold tracking-wide text-fg-2 uppercase">{title}</h3>
      {children}
      {hint ? <p className="mt-2 text-sm text-fg-2">{hint}</p> : null}
    </section>
  )
}
