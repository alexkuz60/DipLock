/**
 * Форма фильтров расчёта диполей и спектра (срез 3.6, `docs/ui.md` §3.3).
 *
 * Полоса — единственная сущность
 * ------------------------------
 * Задачи расчёта принимают ровно три поля фильтра: `band_min`, `band_max` и
 * `notch_hz` (формы `POST …/dipoles` и `POST …/spectrum`). Поэтому состояние
 * хранит **полосу** (`filterBandHz`), а пресеты δ…γ, «одиночная частота» и «свой
 * диапазон» — лишь способы её выбрать: выбранный пресет **выводится** из полосы
 * (`filterPresetOf`), а не лежит рядом с ней. Иначе после смены `freq_bands` на
 * сервере подпись «α 8–13 Гц» показывала бы одно, а в задачу уходили прежние
 * числа — расхождение, которое глазами не поймать.
 *
 * Диапазоны ритмов не дублируются в UI: их приносит `/meta` (`freq_bands`,
 * единственный источник — `core/config.py`), как длины эпох. Пока метаданные не
 * загружены, ритмов в списке нет вовсе (а не «примерно такие»); «широкий 1–40»,
 * «свой диапазон», «одиночная частота» и «без фильтра» работают и без них.
 *
 * Одиночная частота — это узкая полоса `f ± bw/2`: ровно так её считает бэкенд
 * для `single_freq` в предподготовке записи (`services/bandpass_filter.py`),
 * поэтому в задачу уходит честная пара границ, а не поле, которого у формы нет.
 *
 * Правка полей **ничего не запускает** (правило раздела): параметры лишь
 * помечают результат устаревшим, а расчёт идёт по кнопке.
 */
import { BAND_LABELS } from './spectrum'

/** Параметры формы: выбор пользователя и полоса, которая уходит в задачу. */
export type CalcFilterParams = {
  /** Выбор пользователя: пресет диапазона, «одиночная частота», «свой», «без» */
  filterPreset: CalcFilterPresetId
  /** Полоса фильтра, Гц; `null` — без полосового фильтра (то, что уйдёт в задачу) */
  filterBandHz: [number, number] | null
  notchHz: number | null
  /** Одиночная частота, Гц (для пресета «Одиночная частота») */
  singleFreqHz: number
  /** Ширина полосы вокруг одиночной частоты, Гц */
  bandwidthHz: number
}

/** Границы ввода полосы, Гц: выше 100 Гц полосу задавать нечем (это выше любого ЭЭГ-ритма). */
export const BAND_RANGE: [number, number] = [0.1, 100]
export const SINGLE_FREQ_RANGE: [number, number] = [0.5, 70]
export const BANDWIDTH_RANGE: [number, number] = [0.1, 10]

/** «Широкий» пресет: 1–40 Гц — та же полоса, что была у расчёта до среза 3.6. */
export const WIDE_FILTER_BAND: [number, number] = [1, 40]

/** Порядок ритмов в списке — от медленного к быстрому (как в `core/config.py`). */
export const RHYTHM_PRESETS = ['delta', 'theta', 'alpha', 'beta', 'gamma'] as const

export type RhythmPresetId = (typeof RHYTHM_PRESETS)[number]

/** Пресеты списка «Фильтр расчёта». Ритмы узнаются по ключам `freq_bands`. */
export type CalcFilterPresetId = 'band_1_40' | RhythmPresetId | 'single' | 'custom' | 'none'

export type FilterPresetOption = {
  value: CalcFilterPresetId
  label: string
  /** Полоса пресета, Гц (`null` — пресет полосу не задаёт: «свой»/«одиночная»/«без») */
  band: [number, number] | null
}

/** Значения селекта сетевого фильтра: строки, потому что это нативный `<select>`. */
export const NOTCH_OPTIONS: { value: string; label: string }[] = [
  { value: 'none', label: 'Выключен' },
  { value: '50', label: '50 Гц' },
  { value: '60', label: '60 Гц' },
]

/** Возможные частоты сетевого фильтра: только они и предлагаются (как в предподготовке). */
export const NOTCH_HZ_VALUES = [50, 60]

