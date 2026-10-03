/**
 * Экспорт сводки группового анализа в CSV (§3.5, срез G3): клиентский, без
 * запросов — данные уже в `GroupAggregateOut`.
 *
 * Формат — плоская таблица «словарь × строка × запись»: сначала строки
 * агрегата (две доли: от всех точек выборки и от своих точек записи), затем
 * ячейки каждой записи (count и share). Разделитель — запятая (как в
 * `summaryExport.ts`), значения экранируются по RFC 4180. GOF и амплитуды —
 * внутри полосы (принцип 3 `docs/rules/dipoles.md`): полоса подписана в шапке.
 */
import type { GroupAggregateOut } from '@/shared/api/types'

/** Значение ячейки → CSV-поле с экранированием запятых/кавычек. */
function cell(value: string | number | null): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? formatNumber(value) : String(value)
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

/** Число без лишних нулей: доли/битые float вида 0.5555555 → 0.5556. */
function formatNumber(value: number): string {
  return String(Math.round(value * 10000) / 10000)
}

/** Доля 0..1 → проценты с одним знаком. */
function pct(share: number | null | undefined): string {
  return share === null || share === undefined ? '' : (share * 100).toFixed(1)
}

export function groupCsv(result: GroupAggregateOut): string {
  const participants = result.participants ?? []
  const filters = result.filters
  const lines: string[] = [
    [
      'словарь',
      'строка',
      'полушарие',
      'точек_группы',
      'доля_группы_ %',
      'средний_GOF',
      'медианный_GOF',
      'СТОД_GOF',
      'средняя_ампл_нАм',
      'СТОД_ампл_нАм',
      'записей_с_строкой',
      ...participants.flatMap((participant) => [
        `${participant.recording_id}_точек`,
        `${participant.recording_id}_доля_ %`,
      ]),
    ].map(cell).join(','),
  ]
  const dictionaries: [string, GroupAggregateOut['structures']][] = [
    ['структура', result.structures ?? []],
    ['поле_БА', result.brodmann ?? []],
  ]
  for (const [type, table] of dictionaries) {
    for (const row of table ?? []) {
      const cells = participants.map((participant) => {
        const rowCell = row.cells?.find((item) => item.recording_id === participant.recording_id)
        return [rowCell?.count ?? 0, pct(rowCell?.share)] as const
      })
      lines.push(
        [
          type,
          row.name,
          row.hemisphere,
          row.count,
          pct(row.share),
          row.mean_gof ?? '',
          row.median_gof ?? '',
          row.std_gof ?? '',
          row.mean_amplitude_nam ?? '',
          row.std_amplitude_nam ?? '',
          row.n_sessions,
          ...cells.flat(),
        ].map(cell).join(','),
      )
    }
  }
  const meta = [
    `# полоса: ${filters.band_key} (${filters.band_hz?.join('–')} Гц)`,
    `# отбор точек GOF: ${filters.gof_min ?? 'без отбора'}`,
    `# доля_группы — от всех точек выборки; доля записи — от точек своей записи`,
    `# записей в группе: ${participants.length}; точек: ${result.n_points_total}`,
  ]
  return `${meta.join('\n')}\n${lines.join('\n')}\n`
}

/** Имя файла: полоса в имени — файлов по полосам несколько. */
export function groupCsvFilename(bandKey: string): string {
  return `diplock-group-${bandKey}.csv`
}
