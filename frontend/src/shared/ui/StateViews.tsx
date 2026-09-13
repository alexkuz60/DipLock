/** Состояния данных: загрузка, ошибка с повтором, строка «ключ → значение». */
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from './Button'
import { cx } from './cx'

export function LoadingBlock({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-fg-2">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  )
}

export type ErrorBlockProps = {
  title?: string
  message: string
  onRetry?: () => void
}

export function ErrorBlock({ title = 'Не удалось получить данные', message, onRetry }: ErrorBlockProps) {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0">
          <p className="font-medium text-fg-0">{title}</p>
          <p className="break-words text-sm text-fg-1">{message}</p>
        </div>
      </div>
      {onRetry ? (
        <Button className="mt-3" icon={<RefreshCw className="size-4" />} onClick={onRetry}>
          Повторить
        </Button>
      ) : null}
    </div>
  )
}

export type InfoRowProps = {
  label: string
  value: string | number | boolean | null | undefined
  mono?: boolean
  className?: string
}

export function InfoRow({ label, value, mono = false, className }: InfoRowProps) {
  const text =
    value === null || value === undefined || value === '' ? '—' : typeof value === 'boolean' ? (value ? 'да' : 'нет') : String(value)
  return (
    <div className={cx('ui-list-row flex items-baseline justify-between gap-3 py-1', className)}>
      <span className="shrink-0 text-sm text-fg-2">{label}</span>
      <span className={cx('min-w-0 truncate text-right text-sm text-fg-0', mono && 'tnum font-mono')} title={text}>
        {text}
      </span>
    </div>
  )
}
