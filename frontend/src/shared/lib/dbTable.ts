/**
 * Таблица готовности записей (раздел «БД»): подписи стадий, сводки параметров
 * и группировка по испытуемому — чистые функции без запросов.
 *
 * Раздел «БД» только **читает** БД (`GET /recordings/readiness`): правило «UI
 * не запускает обработку» здесь выполняется по определению, а модуль держит
 * раскладку строк (чтобы компоненты рисовали, а не считали). Поиск и
 * сортировка — серверные (шаблоны E–F `docs/rules/results-db.md`), здесь
 * только представление страницы. `None` контракта — честный прочерк «—»
 * («не измерено», а не 0) — инвариант read-API `docs/rules/results-db.md`.
 */
import type {
  ReadinessStage,
  ReadinessStageParams,
  RecordingReadiness,
} from '@/shared/api/types'
import { filterBandText } from '@/shared/lib/calcFilter'

/** Стадии готовности в порядке показа (сетка сервера `readiness.STAGES`). */
export const STAGE_ORDER = [
  'preprocess',
  'dipoles',
  'package',
  'report',
  'spectrogram',
] as const

export type StageKey = (typeof STAGE_ORDER)[number]

/** Подписи стадий для UI (ключ контракта → русское имя). */
export const STAGE_LABELS: Record<StageKey, string> = {
  preprocess: 'Препроцессинг',
  dipoles: 'Диполи',
  package: 'Полосы пакета',
  report: 'Отчёт',
  spectrogram: 'Спектрограмма',
}

/** Подпись стадии; неизвестный ключ показывается как есть (защита от опечаток). */
export function stageLabel(key: string): string {
  return STAGE_LABELS[key as StageKey] ?? key
}

/** Степень готовности строки: «4 из 5». */
export function readinessText(row: RecordingReadiness): string {
  return `${row.readiness_ready} из ${row.readiness_total}`
}

/** Прочерк для «не измерено» (инвариант read-API: None ≠ 0). */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function bandKeysText(bands: ReadinessStageParams['bands']): string {
  if (!bands || bands.length === 0) return '—'
  return bands.map((band) => band.band_key ?? '—').join(', ')
}

/**
 * Компактная сводка параметров стадии для колонки таблицы
 * (например «0.5–45 Гц · notch 50 · average · ICA»).
 */
export function stageSummary(stage: ReadinessStage): string {
  if (stage.state !== 'ready' || !stage.params) return '—'
  const p = stage.params
  const parts: string[] = []
  switch (stage.stage as StageKey) {
    case 'preprocess': {
      parts.push(filterBandText(p.filter_band_hz ?? null))
      if (p.notch_hz !== null && p.notch_hz !== undefined) parts.push(`notch ${p.notch_hz}`)
      parts.push(dash(p.reference))
      parts.push((p.clean_method ?? 'none').toUpperCase())
      if (p.epoch_length_ms !== null && p.epoch_length_ms !== undefined) {
        parts.push(`эпохи ${p.epoch_length_ms} мс`)
      }
      if (p.n_epochs_used !== null && p.n_epochs_used !== undefined) {
        parts.push(`${p.n_epochs_used}/${dash(p.n_epochs_total)}`)
      }
      break
    }
    case 'dipoles': {
      parts.push(`сетка ${dash(p.grid_mm)} мм`)
      parts.push(dash(p.method))
      if (p.n_dipoles !== null && p.n_dipoles !== undefined) {
        parts.push(`${p.n_dipoles} диполей`)
      }
      break
    }
    case 'package': {
      parts.push(`полосы: ${bandKeysText(p.bands)}`)
      parts.push(`сетка ${dash(p.grid_mm)} мм`)
      break
    }
    case 'report': {
      parts.push(`QC ${dash(p.qc_status)}`)
      if (p.good_data_percent !== null && p.good_data_percent !== undefined) {
        parts.push(`${p.good_data_percent} %`)
      }
      break
    }
    case 'spectrogram': {
      parts.push(dash(p.channel))
      parts.push(filterBandText(p.filter_band_hz ?? null))
      break
    }
  }
  return parts.join(' · ')
}

/** Строка «эпох всего/в расчёте/отбраковано» или прочерк при неполном счёте. */
function epochsText(params: ReadinessStageParams): string {
  const { n_epochs_total, n_epochs_used, n_epochs_rejected } = params
  if (n_epochs_total === null || n_epochs_total === undefined) return '—'
  return `всего ${n_epochs_total}, в расчёте ${dash(n_epochs_used)}, отбраковано ${dash(n_epochs_rejected)}`
}

/** «50 Гц (+2 гарм.)» / «—» — подпись сетевого фильтра. */
function notchText(params: ReadinessStageParams): string {
  if (params.notch_hz === null || params.notch_hz === undefined) return '—'
  return `${params.notch_hz} Гц${params.notch_harmonics ? ` (+${params.notch_harmonics} гарм.)` : ''}`
}

/**
 * Полный список «подпись → значение» параметров прогона для раскрытой строки
 * (карточка готовности). Пустые значения — прочерк «—».
 */