/** Значение селекта для сохранённой частоты сетевого фильтра. */
export function notchOptionValue(notchHz: number | null): string {
  const normalized = normalizeNotchHz(notchHz)
  return normalized === null ? 'none' : String(normalized)
}

/** Частота сетевого фильтра из значения селекта. */
export function notchFromOption(value: string): number | null {
  return normalizeNotchHz(value === 'none' ? null : Number(value))
}

/**
 * Сетевой фильтр — только 50 или 60 Гц: иное значение приводится к ближайшему,
 * чтобы список и состояние не разъезжались («в списке 50, в задаче 55»).
 */
export function normalizeNotchHz(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null
  let best = NOTCH_HZ_VALUES[0]
  for (const candidate of NOTCH_HZ_VALUES) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate
  }
  return best
}

/**
 * Полоса из ввода: границы по возрастанию, округление до десятых и зажим в
 * `BAND_RANGE`. Пустая полоса (`8–8`) — это «без фильтра», а не «фильтр шириной
 * 0 Гц»: у задачи такая полоса вызвала бы ошибку фильтрации.
 */
export function normalizeFilterBand(
  band: readonly number[] | null | undefined,
): [number, number] | null {
  if (!band || band.length < 2) return null
  const [first, second] = band
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null
  const low = round1(clamp(Math.min(first, second), BAND_RANGE))
  const high = round1(clamp(Math.max(first, second), BAND_RANGE))
  return high > low ? [low, high] : null
}

/** Полоса одиночной частоты: `f ± bw/2` (как `single_freq` в предподготовке записи). */
export function singleFreqBand(freqHz: number, bandwidthHz: number): [number, number] | null {
  const freq = clamp(freqHz, SINGLE_FREQ_RANGE)
  const width = clamp(bandwidthHz, BANDWIDTH_RANGE)
  return normalizeFilterBand([freq - width / 2, freq + width / 2])
}

/**
 * Полоса пресета: ритмы — из `/meta`, «широкий» — 1–40 Гц, «без фильтра» — нет
 * фильтра. У «своего диапазона» и «одиночной частоты» полосы в пресете нет
 * (`null`): её задаёт пользователь, а не таблица пресетов.
 */
export function presetBand(
  preset: CalcFilterPresetId,
  freqBands: Record<string, number[]>,
): [number, number] | null {
  if (preset === 'none') return null
  if (preset === 'band_1_40') return WIDE_FILTER_BAND
  if (preset === 'single' || preset === 'custom') return null
  return normalizeFilterBand(freqBands[preset] ?? null)
}

/**
 * Полоса для выбранного в списке пресета: у ритмов и «широкого» — из пресета,
 * у «одиночной частоты» — по запомненным частоте и ширине, у «своего» — текущая
 * полоса (поля показывают то же число) с откатом к 1–40, если фильтра не было.
 */
export function bandForPreset(
  params: CalcFilterParams,
  preset: CalcFilterPresetId,
  freqBands: Record<string, number[]>,
): [number, number] | null {
  if (preset === 'single') return singleFreqBand(params.singleFreqHz, params.bandwidthHz)
  if (preset === 'custom') return params.filterBandHz ?? WIDE_FILTER_BAND
  return presetBand(preset, freqBands)
}

/** Список пресетов панели: ритмы — из `freq_bands`, порядок — δ, θ, α, β, γ. */
export function filterPresetOptions(freqBands: Record<string, number[]>): FilterPresetOption[] {
  const options: FilterPresetOption[] = [
    { value: 'band_1_40', label: `1–${WIDE_FILTER_BAND[1]} Гц (широкий)`, band: WIDE_FILTER_BAND },
  ]
  for (const rhythm of RHYTHM_PRESETS) {
    const band = normalizeFilterBand(freqBands[rhythm] ?? null)
    // Ритма нет в конфиге сервера — не выдумываем диапазон «на глаз»
    if (band === null) continue
    options.push({ value: rhythm, label: `${BAND_LABELS[rhythm]} ${filterBandText(band)}`, band })
  }
  options.push({ value: 'single', label: 'Одиночная частота', band: null })
  options.push({ value: 'custom', label: 'Свой диапазон', band: null })
  options.push({ value: 'none', label: 'Без фильтра', band: null })
  return options
}

