/**
 * Действия выборки раздела «БД»: передача выбранных записей в пару/группу
 * раздела «Групповой анализ» (чистые вызовы сторов, навигация — у вызывающего)
 * и удаление выбранных записей из БД (каскад: файл, кэши и результаты).
 *
 * Пара: первая выбранная запись — A, вторая — B (порядок выбора). Группа:
 * участники — в порядке выбора (это порядок колонок тепловой карты).
 */
import { api, apiErrorText } from '@/shared/api/client'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { useGroupRun } from '@/shared/state/groupRun'
import { useEdfRecording } from '@/shared/state/edfRecording'

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

/** Итог удаления выборки: удалённые и отказавшиеся (с текстом ошибки). */
export type DeleteRecordingsResult = {
  deleted: string[]
  failed: { recordingId: string; error: string }[]
}

/**
 * Удалить записи из БД каскадом (`DELETE /recordings/{id}`: файл, кэши и
 * строки результатов — §8.4.3 `docs/rules/results-db.md`).
 *
 * Удаление последовательное: отказ одной записи не мешает остальным. Если
 * среди удалённых — **открытая** запись, она закывается: её файла и кэшей на
 * сервере больше нет, разделы не должны показывать умершие данные.
 */
export async function deleteRecordings(
  recordingIds: string[],
): Promise<DeleteRecordingsResult> {
  const deleted: string[] = []
  const failed: { recordingId: string; error: string }[] = []
  for (const recordingId of recordingIds) {
    try {
      await api.deleteRecording(recordingId)
      deleted.push(recordingId)
    } catch (error) {
      failed.push({ recordingId, error: apiErrorText(error) })
    }
  }
  const openId = useEdfRecording.getState().recording?.recording_id ?? null
  if (openId !== null && deleted.includes(openId)) {
    useEdfRecording.getState().closeRecording()
  }
  return { deleted, failed }
}