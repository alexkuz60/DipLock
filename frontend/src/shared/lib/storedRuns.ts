/**
 * Показ сохранённого прогона пакета в разделе «Диполи»: сборка
 * `DipoleBatchResult` из строк БД (`GET /analyses/{id}` + `GET /analyses/{id}/points`).
 *
 * Показ прогона — **не расчёт** (история не UPSERT, §8.4.2
 * `docs/rules/results-db.md`): полный контракт результата живёт в файле задачи
 * (`result_url` прогона) и берётся оттуда; этот модуль — запасной путь, когда
 * файл задачи не сохранился (лимит `JOB_RESULT_MAX_BYTES`, очистка). БД хранит
 * точки «эпоха × поддиапазон» и статусы полос, но **не** хранит кластеры,
 * сопоставление полос, отбраковку эпох и сетевой фильтр прогона —
 * восстановленный набор честно показывает эти поля пустыми (`null`/`[]`),
 * а не выдумывает их («—», а не 0 — инвариант read-API).
 *
 * Чистый модуль: только маппинг строк → контракт, без запросов и DOM.
 */
import { bandLabel as bandKeyLabel } from './spectrum'
import type {
  AnalysisDetail,
  AnalysisSummary,
  DipoleBandRun,
  DipoleBatchPoint,
  DipoleBatchResult,
  DipolePoint,
} from '@/shared/api/types'

/** Результат сборки: набор пакета + честный счётчик неотображаемых точек. */
export type StoredBatch = {
  batch: DipoleBatchResult
  /** Точек без координат головы пропущено: их не нарисовать в проекциях */
  skippedPoints: number
}

/** Паспорт полосы пакета в БД (`analysis_bands`) — производный тип read-API. */
type StoredBandRow = NonNullable<AnalysisDetail['bands']>[number]

/**
 * Подпись полосы для показанного прогона: ключи каталога именуются из
 * `BAND_LABELS` (`spectrum.ts`), «свои» диапазоны (`custom:от-до`) — честной
 * подписью, а не адресом в списке.
 */
function storedBandLabel(bandKey: string): string {
  if (bandKey.startsWith('custom:')) return 'Своя полоса'
  return bandKeyLabel(bandKey)
}

/** Медиана измеренных значений; `null` — измерений нет («не измерено», не 0). */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Одна строка БД → точка пакета. `null` — точка без координат головы
 * (её не показать в проекциях и нечестно рисовать в (0, 0, 0)); такие строки
 * считаются `skippedPoints`, а не выбрасываются молча.
 */
function storedPointOf(row: DipolePoint): DipoleBatchPoint | null {
  if (!row.head_coords || row.head_coords.length !== 3) return null
  return {
    epoch_index: row.epoch_index ?? 0,
    time_ms: row.peak_time_ms ?? 0,
    head_coords: row.head_coords,
    mni_coords: row.mni_coords && row.mni_coords.length === 3 ? row.mni_coords : null,
    // Момент мог не сохраниться — нулевой вектор честно «без направления»
    // (slerp-фолбэки отрисовки рисуют его нейтрально), а не выдуманное «вверх»
    moment: row.moment_dir && row.moment_dir.length === 3 ? row.moment_dir : [0, 0, 0],
    amplitude_nam: row.amplitude_nam ?? 0,
    gof: row.gof ?? 0,
    // RIV/CI в БД не пишутся — «не измерено», а не 0 (2.6/N23)
    riv: null,
    ci_mm: null,
    anatomical_structure: row.anatomical_structure ?? null,
    brodmann_area: row.brodmann_area ?? null,
    structure_distance_mm: null,
    brodmann_distance_mm: null,
    outside_brain: null,
    // Вердикт КД: 1/0 → true/false; NULL — «не оценено» (§8.4 п.5)
    kd_passed: row.kd_passed === 1 ? true : row.kd_passed === 0 ? false : null,
  }
}

/** Точки одной полосы; неотображаемые (без координат) считаются пропущенными. */
function storedPointsOf(rows: readonly DipolePoint[]): {
  points: DipoleBatchPoint[]
  skipped: number
} {
  const points: DipoleBatchPoint[] = []
  let skipped = 0
  for (const row of rows) {
    const point = storedPointOf(row)
    if (point) points.push(point)
    else skipped += 1
  }
  return { points, skipped }
}