export function stageParamLines(
  params: ReadinessStageParams | null | undefined,
): { label: string; value: string }[] {
  if (!params) return []
  const bands = params.bands
  return [
    { label: 'Полоса фильтра', value: filterBandText(params.filter_band_hz ?? null) },
    { label: 'Notch', value: notchText(params) },
    {
      label: 'Референс',
      value:
        params.reference_channels && params.reference_channels.length > 0
          ? `${dash(params.reference)}: ${params.reference_channels.join(', ')}`
          : dash(params.reference),
    },
    {
      label: 'Чистка',
      value: dash(params.clean_method ? params.clean_method.toUpperCase() : null),
    },
    {
      label: 'Компонент ICA',
      value:
        params.ica_n_components === null || params.ica_n_components === undefined
          ? '—'
          : params.ica_n_components === 0
            ? 'auto'
            : String(params.ica_n_components),
    },
    {
      label: 'Bad-каналы',
      value:
        params.bad_channels && params.bad_channels.length > 0
          ? `${params.bad_channels.join(', ')} (${params.interpolate_bads ? 'интерполяция' : 'без интерполяции'})`
          : '—',
    },
    { label: 'Порог z', value: dash(params.z_threshold) },
    {
      label: 'Порог амплитуды',
      value:
        params.pp_threshold_uv === null || params.pp_threshold_uv === undefined
          ? '—'
          : `${params.pp_threshold_uv} мкВ`,
    },
    {
      label: 'Flat-line',
      value:
        params.flat_line_uv === null || params.flat_line_uv === undefined
          ? '—'
          : `${params.flat_line_uv} мкВ / ${dash(params.flat_line_ms)} мс`,
    },
    {
      label: 'Эпохи',
      value:
        params.epoch_length_ms === null || params.epoch_length_ms === undefined
          ? '—'
          : `${params.epoch_length_ms} мс (${dash(params.epoch_mode)})`,
    },
    {
      label: 'Окно события',
      value:
        params.epoch_mode === 'events'
          ? `${dash(params.event_id)}: −${dash(params.epoch_pre_ms)}…+${dash(params.epoch_post_ms)} мс`
          : '—',
    },
    { label: 'Нарезка эпох', value: epochsText(params) },
    {
      label: 'Шаг сетки',
      value:
        params.grid_mm === null || params.grid_mm === undefined
          ? '—'
          : `${params.grid_mm} мм`,
    },
    { label: 'Метод диполей', value: dash(params.method) },
    { label: 'Полоса прогона', value: params.freq_band ? `${params.freq_band} Гц` : '—' },
    {
      label: 'Точек/диполей',
      value:
        params.n_dipoles === null || params.n_dipoles === undefined
          ? '—'
          : String(params.n_dipoles),
    },
    {
      label: 'Полосы пакета',
      value:
        bands && bands.length > 0
          ? bands
              .map(
                (band) =>
                  `${band.band_key ?? '—'} (${dash(band.band_hz_lo)}–${dash(band.band_hz_hi)} Гц, ${band.n_points ?? 0} т.)`,
              )
              .join('; ')
          : '—',
    },
    {
      label: 'QC отчёта',
      value:
        params.qc_status === null && params.good_data_percent === null
          ? '—'
          : `${dash(params.qc_status)}${params.good_data_percent !== null ? `, ${params.good_data_percent} %` : ''}`,
    },
    { label: 'HTML отчёта', value: dash(params.html_path) },
    { label: 'Канал спектрограммы', value: dash(params.channel) },
    {
      label: 'Окно STFT',
      value:
        params.window_ms === null || params.window_ms === undefined
          ? '—'
          : `${params.window_ms} мс, перекрытие ${dash(params.overlap_pct)} %, до ${dash(params.fmax_hz)} Гц`,
    },
  ]
}

/** Дата ISO → «ДД.ММ.ГГГГ ЧЧ:ММ»; пустое — прочерк. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Ключи сортировки панели «Опции» (серверная сортировка `GET /recordings/readiness`). */
export type DbSortKey = 'created' | 'name' | 'readiness'

export const DB_SORT_LABELS: Record<DbSortKey, string> = {
  created: 'Новые сверху',
  name: 'По имени файла',
  readiness: 'По готовности',
}

export type PatientGroup = {
  /** Псевдоним испытуемого (`null` — запись без псевдонима) */
  alias: string | null
  /** Заголовок группы в UI */
  label: string
  rows: RecordingReadiness[]
}

/**
 * Группировка строк по испытуемому (`patient_alias`): у одного человека в
 * работе обычно 5–10 файлов — они читаются одной группой. Порядок групп
 * повторяет порядок строк (уже отсортирован снаружи).
 */
export function groupByPatient(rows: RecordingReadiness[]): PatientGroup[] {
  const groups = new Map<string, PatientGroup>()
  for (const row of rows) {
    const key = row.patient_alias ?? ''
    let group = groups.get(key)
    if (!group) {
      group = {
        alias: row.patient_alias ?? null,
        label: row.patient_alias ?? 'Без псевдонима',
        rows: [],
      }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()]
}