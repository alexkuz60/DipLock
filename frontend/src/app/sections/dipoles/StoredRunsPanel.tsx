/**
 * Секция «Прогоны в БД» панели «Опции» раздела «Диполи»: список записанных
 * прогонов пакета текущей записи и показ любого из них **без пересчёта**
 * (16.11.2026, история не UPSERT — §8.4.2 `docs/rules/results-db.md`).
 *
 * Показ — не обработка (правило «Обработка — только по кнопке» не нарушается):
 * кнопка «Показать» загружает уже записанный результат. Источник — полный
 * контракт из файла задачи прогона (`result_url`); если файл не сохранился —
 * точки из БД (`shared/lib/storedRuns.ts`) с честной подписью, чего в них нет
 * (кластеры, сопоставление полос, отбраковка эпох, сетевой фильтр). Сам список
 * читает `GET /analyses?recording_id=…` (read-API 4.7) через react-query —
 * тот же паттерн, что `/meta` в этой панели.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { AnalysisSummary } from '@/shared/api/types'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { Button } from '@/shared/ui/Button'
import { Panel } from '@/shared/ui/Panel'
import { StatusPill } from '@/shared/ui/StatusPill'

/** Сколько прогонов показывать в секции (новые сверху). */
const STORED_RUNS_LIMIT = 10

/** Дата прогона в человекочитаемом виде; `—` — дата не записана. */
function runDate(run: AnalysisSummary): string {
  return run.created_at ? new Date(run.created_at).toLocaleString('ru') : '—'
}

export function StoredRunsPanel({ recordingId }: { recordingId: string | null }) {
  const runs = useQuery({
    queryKey: ['analyses', recordingId],
    queryFn: ({ signal }) =>
      api.analyses({ recording_id: recordingId ?? '', limit: STORED_RUNS_LIMIT }, signal),
    enabled: Boolean(recordingId),
    staleTime: 30_000,
    retry: false,
  })
  const storedRun = useDipoleCalc((state) => state.storedRun)
  const restoring = useDipoleCalc((state) => state.restoring)
  const restoreError = useDipoleCalc((state) => state.restoreError)
  const showStoredRun = useDipoleCalc((state) => state.showStoredRun)
  const [busyId, setBusyId] = useState<number | null>(null)

  const items = runs.data?.items ?? []

  return (
    <Panel
      title="Прогоны в БД"
      hint="Каждый расчёт пакета записывается в БД отдельным прогоном (история: повторный расчёт добавляет прогон, а не перезаписывает прежний). «Показать» загружает готовый результат без пересчёта: полный контракт — из файла задачи, при его отсутствии — точки из БД без кластеров, сопоставления полос и отбраковки эпох."
    >
      {!recordingId ? (
        <p className="text-sm text-fg-2">Откройте запись — появятся её прогоны.</p>
      ) : runs.isLoading ? (
        <p className="text-sm text-fg-2">Загрузка прогонов…</p>
      ) : runs.isError ? (
        <p className="text-sm text-fg-2">Не удалось прочитать прогоны из БД.</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-fg-2">
          Прогонов в БД нет: расчёт запускается кнопкой «Рассчитать пакет» в шапке раздела.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((run) => {
            const shown = storedRun?.analysisId === run.id
            return (
              <li key={run.id} className="ui-list-row flex flex-wrap items-center gap-2 py-1">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg-0">{runDate(run)}</p>
                  <p
                    className="truncate text-xs text-fg-2"
                    title={run.params_sig ? `Отпечаток прогона: ${run.params_sig}` : undefined}
                  >
                    {`эпоха ${run.epoch_length_ms ?? '—'} мс · сетка ${run.grid_mm ?? '—'} мм · полос ${run.n_bands} · точек ${run.n_points}${
                      run.params_sig ? ` · ${run.params_sig.slice(0, 8)}` : ''
                    }`}
                  </p>
                </div>
                {shown ? <StatusPill tone="ok">Показано</StatusPill> : null}
                <Button
                  disabled={restoring}
                  title={
                    shown
                      ? 'Показать этот прогон заново'
                      : 'Показать записанный прогон без пересчёта'
                  }
                  onClick={() => {
                    setBusyId(run.id)
                    void showStoredRun(recordingId, run).finally(() => setBusyId(null))
                  }}
                >
                  {busyId === run.id && restoring ? 'Загрузка…' : 'Показать'}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {storedRun?.source === 'db-points' ? (
          <StatusPill tone="warn" title="Кластеры, сопоставление полос и отбраковка эпох в БД не сохраняются">
            {`Прогон показан из БД: без кластеров и сопоставления полос${
              storedRun.skippedPoints > 0
                ? `, точек без координат не показано ${storedRun.skippedPoints}`
                : ''
            }`}
          </StatusPill>
        ) : null}
        {restoreError ? (
          <StatusPill tone="danger">{`Не удалось показать прогон: ${restoreError}`}</StatusPill>
        ) : null}
      </div>
    </Panel>
  )
}