/**
 * Кандидаты выбора пары сравнения из строк `GET /sessions`: уникальные
 * `recording_id` → имя файла (несколько сессий на одну запись схлопываются)
 * плюс текущая открытая запись — у неё сессий ещё может не быть.
 */
import type { SessionSummary } from '@/shared/api/types'

export function compareCandidates(
  sessions: SessionSummary[],
  current: { recording_id: string; filename: string } | null,
): { id: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const row of sessions) {
    if (row.recording_id && !seen.has(row.recording_id)) {
      seen.set(row.recording_id, row.filename ?? row.recording_id)
    }
  }
  if (current) seen.set(current.recording_id, current.filename)
  return [...seen].map(([id, filename]) => ({ id, label: filename }))
}
