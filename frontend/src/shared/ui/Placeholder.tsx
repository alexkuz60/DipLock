/** Заглушка рабочей области: иконка, заголовок, пояснение и (опционально) действия. */
import type { ReactNode } from 'react'

export type PlaceholderProps = {
  icon?: ReactNode
  title: string
  description?: string
  children?: ReactNode
}

export function Placeholder({ icon, title, description, children }: PlaceholderProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      {icon ? <div className="text-fg-2">{icon}</div> : null}
      <h2 className="text-2xl font-semibold text-fg-0">{title}</h2>
      {description ? <p className="max-w-2xl text-base text-fg-2">{description}</p> : null}
      {children ? <div className="mt-2 flex items-center gap-3">{children}</div> : null}
    </div>
  )
}
