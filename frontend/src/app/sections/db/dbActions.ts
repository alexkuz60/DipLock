/**
 * Действия выборки раздела «БД»: передача выбранных записей в пару/группу
 * раздела «Групповой анализ» (чистые вызовы сторов, навигация — у вызывающего).
 *
 * Пара: первая выбранная запись — A, вторая — B (порядок выбора). Группа:
 * участники — в порядке выбора (это порядок колонок тепловой карты).
 */
import { useGroupCompare } from '@/shared/state/groupCompare'
import { useGroupRun } from '@/shared/state/groupRun'

/** Заполнить пару сравнения (A/B); `false` — выбрано не ровно 2 записи. */
export function sendSelectionToPair(recordingIds: string[]): boolean {
  if (recordingIds.length !== 2) return false
  const [a, b] = recordingIds
  useGroupCompare.getState().setRecordingA(a)
  useGroupCompare.getState().setRecordingB(b)
  useGroupRun.getState().setMode('pair')
  return true
}

/** Заполнить участников группы (N>2); `false` — выбрано меньше 2 записей. */
export function sendSelectionToGroup(recordingIds: string[]): boolean {
  if (recordingIds.length < 2) return false
  useGroupRun.getState().setRecordings(recordingIds)
  useGroupRun.getState().setMode('group')
  return true
}