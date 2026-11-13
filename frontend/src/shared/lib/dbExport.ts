/**
 * Экспорт выборки записей раздела «БД»: CSV, JSON и сводный HTML-отчёт —
 * готовность и параметры записанных прогонов для разбора вне приложения.
 *
 * Формат CSV следует `groupExport.ts`/`summaryExport.ts`: разделитель —
 * запятая, значения экранируются по RFC 4180. JSON — те же строки контракта
 * (`RecordingReadiness`) без потерь, «отчёт» — читаемый HTML-документ по
 * выборке (паспорта, готовность, параметры каждой стадии), самодостаточный:
 * стили внутри, открывается и без сервера. Клиентские, без запросов: данные
 * уже в строках таблицы (выборка собирается до вызова).
 */
import type { ReadinessStage, RecordingReadiness } from '@/shared/api/types'
import {
  STAGE_ORDER,
  formatDate,
  groupByPatient,
  readinessText,
  stageLabel,
  stageParamLines,
  stageSummary,
} from '@/shared/lib/dbTable'

/** Значение ячейки → CSV-поле с экранированием запятых/кавычек (RFC 4180). */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

/** Текст → HTML-текст: имена файлов/псевдонимы приходят «как есть». */
function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Готово/нет стадии словами (в выгрузках — не «✔/—», а читаемый статус). */
function stateText(state: string): string {
  return state === 'ready' ? 'готово' : 'нет'
}

/** Имя файла экспорта (по образцу `groupCsvFilename`). */
export function dbSelectionFilename(): string {
  return 'diplock-db-recordings.csv'
}

/** Имя файла JSON-экспорта выборки. */
export function dbSelectionJsonFilename(): string {
  return 'diplock-db-recordings.json'
}

/** Имя файла сводного HTML-отчёта по выборке. */
export function dbSelectionReportFilename(): string {
  return 'diplock-db-recordings.html'
}

/** JSON выборки: строки контракта как есть + метка выгрузки (schema_version). */
export function dbSelectionJson(
  rows: RecordingReadiness[],
  exportedAt: string = new Date().toISOString(),
): string {
  return JSON.stringify(
    { schema_version: 1, exported_at: exportedAt, recordings: rows },
    null,
    2,
  )
}

/** Сводка выборки записей в CSV: шапка + одна строка на запись. */
export function dbSelectionCsv(rows: RecordingReadiness[]): string {
  const headers = [
    'id_записи',
    'файл',
    'псевдоним',
    'каналов',
    'частота_Гц',
    'длительность_с',
    'зарегистрирована',
    'готовность',
    'готово_стадий',
    'всего_стадий',
    ...STAGE_ORDER.flatMap((key) => {
      const label = stageLabel(key)
      return [
        `${label}:статус`,
        `${label}:прогонов`,
        `${label}:последний`,
        `${label}:параметры`,
      ]
    }),
  ]
  const lines = [headers.map(cell).join(',')]
  for (const row of rows) {
    const stages = new Map((row.stages ?? []).map((stage) => [stage.stage, stage]))
    lines.push(
      [
        row.recording_id,
        row.filename,
        row.patient_alias,
        row.n_channels,
        row.sfreq,
        row.duration_sec,
        row.created_at,
        readinessText(row),
        row.readiness_ready,
        row.readiness_total,
        ...STAGE_ORDER.flatMap((key) => {
          const stage = stages.get(key)
          return [
            stage ? stateText(stage.state) : 'нет',
            stage?.n_runs ?? 0,
            formatDate(stage?.last_run_at),
            stage ? stageSummary(stage) : '—',
          ]
        }),
      ]
        .map(cell)
        .join(','),
    )
  }
  return lines.join('\n')
}

