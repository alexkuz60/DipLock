/**
 * Панель «Группа (N>2)» (остаток 4.7, §3.5): участники, групповые фильтры,
 * подпись и история прогонов.
 *
 * Панель **ничего не запускает** (правило `docs/rules/frontend-state.md`):
 * параметры складываются в стор `groupRun`, агрегат стартует только кнопкой
 * «Считать» в тулс-хедере; «Сохранить прогон» — снимок определения в
 * историю (`POST /group/analyses`), история читается кнопкой «Обновить» и
 * кликом по строке (свежий пересчёт на сервере, не кэш).
 *
 * Кандидаты участников — те же, что у пары: уникальные `recording_id` строк
 * `GET /sessions` (`candidates.ts`), плюс текущая открытая запись.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import { bandKeyOptions } from '@/shared/lib/bandOptions'
import { useEdfParams } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useGroupRun } from '@/shared/state/groupRun'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { FieldRow } from '@/shared/ui/FieldRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { compareCandidates } from './candidates'

export function GroupRunPanel() {
  const sessions = useQuery({
    queryKey: ['sessions', 200],
    queryFn: ({ signal }) => api.sessions({ limit: 200 }, signal),
  })
  const meta = useQuery({ queryKey: ['meta'], queryFn: ({ signal }) => api.meta(signal) })
  const current = useEdfRecording((state) => state.recording)
  const candidates = compareCandidates(sessions.data?.items ?? [], current)

  const recordingIds = useGroupRun((state) => state.recordingIds)
  const toggleRecording = useGroupRun((state) => state.toggleRecording)
  const clearRecordings = useGroupRun((state) => state.clearRecordings)
  const bandKey = useGroupRun((state) => state.bandKey)
  const setBandKey = useGroupRun((state) => state.setBandKey)
  const gofMin = useGroupRun((state) => state.gofMin)
  const setGofMin = useGroupRun((state) => state.setGofMin)
  const epochLengthMs = useGroupRun((state) => state.epochLengthMs)
  const setEpochLengthMs = useGroupRun((state) => state.setEpochLengthMs)
  const dateFrom = useGroupRun((state) => state.dateFrom)
  const setDateFrom = useGroupRun((state) => state.setDateFrom)
  const dateTo = useGroupRun((state) => state.dateTo)
  const setDateTo = useGroupRun((state) => state.setDateTo)
  const names = useGroupRun((state) => state.names)
  const setNames = useGroupRun((state) => state.setNames)
  const topN = useGroupRun((state) => state.topN)
  const setTopN = useGroupRun((state) => state.setTopN)
  const runName = useGroupRun((state) => state.runName)
  const setRunName = useGroupRun((state) => state.setRunName)
  const history = useGroupRun((state) => state.history)
  const historyLoading = useGroupRun((state) => state.historyLoading)
  const historyError = useGroupRun((state) => state.historyError)
  const loadHistory = useGroupRun((state) => state.loadHistory)
  const loadRun = useGroupRun((state) => state.loadRun)

  const edfParams = useEdfParams((state) => state.params)
  const bandOptions = bandKeyOptions(meta.data)

  return (
    <>
      <Panel
        title="Участники группы"
        hint="Записи с результатами пакета автоотчёта (GET /sessions → уникальные записи). Порядок выбора — порядок колонок тепловой карты. Расчёт читает последний прогон каждой записи."
      >
        <div className="space-y-1.5" data-testid="group-members">
          {candidates.map((candidate) => (
            <CheckboxRow
              key={candidate.id}
              label={candidate.label}
              hint={candidate.id}
              checked={recordingIds.includes(candidate.id)}
              onChange={() => toggleRecording(candidate.id)}
            />
          ))}
          {candidates.length === 0 ? (
            <p className="text-sm text-fg-2">
              Нет записей с результатами — запустите автоотчёт на записи (раздел «Итоги»).
            </p>
          ) : null}
        </div>
        <FieldRow label="Выбрано">
          <div className="flex items-center justify-between gap-2">
            <span className="tnum text-sm text-fg-1" data-testid="group-members-count">
              {`${recordingIds.length} из ${candidates.length}`}
            </span>
            <Button disabled={!recordingIds.length} onClick={clearRecordings}>
              Снять все
            </Button>
          </div>
        </FieldRow>
      </Panel>

      <Panel
        title="Групповые фильтры (§3.5)"
        hint="Всё считается внутри одной полосы: GOF и амплитуда между полосами не сравнимы (принцип 3). Правка ничего не запускает — считает кнопка «Считать»."
      >
        <SelectField
          label="Диапазон (полоса)"
          value={bandKey}
          options={bandOptions}
          onChange={setBandKey}
          hint="Адресация band_key пакета: freq_bands + функциональные ритмы"
        />
        <TextField
          label="Отбор точек: GOF ≥"
          value={gofMin}
          onChange={setGofMin}
          placeholder="0.8"
          hint="Число 0..1; пусто — все точки полосы. При отборе сверка счётчиков отчёта отключается"
        />
        <TextField
          label="Длина эпохи прогона, мс"
          value={epochLengthMs}
          onChange={setEpochLengthMs}
          placeholder="2000"
          hint={`Пусто — любая; текущая форма EDF: ${edfParams.epochLengthMs} мс`}
        />
        <TextField
          label="Дата прогона с"
          value={dateFrom}
          onChange={setDateFrom}
          placeholder="2026-10-01"
          hint="ГГГГ-ММ-ДД (UTC); пусто — без нижней границы"
        />
        <TextField
          label="Дата прогона по"
          value={dateTo}
          onChange={setDateTo}
          placeholder="2026-10-31"
          hint="ГГГГ-ММ-ДД (UTC); пусто — без верхней границы"
        />
        <TextField
          label="Только строки (BA/структуры)"
          value={names}
          onChange={setNames}
          placeholder="BA7-lh, таламус (слева)"
          hint="Через запятую; сужает вывод строк, но не знаменатель доли"
        />
        <NumberField
          label="Максимум строк"
          value={topN}
          onChange={setTopN}
          min={1}
          max={100}
          step={1}
          hint="Топ по числу точек в каждом словаре (как TOP_ROI отчёта)"
        />
        <TextField
          label="Подпись прогона"
          value={runName}
          onChange={setRunName}
          placeholder="покой vs деятельность"
          hint="Для истории («Сохранить прогон»); пусто — без имени"
        />
      </Panel>

      <Panel
        title="История прогонов"
        hint="Снимок определения (фильтры + состав): числа не заморожены — клик пересчитывает по живой БД на сервере (§8.4.2, история не UPSERT)."
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-sm text-fg-2">
            {history === null ? 'История не запрашивалась' : `Прогонов: ${history.length}`}
          </span>
          <Button
            disabled={historyLoading}
            onClick={() => void loadHistory()}
            data-testid="group-history-reload"
          >
            {historyLoading ? 'Загрузка…' : 'Обновить'}
          </Button>
        </div>
        {historyError ? (
          <p className="text-sm text-warn" data-testid="group-history-error">
            {historyError}
          </p>
        ) : null}
        <ul className="space-y-1" data-testid="group-history">
          {(history ?? []).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-left text-sm text-fg-1 hover:bg-bg-3"
                onClick={() => void loadRun(item.id)}
                data-testid={`group-history-run-${item.id}`}
              >
                <span className="font-medium text-fg-0">
                  {item.name || `Прогон №${item.id}`}
                </span>
                <span className="tnum ml-2 text-fg-2">
                  {`${item.band_key ?? ''} · записей ${item.n_members_alive}/${item.n_sessions_requested}`}
                </span>
              </button>
            </li>
          ))}
          {history !== null && history.length === 0 ? (
            <li className="text-sm text-fg-2">Сохранённых прогонов нет.</li>
          ) : null}
        </ul>
      </Panel>
    </>
  )
}

