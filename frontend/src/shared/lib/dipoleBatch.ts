/**
 * Пакет поддиапазонов (С1/С2): чистые помощники над `DipoleBatchResult`.
 *
 * Контракт приходит с сервера (`kind=dipole_batch`): набор результатов одной
 * сессии — полосы со своими точками (ключ «эпоха × поддиапазон»), сопоставление
 * по **нормированным** величинам (GOF между полосами не сравним — принцип 3
 * `docs/rules/dipoles.md`, в строке сопоставления его нет) и кластеры с
 * устойчивостью по поддиапазонам (С2). Прогон всегда идёт по **всему каталогу**
 * полос (`freq_bands` + `functional_bands` из `/meta`): выбор полос для прогона
 * из UI убран, чекбоксы «Полосы в анимации и облаке» управляют только
 * отображением.
 *
 * Здесь — только чистые функции (форма запроса, выбор активной полосы,
 * сборка `DipoleScanResult` одной полосы для существующей отрисовки):
 * правила проверяются без хранилища и без DOM.
 */
import {
  dipoleLayerFromScan,
  type DipoleBandTag,
  type DipoleLayer,
  type DipolePoint,
} from './dipolePoints'
import { bandColor } from './bandColors'
import { pointByEpoch } from './playback'
import type {
  DipoleBatchResult,
  DipoleBandRun,
  DipoleScanResult,
} from '@/shared/api/types'

/**
 * Лимит полос одного прогона (серверный `dipole_batch_max_bands`): покрывает весь
 * каталог полос (7 октавных + 6 функциональных = 13) с запасом — пакет всегда
 * считает каталог целиком.
 */
export const BATCH_MAX_BANDS = 16

export type DipoleBatchFormInput = {
  /** Ключи полос (`alpha`, `mu`, …) в порядке прогона */
  bandKeys: string[]
  epochLengthMs: number
  gridMm: number
  notchHz: number | null
  reference: string
  referenceChannels: string | null
  /**
   * Правки порогов GOF КД по полосам, % (`null`/нет записи — дефолт методики
   * из `/meta`); в форму уходят **только заданные** значения долей 0…1.
   */
  kdGofByBand: Record<string, number | null>
  /** КД: «момент ≥ X %», %; `null` — не задано (вердикт «не оценено») */
  kdMomentSharePercent: number | null
}

/**
 * Поля КД в форме задачи (С0, 29.10.2026): `kd_gof_min_by_band` — JSON-карта
 * заданных порогов полос (доли 0…1), `kd_moment_share` — доля 0…1. Общий
 * помощник для формы пакета (`buildDipoleBatchForm`) и формы автоотчёта
 * (`buildReportForm`): вердикты `kd_passed` считаются по одним правилам.
 */
export function applyKdFormFields(
  form: FormData,
  kdGofByBand: Record<string, number | null>,
  kdMomentSharePercent: number | null,
): void {
  const fractions: Record<string, number> = {}
  for (const [key, percent] of Object.entries(kdGofByBand)) {
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      fractions[key] = percent / 100
    }
  }
  if (Object.keys(fractions).length > 0) {
    form.set('kd_gof_min_by_band', JSON.stringify(fractions))
  }
  if (typeof kdMomentSharePercent === 'number' && Number.isFinite(kdMomentSharePercent)) {
    form.set('kd_moment_share', String(kdMomentSharePercent / 100))
  }
}

/**
 * Форма задачи пакета: `bands` (ключи через запятую) + те же параметры
 * расчёта, что у одиночного быстрого расчёта, но **одна** длина эпохи на
 * весь прогон (п.7 `docs/rules/dipoles.md`).
 */
export function buildDipoleBatchForm(input: DipoleBatchFormInput): FormData {
  const form = new FormData()
  form.set('bands', input.bandKeys.join(','))
  if (input.notchHz) form.set('notch_hz', String(input.notchHz))
  form.set('epoch_length_ms', String(input.epochLengthMs))
  form.set('grid_mm', String(input.gridMm))
  if (input.reference && input.reference !== 'average') {
    form.set('reference', input.reference)
  }
  if (input.referenceChannels) {
    form.set('reference_channels', input.referenceChannels)
  }
  applyKdFormFields(form, input.kdGofByBand, input.kdMomentSharePercent)
  return form
}

/** Полоса пакета по ключу; `null` — ключа в наборе нет. */
export function bandRunOf(
  batch: DipoleBatchResult | null, bandKey: string | null,
): DipoleBandRun | null {
  if (!batch || !bandKey) return null
  return (batch.bands ?? []).find((band) => band.band_key === bandKey) ?? null
}

