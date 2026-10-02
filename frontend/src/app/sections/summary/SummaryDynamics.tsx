/**
 * Часть 3 «Итогов» (§3.9.6): динамика структур/BA **на клиенте** — переключение
 * полос пакета, таймлайн топ-структур по 5 бинам, таблицы топов и экспорт CSV.
 *
 * Только просмотр готового результата (`ReportResult.bands`): переключение вида
 * и полосы — локальное состояние, ничего не пересчитывает (правило «правка не
 * запускает расчёт»). Сам документ MNE.Report живёт во вкладке «Документ» —
 * здесь те же числа, но в управляемых таблицах.
 */
import { useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import type { ReportBandSummary } from '@/shared/api/types'
import { downloadText } from '@/shared/lib/download'
import { bandCsvFilename, bandSummaryCsv } from '@/shared/lib/summaryExport'
import { SelectField } from '@/shared/ui/SelectField'

/** Число с фиксированной точностью; null — честное «—». */
function num(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits)
}

function pctText(share: number): string {
  return (share * 100).toFixed(1)
}

/** Строка топа: поле опционально в схеме — берём элемент массива без undefined. */
type NameRow = NonNullable<ReportBandSummary['top_structures']>[number]

function NameTable({ title, rows }: { title: string; rows: NameRow[] }) {
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
            <th className="py-1 pr-2 text-right font-normal">Эпох активно</th>
            <th className="py-1 pr-2 text-right font-normal">Доля, %</th>
            <th className="py-1 text-right font-normal">Медианный GOF</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-border/50">
              <td className="py-1 pr-2 text-fg-1">{row.name}</td>
              <td className="tnum py-1 pr-2 text-right text-fg-1">{row.count}</td>
              <td className="tnum py-1 pr-2 text-right text-fg-1">{pctText(row.share)}</td>
              <td className="tnum py-1 text-right text-fg-1">{num(row.median_gof, 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Таймлайн: доля эпох бина по топ-структурам — таблица с поперечными барами. */
function TimelineTable({ band }: { band: ReportBandSummary }) {
  const bins = band.dynamics?.[0]?.shares.length ?? 5
  if ((band.dynamics ?? []).length === 0) {
    return <p className="text-sm text-fg-2">нет атрибуции — динамика не посчитана</p>
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-fg-2">
          <th className="py-1 pr-2 font-normal">Структура</th>
          {Array.from({ length: bins }, (_, index) => (
            <th key={index} className="py-1 pr-2 text-right font-normal">
              {`Бин ${index + 1}, %`}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(band.dynamics ?? []).map((row) => (
          <tr key={row.name} className="border-b border-border/50">
            <td className="py-1.5 pr-2 text-fg-1">{row.name}</td>
            {row.shares.map((share, index) => (
              <td key={index} className="py-1.5 pr-2">
                <div className="flex items-center justify-end gap-1.5">
                  <span
                    className="h-2 rounded bg-accent/70"
                    style={{ width: `${Math.round(share * 100)}%` }}
                    aria-hidden
                  />
                  <span className="tnum text-right text-fg-1">{pctText(share)}</span>
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function SummaryDynamics({ bands }: { bands: ReportBandSummary[] }) {
  const [bandKey, setBandKey] = useState(() => bands[0]?.band_key ?? '')
  const options = useMemo(
    () =>
      bands.map((band) => ({
        value: band.band_key,
        label: `${band.band_key} (${band.band_hz[0]}–${band.band_hz[1]} Гц)`,
      })),
    [bands],
  )
  const band = bands.find((item) => item.band_key === bandKey) ?? bands[0]

  if (bands.length === 0 || !band) {
    return <p className="text-sm text-fg-2">Пакет пуст — агрегатов нет.</p>
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-bg-2 p-3"
      data-testid="summary-dynamics"
    >
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          layout="inline"
          label="Полоса"
          value={band.band_key}
          options={options}
          onChange={setBandKey}
        />
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-1 px-3 py-1.5 text-sm text-fg-1 hover:bg-bg-3"
          onClick={() => downloadText(bandCsvFilename(band), bandSummaryCsv(band))}
          data-testid="summary-dynamics-export"
        >
          <Download className="size-4" aria-hidden />
          Скачать CSV
        </button>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="summary-dynamics-meta">
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`эпох: ${band.n_epochs_used} · точек: ${band.n_points}`}
        </span>
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`без атрибуции: ${band.n_no_attribution}`}
        </span>
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`GOF (внутри полосы): ${num(band.median_gof, 3)}`}
        </span>
        <span className="tnum rounded-full bg-bg-3 px-2 py-0.5 text-xs text-fg-2">
          {`RIV (кросс-полосной): ${num(band.median_riv, 3)}`}
        </span>
      </div>

      {(band.warnings ?? []).length > 0 ? (
        <ul className="space-y-1 text-sm text-warn">
          {(band.warnings ?? []).map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      ) : null}

      <h4 className="text-sm font-medium text-fg-1">
        Таймлайн топ-структур (5 бинов по эпохам)
      </h4>
      <TimelineTable band={band} />

      <NameTable title="Активные структуры (топ по числу эпох)" rows={band.top_structures ?? []} />
      <NameTable title="Поля Бродмана (топ по числу эпох)" rows={band.top_brodmann ?? []} />

      <p className="text-xs text-fg-2">
        GOF между полосами не сравним (узкая полоса завышает R²) — кросс-полосной фильтр
        только по RIV/CI (docs/rules/dipoles.md). Те же числа — в документе во вкладке
        «Документ».
      </p>
    </div>
  )
}
