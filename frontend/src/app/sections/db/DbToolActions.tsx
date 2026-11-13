/**
 * Тулс-хедер раздела «БД»: обновление страницы и отправка выборки записей в
 * раздел «Групповой анализ» (пара A/B или группа N>2).
 *
 * Кнопки выборки активны только при корректном числе выбранных записей:
 * «В пару» — ровно 2 (A — первая выбранная, B — вторая), «В группу» — 2 и
 * больше. Выборка хранится в `dbView` (состояние сессии), после перехода
 * раздел «Групповой анализ» работает с ней как со своими участниками.
 */
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Users, GitCompareArrows } from 'lucide-react'
import { useDbView } from '@/shared/state/dbView'
import { Button } from '@/shared/ui/Button'
import { sendSelectionToGroup, sendSelectionToPair } from './dbActions'

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
    </div>
  )
}