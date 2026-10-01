/**
 * Панель опций раздела «Итоги»: набор полос пакета и шаг сетки поиска.
 *
 * Панель, как и в остальных разделах, **ничего не запускает** (правило
 * `docs/ui.md`): параметры складываются в стор, а расчёт стартует только
 * кнопкой «Собрать отчёт» в шапке. Фильтр/пороги/длина эпохи части 1 —
 * параметры формы раздела EDF: здесь они показаны только для сверки
 * («с чем именно совпадут числа отчёта»), правятся в EDF.
 *
 * Набор полос: `null` в сторе — «все полосы из /meta» (дефолт); первый клик
 * раскрывает его в явный список. Пустой список — состояние «ничего не
 * выбрано»: кнопка расчёта выключена, сервер такое не получит.
 */
import { useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { api } from '@/shared/api/client'
import { bandKeyOptions } from '@/shared/lib/bandOptions'
import { filterBandText, FUNCTIONAL_GROUP } from '@/shared/lib/calcFilter'
import { GRID_MM_RANGE } from '@/shared/lib/dipoleCalcModel'
import { useEdfParams } from '@/shared/state/edfParams'
import { filterBandOf } from '@/shared/state/edfRecording'
import { useSummaryReport } from '@/shared/state/summaryReport'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { StatusPill } from '@/shared/ui/StatusPill'

export function SummaryPanel() {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.meta() })
  const options = bandKeyOptions(meta.data ?? null)
  const allKeys = options.map((option) => option.value)

  const bandKeys = useSummaryReport((state) => state.bandKeys)
  const toggleBand = useSummaryReport((state) => state.toggleBand)
  const setBandKeys = useSummaryReport((state) => state.setBandKeys)
  const gridMm = useSummaryReport((state) => state.gridMm)
  const setGridMm = useSummaryReport((state) => state.setGridMm)
  const result = useSummaryReport((state) => state.result)
  const error = useSummaryReport((state) => state.error)

  const edfParams = useEdfParams((state) => state.params)
  const active = bandKeys ?? allKeys
  const eventsMode = edfParams.epochMode === 'events'

  return (
    <>
      <Panel
        title="Полосы пакета"
        hint="Часть 2 считает диполи отдельно по каждой выбранной полосе. GOF между полосами не сравним (узкая полоса завышает R²) — сравнивать можно доли эпох и RIV (docs/rules/dipoles.md)."
      >
        {options.length === 0 ? (
          <p className="text-sm text-fg-2">Список полос придёт из /meta.</p>
        ) : (
          <>
            {options.map((option) => (
              <CheckboxRow
                key={option.value}
                label={option.label}
                hint={
                  option.group === FUNCTIONAL_GROUP
                    ? `Функциональный ритм (${option.group}) — пресеты фильтра`
                    : `Октавная полоса «${option.value}»`
                }
                checked={active.includes(option.value)}
                onChange={() => toggleBand(option.value, allKeys)}
              />
            ))}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                icon={<RotateCcw className="size-4" />}
                disabled={bandKeys === null}
                onClick={() => setBandKeys(null)}
                title="Считать все полосы из /meta (набор пакета по умолчанию)"
              >
                Все полосы
              </Button>
              <StatusPill tone={bandKeys === null ? 'accent' : 'neutral'}>
                {bandKeys === null ? 'Все полосы' : `Выбрано: ${bandKeys.length}`}
              </StatusPill>
            </div>
            {bandKeys !== null && bandKeys.length === 0 ? (
              <p className="mt-2 text-sm text-warn" data-testid="summary-no-bands">
                Не выбрана ни одна полоса — сборка отчёта недоступна.
              </p>
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        title="Расчёт"
        hint="Шаг сетки — параметр пакета (быстрый перебор узлов, как в «Диполях»). Остальные параметры части 1 — форма раздела EDF: отчёт обязан совпасть с ней числами."
      >
        <NumberField
          label="Шаг сетки"
          value={gridMm}
          onChange={setGridMm}
          min={GRID_MM_RANGE[0]}
          max={GRID_MM_RANGE[1]}
          step={1}
          unit="мм"
          hint="Мельче — точнее и дольше: число узлов растёт как шаг⁻³"
        />
        <ul className="mt-3 space-y-1 text-sm text-fg-2">
          <li>{`Длина эпохи: ${edfParams.epochLengthMs} мс (форма EDF)`}</li>
          <li>{`Фильтр: ${filterBandText(filterBandOf(edfParams))}`}</li>
          <li>{`Notch: ${edfParams.notchHz ? `${edfParams.notchHz} Гц` : 'выключен'}`}</li>
          <li>{`Референс: ${edfParams.reference}`}</li>
        </ul>
        {eventsMode ? (
          <p className="mt-2 text-sm text-warn" data-testid="summary-events-note">
            Событийная нарезка EDF в отчёт не входит: эпохи будут нарезаны фиксированной
            длиной (решение среза, docs/ui/summary.md).
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Результат"
        hint="Справка о собранном отчёте: числа приходят из задачи, сам документ — в рабочей области (HTML MNE.Report)."
      >
        <div className="mb-2 flex flex-wrap gap-2">
          <StatusPill tone={result ? 'ok' : 'neutral'}>
            {result ? 'Отчёт собран' : 'Отчёта нет'}
          </StatusPill>
          {result ? (
            <StatusPill tone="neutral">{`Полос: ${result.bands?.length ?? 0}`}</StatusPill>
          ) : null}
        </div>
        {result ? (
          <ul className="space-y-1 text-sm text-fg-2">
            <li>{`Файл: ${result.filename}`}</li>
            <li>
              {`QC: ${result.qc.status}${(result.qc.reasons ?? []).length ? ` (${(result.qc.reasons ?? []).join(', ')})` : ''}`}
            </li>
            <li>{`Эпох: ${result.n_epochs_used} из ${result.n_epochs_total}, отклонено ${result.rejected_epochs}`}</li>
            <li>{`Время расчёта: ${result.duration_sec_calc.toFixed(1)} с`}</li>
          </ul>
        ) : (
          <p className="text-sm text-fg-2">
            {error ? `Последняя попытка: ${error}` : 'Результат появится после сборки отчёта.'}
          </p>
        )}
      </Panel>
    </>
  )
}
