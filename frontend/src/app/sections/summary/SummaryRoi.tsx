/**
 * Вкладка «ROI» раздела «Итоги» (4.5): строки ROI × полоса из агрегата
 * `ReportResult.roi` — «надёжные» точки (GOF ≥ порога), доли эпох, медианные
 * GOF/КД внутри полосы и асимметрия полушарий.
 *
 * Только просмотр готового результата: селект полосы и экспорт CSV — локальное
 * состояние и скачивание, запросов нет (правило «правка не запускает расчёт»).
 * Обязательная подпись — принцип 3 `docs/rules/dipoles.md`: GOF сравнивается
 * только **внутри** выбранной полосы, между полосами — по долям и RIV.
 */
import { useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import type { RoiAggregate, RoiRow } from '@/shared/api/types'
import { downloadText } from '@/shared/lib/download'
import { roiCsv, roiCsvFilename } from '@/shared/lib/summaryExport'
import { SelectField } from '@/shared/ui/SelectField'

const HEMISPHERE_RU: Record<string, string> = {
  lh: 'слева',
  rh: 'справа',
  mid: 'срединная',
}

/** Число с фиксированной точностью; null/undefined — честное «—». */
function num(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits)
}

/** Таблица одного словаря ROI (структуры или поля) для выбранной полосы. */
function RoiTable({
  title,
  rows,
  bandKey,
  threshold,
}: {
  title: string
  rows: RoiRow[]
  bandKey: string
  threshold: number
}) {
  if (rows.length === 0) {
    return (
      <div>
        <h4 className="mb-1 text-sm font-medium text-fg-1">{title}</h4>
        <p className="text-sm text-fg-2">не названы (атлас недоступен?)</p>
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-sm font-medium text-fg-1">{title}</h4>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-fg-2">
            <th className="py-1 pr-2 font-normal">Название</th>
            <th className="py-1 pr-2 font-normal">Полушарие</th>
            <th className="py-1 pr-2 text-right font-normal">Точек в полосе</th>
            <th className="py-1 pr-2 text-right font-normal">Доля, %</th>
            <th className="py-1 pr-2 text-right font-normal">{`GOF ≥ ${threshold}`}</th>
            <th className="py-1 pr-2 text-right font-normal">Медианный GOF</th>
            <th className="py-1 text-right font-normal">Медианная КД, нАм</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cell = row.bands?.[bandKey]
            return (
              <tr key={row.name} className="border-b border-border/50">
                <td className="py-1 pr-2 text-fg-1">{row.name}</td>
                <td className="py-1 pr-2 text-fg-2">
                  {HEMISPHERE_RU[row.hemisphere] ?? '—'}
                </td>
                <td className="tnum py-1 pr-2 text-right text-fg-1">
                  {cell ? cell.count : '—'}
                </td>
                <td className="tnum py-1 pr-2 text-right text-fg-1">
                  {cell ? (cell.share * 100).toFixed(1) : '—'}
                </td>
                <td className="tnum py-1 pr-2 text-right text-accent" data-testid="roi-gof-pass">
                  {cell ? cell.gof_pass : '—'}
                </td>
                <td className="tnum py-1 pr-2 text-right text-fg-1">
                  {cell ? num(cell.median_gof, 3) : '—'}
                </td>
                <td className="tnum py-1 text-right text-fg-1">
                  {cell ? num(cell.median_amplitude_nam, 2) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function SummaryRoi({ roi }: { roi: RoiAggregate | null }) {
  const bands = useMemo(() => roi?.bands ?? [], [roi])
  const [bandKey, setBandKey] = useState(() => bands[0] ?? '')

  if (!roi) {
    return (
      <p className="text-sm text-fg-2" data-testid="summary-roi-missing">
        ROI-агрегат отсутствует: отчёт собран до появления поля — пересоберите
        отчёт кнопкой в шапке.
      </p>
    )
  }
  if (roi.n_points_total === 0) {
    return (
      <p className="text-sm text-fg-2" data-testid="summary-roi-empty">
        В пакете нет точек — агрегат ROI не посчитан.
      </p>
    )
  }

  const active = bandKey && bands.includes(bandKey) ? bandKey : (bands[0] ?? '')
  const structures = roi.structures ?? []
  const brodmann = roi.brodmann ?? []
  const hemi = roi.hemisphere_counts ?? {}
  const total = roi.n_points_total
  const options = bands.map((key) => ({ value: key, label: key }))
  const hiddenStructures = roi.n_structure_names - structures.length
  const hiddenBrodmann = roi.n_brodmann_names - brodmann.length

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-bg-2 p-3"
      data-testid="summary-roi"
    >
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          layout="inline"
          label="Полоса"
          value={active}
          options={options}
          onChange={setBandKey}
        />
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-1 px-3 py-1.5 text-sm text-fg-1 hover:bg-bg-3"
          onClick={() => downloadText(roiCsvFilename(active), roiCsv(roi, active))}
          data-testid="summary-roi-export"
        >
          <Download className="size-4" aria-hidden />
          Скачать CSV
        </button>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="summary-roi-meta">
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`точек: ${total} · порог GOF ≥ ${roi.gof_threshold} (внутри полосы)`}
        </span>
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`структуры: ${structures.length} из ${roi.n_structure_names}`}
        </span>
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`поля БА: ${brodmann.length} из ${roi.n_brodmann_names}`}
        </span>
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`полушария: слева ${hemi.lh ?? 0} · справа ${hemi.rh ?? 0} · срединные ${hemi.mid ?? 0}`}
        </span>
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`без структуры: ${roi.n_without_structure}`}
        </span>
      </div>

      <p className="text-sm text-fg-2">
        {`GOF ≥ ${roi.gof_threshold} и медиана GOF считаются только внутри выбранной полосы «${active}»: между полосами GOF не сравним (узкая полоса завышает R²) — сравнивайте полосы по долям и RIV. Доля — доля точек (эпох) полосы, чья лучшая локализация попала в ROI; полушарие — производная от имени атласа.`}
        {hiddenStructures > 0 || hiddenBrodmann > 0
          ? ` Показан топ: скрыто структур — ${hiddenStructures}, полей — ${hiddenBrodmann} (полный счёт — в БД результата).`
          : ''}
      </p>

      <RoiTable
        title="Анатомические структуры"
        rows={structures}
        bandKey={active}
        threshold={roi.gof_threshold}
      />
      <RoiTable
        title="Поля Бродмана"
        rows={brodmann}
        bandKey={active}
        threshold={roi.gof_threshold}
      />
    </div>
  )
}
