/** Небольшие элементы ручного исследования: текст, пагинация, ошибки чтения. */
import { useId } from 'react'
import { apiErrorText } from '@/shared/api/client'
import { Button } from '@/shared/ui/Button'
import { FieldRow } from '@/shared/ui/FieldRow'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'

export function TextArea({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (text: string) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <FieldRow label={label} htmlFor={id}>
      <textarea
        id={id}
        rows={3}
        maxLength={20000}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-border bg-bg-2 p-2 text-fg-0 disabled:opacity-40"
      />
    </FieldRow>
  )
}

export function PageButtons({
  offset,
  total,
  onChange,
}: {
  offset: number
  total: number
  onChange: (offset: number) => void
}) {
  return (
    <div className="my-2 flex items-center gap-2 text-sm text-fg-2">
      <Button
        variant="ghost"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - 20))}
      >
        Назад
      </Button>
      <span>
        {total ? `${offset + 1}–${Math.min(offset + 20, total)} из ${total}` : 'Пока нет записей'}
      </span>
      <Button variant="ghost" disabled={offset + 20 >= total} onClick={() => onChange(offset + 20)}>
        Далее
      </Button>
    </div>
  )
}

export function QueryState({
  loading,
  error,
  retry,
}: {
  loading: boolean
  error: Error | null
  retry: () => void
}) {
  if (loading) return <LoadingBlock />
  return error ? <ErrorBlock message={apiErrorText(error)} onRetry={retry} /> : null
}

export function ConsiliumPanel() {
  return (
    <div className="space-y-3 p-3 text-sm text-fg-1">
      <h2 className="font-semibold">Рабочее исследование</h2>
      <p>
        Сформулируйте вопрос, добавьте рассказ добровольца и выберите результаты конкретных
        прогонов.
      </p>
      <p>Досье сохраняет то, что вы обсуждали: новый расчёт не меняет прошлый снимок.</p>
      <p>
        Измерения и модели, рассказ человека и ваши наблюдения — разные основания. Подробности
        доступны по раскрытию.
      </p>
      <p>
        Сейчас доступна ручная работа. ИИ-советники и стенография беседы появятся отдельными
        этапами.
      </p>
    </div>
  )
}
