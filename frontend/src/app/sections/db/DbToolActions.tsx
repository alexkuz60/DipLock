/**
 * Тулс-хедер раздела «БД»: обновление страницы, отправка выборки записей в
 * раздел «Групповой анализ» (пара A/B или группа N>2) и удаление выборки.
 *
 * Кнопки выборки активны только при корректном числе выбранных записей:
 * «В пару» — ровно 2 (A — первая выбранная, B — вторая), «В группу» — 2 и
 * больше. Выборка хранится в `dbView` (состояние сессии), после перехода
 * раздел «Групповой анализ» работает с ней как со своими участниками.
 *
 * «Удалить» — разрушительное действие, поэтому **два шага**: первый клик
 * предлагает «Подтвердить удаление (N)» и «Отмена», DELETE уходит только
 * вторым (проверка содержимого выборки до каскада §8.4.3). Отказавшие записи
 * остаются выбранными с текстом ошибки — их видно и можно повторить.
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Trash2, Users, GitCompareArrows } from 'lucide-react'
import { useDbView } from '@/shared/state/dbView'
import { Button } from '@/shared/ui/Button'
import { deleteRecordings, sendSelectionToGroup, sendSelectionToPair } from './dbActions'

/** Кнопка удаления выборки записей: «Удалить» → «Подтвердить удаление». */
function DeleteSelectedButton() {
  const queryClient = useQueryClient()
  const selectedIds = useDbView((state) => state.selectedIds)
  const clearSelection = useDbView((state) => state.clearSelection)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const count = selectedIds.length
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        icon={<Trash2 className="h-4 w-4" />}
        disabled={count === 0 || busy}
        className={confirming ? 'border border-danger text-danger' : undefined}
        title={
          count === 0
            ? 'Выберите записи, которые нужно удалить'
            : 'Удалить выбранные записи из БД: файл, кэши и все результаты (каскадом, §8.4.3)'
        }
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            setError(null)
            return
          }
          setBusy(true)
          void deleteRecordings(selectedIds).then((result) => {
            setBusy(false)
            setConfirming(false)
            setError(
              result.failed.length > 0
                ? `Не удалены: ${result.failed
                    .map((item) => `${item.recordingId} — ${item.error}`)
                    .join('; ')}`
                : null,
            )
            // Успешно удалённые уходят из выборки, отказавшие остаются видимыми
            const failedIds = result.failed.map((item) => item.recordingId)
            if (failedIds.length > 0) {
              useDbView.setState({ selectedIds: failedIds })
            } else {
              clearSelection()
            }
            if (result.deleted.length > 0) {
              void queryClient.invalidateQueries({ queryKey: ['recordings-readiness'] })
            }
          })
        }}
      >
        {busy ? 'Удаление…' : confirming ? `Подтвердить удаление (${count})` : `Удалить (${count})`}
      </Button>
      {confirming ? (
        <Button disabled={busy} title="Не удалять выбранные записи" onClick={() => setConfirming(false)}>
          Отмена
        </Button>
      ) : null}
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function DbToolActions() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const selectedIds = useDbView((state) => state.selectedIds)

  return (
    <div className="flex items-center gap-2">
      <Button
        icon={<RefreshCw className="h-4 w-4" />}
        onClick={() => queryClient.invalidateQueries({ queryKey: ['recordings-readiness'] })}
        title="Перечитать страницу готовности из БД (без пересчёта)"
      >
        Обновить
      </Button>
      <Button
        icon={<GitCompareArrows className="h-4 w-4" />}
        disabled={selectedIds.length !== 2}
        title={
          selectedIds.length === 2
            ? 'Передать выбранные записи в пару сравнения (A — первая, B — вторая)'
            : 'Выберите ровно 2 записи (порядок выбора = A, B)'
        }
        onClick={() => {
          if (sendSelectionToPair(selectedIds)) navigate('/group')
        }}
      >
        В пару (A/B)
      </Button>
      <Button
        icon={<Users className="h-4 w-4" />}
        disabled={selectedIds.length < 2}
        title={
          selectedIds.length >= 2
            ? 'Передать выбранные записи участниками группы (порядок выбора сохраняется)'
            : 'Выберите не меньше 2 записей'
        }
        onClick={() => {
          if (sendSelectionToGroup(selectedIds)) navigate('/group')
        }}
      >
        {'В группу (N>2)'}
      </Button>
      <DeleteSelectedButton />
    </div>
  )
}