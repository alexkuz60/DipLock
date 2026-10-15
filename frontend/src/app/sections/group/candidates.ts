/**
 * Кандидаты выбора пары/группы из строк `GET /recordings` (новая схема,
 * read-API 4.7-окончание; legacy `GET /sessions` — deprecated): записи
 * **с результатами** (счётчики детей: сессии/прогоны/отчёты) плюс текущая
 * открытая запись — у неё результатов ещё может не быть.
 */
import type { RecordingSummary } from '@/shared/api/types'

export function compareCandidates(
  recordings: RecordingSummary[],
  current: { recording_id: string; filename: string } | null,
): { id: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const row of recordings) {
    const hasResults = row.n_sessions + row.n_analyses + row.n_report_runs > 0
    if (hasResults && !seen.has(row.recording_id)) {
      seen.set(row.recording_id, row.filename ?? row.recording_id)
    }
  }
  if (current) seen.set(current.recording_id, current.filename)
  return [...seen].map(([id, filename]) => ({ id, label: filename }))
}
