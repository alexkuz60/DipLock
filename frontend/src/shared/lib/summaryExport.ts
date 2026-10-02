/**
 * Экспорт агрегатов «Итогов» в CSV (часть 3, §3.9.6): клиентский, без
 * запросов — данные уже лежат в `ReportResult.bands`.
 *
 * Формат — одна плоская таблица: тип (структура / поле_БА / динамика),
 * название, числа топа и пять бинов динамики. Разделитель — запятая (как в
 * `exportWindow.ts`), значения экранируются по RFC 4180.
 */
import type { ReportBandSummary, RoiAggregate, RoiRow } from '@/shared/api/types'

/** Значение ячейки → CSV-поле с экранированием запятых/кавычек. */
function cell(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? formatNumber(value) : String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

/** Число без лишних нулей: доли/битые float вида 0.5555555 → 55.6 / 0.8556. */
function formatNumber(value: number): string {
  return String(Math.round(value * 10000) / 10000)
}

/** Доля 0..1 → проценты с одним знаком. */
function pct(share: number | null | undefined): string {
  return share === null || share === undefined ? '' : (share * 100).toFixed(1)
}

const HEADER = [
  'тип',
  'название',
  'эпох активно',
  'доля %',
  'медианный GOF',
  'бин 1 %',
  'бин 2 %',
  'бин 3 %',
  'бин 4 %',
  'бин 5 %',
]

/** CSV одной полосы: топы структур/BA + динамика по бинам (экспорт таблицы). */
export function bandSummaryCsv(band: ReportBandSummary): string {
  const lines: string[] = [HEADER.map(cell).join(',')]
  // Все строки — по 10 колонок заголовка: парсеры не любят короткие ряды
  const emptyBins = ['', '', '', '', '']
  for (const row of band.top_structures ?? []) {
    lines.push(
      ['структура', row.name, row.count, pct(row.share), row.median_gof ?? '', ...emptyBins]
        .map(cell)
        .join(','),
    )
  }
  for (const row of band.top_brodmann ?? []) {
    lines.push(
      ['поле_БА', row.name, row.count, pct(row.share), row.median_gof ?? '', ...emptyBins]
        .map(cell)
        .join(','),
    )
  }
  for (const row of band.dynamics ?? []) {
    lines.push(
      ['динамика', row.name, '', '', '', ...row.shares.map((share) => pct(share))]
        .map(cell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

/** Имя файла экспорта: полоса в имени — файлов по полосам несколько. */
export function bandCsvFilename(band: ReportBandSummary): string {
  return `diplock-итоги-${band.band_key}.csv`
}

const ROI_HEADER = [
  'тип',
  'название',
  'полушарие',
  'полоса',
  'точек',
  'доля %',
  'GOF ≥ порога',
  'медианный GOF',
  'медианная КД нАм',
]

/**
 * CSV ROI-агрегата одной полосы (4.5): одна строка = ROI × полоса.
 *
 * Числа — ячейки выбранной полосы: GOF и порог «надёжной точки» живут только
 * внутри полосы (принцип 3 `docs/rules/dipoles.md`), поэтому в файле нет
 * межполосных итогов по GOF.
 */
export function roiCsv(roi: RoiAggregate, bandKey: string): string {
  const lines: string[] = [ROI_HEADER.map(cell).join(',')]
  const rows: [string, RoiRow[]][] = [
    ['структура', roi.structures ?? []],
    ['поле_БА', roi.brodmann ?? []],
  ]
  for (const [type, table] of rows) {
    for (const row of table) {
      const band = row.bands?.[bandKey]
      if (!band) continue
      lines.push(
        [
          type,
          row.name,
          row.hemisphere,
          bandKey,
          band.count,
          pct(band.share),
          band.gof_pass,
          band.median_gof ?? '',
          band.median_amplitude_nam ?? '',
        ].map(cell).join(','),
      )
    }
  }
  return `${lines.join('\n')}\n`
}

/** Имя файла ROI-экспорта: полоса в имени — файлов по полосам несколько. */
export function roiCsvFilename(bandKey: string): string {
  return `diplock-roi-${bandKey}.csv`
}
