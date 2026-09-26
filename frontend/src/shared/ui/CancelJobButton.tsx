/**
 * Кнопка «Отменить» у прогресса задачи (3.2): останавливает задачу на сервере.
 *
 * Показывается компонентом прогресса **только пока задача идёт** — отдельно
 * решать, видна ли кнопка, не нужно. Клик = `cancelRemoteJob` стора: DELETE
 * на сервере (воркер оборвётся на ближайшем тике) + локальный статус
 * `cancelled`, поэтому полоса прогресса сразу скрывается.
 */
import { X } from 'lucide-react'
import { Button } from './Button'

export function CancelJobButton({ onCancel }: { onCancel: () => void }) {
  return (
    <Button
      variant="ghost"
      className="px-2 py-1 text-sm"
      title="Остановить задачу на сервере: воркер оборвётся на ближайшем тике прогресса, результат опубликован не будет"
      data-testid="cancel-job-button"
      onClick={onCancel}
      icon={<X className="size-4" />}
    >
      Отменить
    </Button>
  )
}