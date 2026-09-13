/**
 * Строка параметра: подпись слева, контрол справа, необязательная подсказка снизу.
 *
 * Базовый лэйаут для всех контролов правой панели — подписи в одну колонку,
 * чтобы панель читалась как список параметров, а не как форма.
 */
import type { ReactNode } from 'react'
import { cx } from './cx'

export type FieldRowProps = {
  label: string
  /** id контрола: связывает подпись с полем (для скринридеров и клика по подписи) */
  htmlFor?: string
  hint?: string
  children: ReactNode
  className?: string
}

export function FieldRow({ label, htmlFor, hint, children, className }: FieldRowProps) {
  // Без htmlFor подпись не может быть <label> (это сломало бы a11y):
  // группы (сегменты, чекбокс-списки) подписаны собственным aria-label.
  const caption = htmlFor ? (
    <label className="w-28 shrink-0 text-sm text-fg-2" htmlFor={htmlFor}>
      {label}
    </label>
  ) : (
    <span className="w-28 shrink-0 text-sm text-fg-2">{label}</span>
  )

  return (
    <div className={cx('ui-list-row py-2', className)}>
      <div className="flex items-center gap-3">
        {caption}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {hint ? <p className="mt-1 pl-0 text-sm text-fg-2">{hint}</p> : null}
    </div>
  )
}