/** Статус полосы прогона из БД (B7 `per_band_status`) с её точками. */
function storedBandRun(
  band: StoredBandRow | null,
  bandKey: string,
  bandHz: [number, number],
  rows: readonly DipolePoint[],
  run: Pick<AnalysisSummary, 'n_epochs_total' | 'n_epochs_used'>,
): DipoleBandRun {
  const { points, skipped } = storedPointsOf(rows)
  const kdBasis = rows.find((row) => row.kd_basis != null)?.kd_basis ?? {}
  return {
    band_key: bandKey,
    label: storedBandLabel(bandKey),
    band_hz: bandHz,
    state: band?.state ?? (points.length > 0 ? 'ok' : 'empty'),
    n_points: band?.n_points ?? points.length,
    n_kd_passed: band?.n_kd_passed ?? null,
    n_errors: band?.n_errors ?? 0,
    moment_max_nam: band?.moment_max_nam ?? null,
    median_gof: medianOf(points.map((point) => point.gof)),
    kd_basis: kdBasis,
    n_epochs_total: run.n_epochs_total ?? null,
    n_epochs_used: run.n_epochs_used ?? null,
    // Сетка отбраковки в БД не сохраняется — пустой список «не восстановлено»
    bad_epoch_indexes: [],
    points,
    warnings:
      skipped > 0
        ? [`Точек без координат не показано: ${skipped} (координаты в БД не сохранены)`]
        : [],
  }
}

/**
 * Сборка набора пакета из паспорта прогона и его точек.
 *
 * Полосы идут в порядке `analysis_bands` (пустые — тоже видны); точки полос,
 * которых нет в паспорте (старые прогоны), подключаются своей полосой с
 * границами из строк. `comparison`/`clusters` остаются пустыми: эти агрегаты
 * БД не хранит, и считать их на клиенте нельзя — разъехавшиеся с сервером
 * числа читались бы как баг (правило ROI-анализа, `docs/rules/dipoles.md`).
 */
export function batchFromStoredPoints(
  detail: AnalysisDetail,
  rows: readonly DipolePoint[],
): StoredBatch {
  const run: Pick<AnalysisSummary, 'n_epochs_total' | 'n_epochs_used'> = detail
  const rowsByBand = new Map<string, DipolePoint[]>()
  for (const row of rows) {
    const key = row.band_key ?? ''
    const list = rowsByBand.get(key)
    if (list) list.push(row)
    else rowsByBand.set(key, [row])
  }

  const bands: DipoleBandRun[] = []
  let skippedPoints = 0
  const pushBand = (
    band: StoredBandRow | null,
    bandKey: string,
    bandHz: [number, number],
    bandRows: readonly DipolePoint[],
  ): void => {
    const built = storedBandRun(band, bandKey, bandHz, bandRows, run)
    skippedPoints += bandRows.length - (built.points?.length ?? 0)
    bands.push(built)
  }

  const seen = new Set<string>()
  for (const band of detail.bands ?? []) {
    const key = band.band_key ?? ''
    seen.add(key)
    pushBand(band, key, [band.band_hz_lo ?? 0, band.band_hz_hi ?? 0], rowsByBand.get(key) ?? [])
  }
  for (const [key, bandRows] of rowsByBand) {
    if (seen.has(key)) continue
    const first = bandRows[0]
    pushBand(null, key, [first?.band_hz_lo ?? 0, first?.band_hz_hi ?? 0], bandRows)
  }

  return {
    batch: {
      recording_id: detail.recording_id ?? '',
      method: detail.kind ?? 'fast_grid',
      params_sig: detail.params_sig ?? '',
      reference: detail.reference ?? 'average',
      reference_channels: null,
      channels: detail.channels ?? [],
      sfreq: detail.sfreq ?? null,
      epoch_length_ms: detail.epoch_length_ms ?? 0,
      // Сетевой фильтр прогона в БД не сохранён — честное «не измерено»
      notch_hz: null,
      grid_mm: detail.grid_mm ?? 0,
      bands,
      comparison: [],
      clusters: [],
      // Паспорт кластеризации не сохранялся: кластеров в показе нет (пустая
      // вкладка паспорт не читает), значения-заглушки наружу не показываются
      cluster_params: {
        voxel_norm: 0,
        voxel_mm: 0,
        min_points: 0,
        connectivity: 0,
        basis: 'не восстановлено',
        basis_mm: 0,
        kd_filter: null,
      },
      warnings: [],
      duration_sec_calc: detail.duration_sec_calc ?? 0,
    },
    skippedPoints,
  }
}