/** Блок «подпись → значение» параметров стадии в HTML-отчёте (пустые — мимо). */
function reportStageHtml(stage: ReadinessStage): string {
  const lines = stageParamLines(stage.params).filter((line) => line.value !== '—')
  const summary = stageSummary(stage)
  return `
    <section class="stage">
      <h4>${escapeHtml(stageLabel(stage.stage))}: ${escapeHtml(stateText(stage.state))}
        <span class="muted">прогонов: ${stage.n_runs}${
          stage.last_run_at ? ` · последний ${escapeHtml(formatDate(stage.last_run_at))}` : ''
        }</span>
      </h4>
      ${summary !== '—' ? `<p class="summary">${escapeHtml(summary)}</p>` : ''}
      ${
        lines.length > 0
          ? `<dl>${lines
              .map(
                (line) =>
                  `<dt>${escapeHtml(line.label)}</dt><dd>${escapeHtml(line.value)}</dd>`,
              )
              .join('')}</dl>`
          : '<p class="muted">Параметры прогона не записаны.</p>'
      }
    </section>`
}

/**
 * Сводный HTML-отчёт по выборке записей: одна секция на запись, стадии с
 * параметрами последних прогонов. Самодостаточный документ (стили внутри) —
 * печатается и пересылается без приложения; `None` контракта — прочерк «—».
 */
export function dbSelectionReport(
  rows: RecordingReadiness[],
  exportedAt: string = new Date().toISOString(),
): string {
  const groups = groupByPatient(rows)
  const sections = groups
    .map((group) => {
      const recordings = group.rows
        .map((row) => {
          const stages = new Map((row.stages ?? []).map((stage) => [stage.stage, stage]))
          return `
    <article class="recording">
      <h3>${escapeHtml(row.filename ?? row.recording_id)}
        <span class="muted">${escapeHtml(row.recording_id)}</span>
      </h3>
      <table>
        <tr><th>Испытуемый</th><td>${escapeHtml(row.patient_alias ?? '—')}</td></tr>
        <tr><th>Каналы / частота</th><td class="num">${escapeHtml(row.n_channels)} кан. · ${escapeHtml(row.sfreq)} Гц</td></tr>
        <tr><th>Длительность</th><td class="num">${escapeHtml(row.duration_sec)} с</td></tr>
        <tr><th>Зарегистрирована</th><td class="num">${escapeHtml(formatDate(row.created_at))}</td></tr>
        <tr><th>Готовность</th><td><strong>${escapeHtml(readinessText(row))}</strong> стадий с записанными результатами</td></tr>
      </table>
      ${STAGE_ORDER.map((key) =>
        reportStageHtml(
          stages.get(key) ?? {
            stage: key,
            state: 'none',
            n_runs: 0,
            last_run_at: null,
            job_id: null,
            params_sig: null,
            params: null,
            runs: [],
          },
        ),
      ).join('')}
    </article>`
        })
        .join('')
      return `<section class="patient"><h2>Испытуемый: ${escapeHtml(group.label)}
        <span class="muted">записей: ${group.rows.length}</span></h2>${recordings}</section>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>DipLock — записи и результаты (выборка)</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; color: #1a1a1a; margin: 2rem auto; max-width: 60rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
  h3 { font-size: 1.05rem; margin-bottom: .25rem; } h4 { font-size: .95rem; margin: .75rem 0 .25rem; }
  .muted { color: #666; font-weight: normal; font-size: .85em; }
  .summary { margin: .25rem 0; }
  table { border-collapse: collapse; margin: .5rem 0; }
  th, td { border: 1px solid #ccc; padding: .25rem .6rem; text-align: left; }
  th { background: #f2f2f2; font-weight: 600; }
  td.num { font-variant-numeric: tabular-nums; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; margin: .25rem 0; }
  dt { color: #555; } dd { margin: 0; }
  article.recording { border-left: 3px solid #888; padding-left: 1rem; margin: 1rem 0; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>DipLock — записи и результаты (выборка)</h1>
<p class="muted">Сформировано ${escapeHtml(exportedAt)} · записей: ${rows.length} ·
данные — результаты, записанные в БД (расчёты не запускались); «—» — «не измерено».</p>
${sections}
</body>
</html>`
}