/** Подпись пресета (для итоговой строки формы и подсказок контролов). */
export function filterPresetLabel(
  preset: CalcFilterPresetId,
  freqBands: Record<string, number[]>,
): string {
  return filterPresetOptions(freqBands).find((option) => option.value === preset)?.label ?? preset
}

/**
 * Какой пресет соответствует полосе. Нужен там, где **выбор пользователя
 * неизвестен или неприменим**: при восстановлении сохранённых параметров (полоса
 * есть, а пресета из новой версии UI нет) и как страховка панели, если
 * сохранённый пресет-ритм пропал из `freq_bands` сервера — иначе `<select>`
 * остался бы со значением, которого нет в списке.
 *
 * Порядок проверок: сначала полосы пресетов (они конкретнее), затем полоса
 * одиночной частоты — совпасть с ней может и «свой диапазон» с теми же числами,
 * и тогда честнее показать частоту с шириной.
 */
export function filterPresetOf(
  params: Omit<CalcFilterParams, 'filterPreset'>,
  freqBands: Record<string, number[]>,
): CalcFilterPresetId {
  const band = params.filterBandHz
  if (band === null) return 'none'
  for (const option of filterPresetOptions(freqBands)) {
    if (option.band && sameBand(band, option.band)) return option.value
  }
  const single = singleFreqBand(params.singleFreqHz, params.bandwidthHz)
  if (single && sameBand(band, single)) return 'single'
  return 'custom'
}

/** Полоса в подписи: «1–40 Гц» или «без фильтра». */
export function filterBandText(band: readonly number[] | null): string {
  return band && band.length === 2 ? `${band[0]}–${band[1]} Гц` : 'без фильтра'
}

/** Название пресета **без чисел**: числа печатает итоговая подпись по полосе. */
function presetName(preset: CalcFilterPresetId, freqBands: Record<string, number[]>): string {
  if (preset === 'band_1_40') return `${WIDE_FILTER_BAND[0]}–${WIDE_FILTER_BAND[1]} Гц (широкий)`
  if (preset === 'custom') return 'свой диапазон'
  if (preset === 'single') return 'одиночная частота'
  if (preset === 'none') return 'без полосового фильтра'
  return BAND_LABELS[preset] ?? String(filterPresetLabel(preset, freqBands))
}

/**
 * Итог формы: что именно уйдёт в задачу, словами (без «примерно так»).
 *
 * Числа берутся из **полосы**: если `freq_bands` сервера изменились после
 * сохранения выбора, подпись покажет фактические границы расчёта, а не название
 * ритма со старыми «обещанными» числами.
 */
export function filterSummary(
  params: CalcFilterParams,
  freqBands: Record<string, number[]> = {},
): string {
  const notch = params.notchHz ? `сетевой фильтр ${params.notchHz} Гц` : 'без сетевого фильтра'
  if (params.filterBandHz === null) return `без полосового фильтра · ${notch}`
  if (params.filterPreset === 'single') {
    return `одиночная частота ${params.singleFreqHz} Гц (полоса ${filterBandText(
      params.filterBandHz,
    )}, ширина ${params.bandwidthHz} Гц) · ${notch}`
  }
  return `${presetName(params.filterPreset, freqBands)} ${filterBandText(
    params.filterBandHz,
  )} · ${notch}`
}

/** Проверка идентификатора пресета: значение из localStorage может быть из будущего. */
export function filterPresetIsValid(preset: string): preset is CalcFilterPresetId {
  return (
    preset === 'band_1_40' ||
    preset === 'single' ||
    preset === 'custom' ||
    preset === 'none' ||
    (RHYTHM_PRESETS as readonly string[]).includes(preset)
  )
}

function sameBand(a: readonly number[], b: readonly number[]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
}

/** Округление до десятых: полосы измеряются в Гц с одним знаком после запятой. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function clamp(value: number, [min, max]: [number, number]): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