/**
 * Сканирование одной полосы в формате `DipoleScanResult` — чтобы существующая
 * отрисовка (проекции, playback, таблица) работала с активной полосой пакета
 * без правок. Общий паспорт (каналы, сетка, эпоха) — из прогона; точки и
 * счётчики — из своей полосы (GOF живёт внутри полосы, наружу — своим).
 */
export function scanResultOfBand(
  batch: DipoleBatchResult, band: DipoleBandRun,
): DipoleScanResult {
  return {
    recording_id: batch.recording_id,
    method: batch.method,
    reference: batch.reference ?? 'average',
    reference_channels: batch.reference_channels ?? null,
    channels: batch.channels ?? [],
    sfreq: batch.sfreq ?? 0,
    epoch_length_ms: batch.epoch_length_ms,
    filter_band_hz: band.band_hz ?? null,
    notch_hz: batch.notch_hz ?? null,
    n_epochs_total: band.n_epochs_total ?? 0,
    n_epochs_used: band.n_epochs_used ?? band.n_points,
    bad_epoch_indexes: band.bad_epoch_indexes ?? [],
    grid_mm: batch.grid_mm,
    points: band.points ?? [],
    warnings: band.warnings ?? [],
    duration_sec_calc: batch.duration_sec_calc ?? 0,
  }
}

/** Подпись полосы для чипов/таблицы: «label (lo–hi Гц)». */
export function bandLabel(band: { label: string; band_hz: number[] }): string {
  const [lo, hi] = band.band_hz
  return `${band.label} (${lo}–${hi} Гц)`
}

/**
 * Строка сопоставления одной ячейки: число + единицы, `—` для «не измерено».
 * Нормированные величины (доли 0..1) подписываются процентами — так их и
 * читает методика («X % максимума поддиапазона»).
 */
export function shareLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return `${Math.round(value * 100)}%`
}

/**
 * Тег полосы для отрисовки (С1): цвет из гаммы red→violet по границам полосы
 * (`bandColor`), стабильный ключ и подпись — из прогона. Тегом помечаются точки
 * `dipoleLayerFromScan`, по нему слои и кадр анимации рисуют полосу её цветом.
 */
export function bandTagOf(band: DipoleBandRun): DipoleBandTag {
  return {
    key: band.band_key,
    label: band.label,
    bandHz: [...band.band_hz],
    color: bandColor(band.band_hz),
  }
}

/**
 * Источник кадра анимации/облака: одна полоса (или одиночный расчёт без полосы)
 * и её точки по эпохам. Единый сборщик для часов кадра, строки анатомии и
 * подсветки поля/структуры — все обязаны видеть **одни и те же** точки, что и
 * проекции, а не «похожие».
 */
export type BandFrameSource = {
  band: DipoleBandTag | null
  points: Map<number, DipolePoint>
}

/**
 * Источники кадра по чекбоксам полос (`playbackBandKeys`): пакет даёт по одному
 * источнику на отмеченную полосу (порядок — как в прогоне, а не как в чекбоксах),
 * одиночный расчёт — один источник без полосы. Пустой набор чекбоксов при живом
 * пакете — честное «полос не выбрано»: источников нет, кадр не рисуется.
 */
export function frameSources(
  result: DipoleScanResult | null,
  batch: DipoleBatchResult | null,
  playbackBandKeys: readonly string[],
): BandFrameSource[] {
  const bands = batch?.bands ?? []
  if (batch && bands.length > 0) {
    const selected = new Set(playbackBandKeys)
    return bands
      .filter((band) => selected.has(band.band_key))
      .map((band) => {
        const tag = bandTagOf(band)
        return {
          band: tag,
          points: pointByEpoch(dipoleLayerFromScan(scanResultOfBand(batch, band), tag).points),
        }
      })
  }
  if (!result) return []
  return [{ band: null, points: pointByEpoch(dipoleLayerFromScan(result).points) }]
}

/**
 * Облако пакета для проекций: точки **всех отмеченных полос** одним слоем, с
 * тегами полос (цвет/длина вектора — по `point.band`). Пороги отображения и
 * кратность узла применяются к этому слою снаружи (`thresholdDipoleLayer`,
 * `withOverlapCounts` — кратность внутри полосы). Без пакета/чекбоксов слой
 * пуст: облако не подменяется одиночным расчётом своей активной полосы.
 */
export function batchDipoleLayer(
  batch: DipoleBatchResult | null,
  playbackBandKeys: readonly string[],
): DipoleLayer {
  const sources = frameSources(null, batch, playbackBandKeys)
  return {
    points: sources.flatMap((source) => [...source.points.values()]),
    source: 'result',
  }
}
