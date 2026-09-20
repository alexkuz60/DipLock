/**
 * Домен раздела «Диполи» (срезы 3.4–3.7), чистый модуль без zustand и React:
 * параметры расчёта и их дефолты, рамки контролов, состояние фоновой задачи,
 * формы запросов (`FormData`), отпечатки параметров и результата, нормализация
 * сохранённых параметров.
 *
 * Здесь же — типы состояния **просмотра** (`CalcView`, `PlaybackState`) и их
 * дефолты: их читают панель, шапка и часы воспроизведения, а zustand-стор лишь
 * хранит значения (`shared/state/dipoleCalc.ts`). Разрезка сделана переносом
 * без изменения поведения: правила расчёта (что уходит в задачу и что считается
 * «свежим результатом») проверяются без хранилища.
 *
 * Границы: параметры, формы и отпечатки — здесь; действия, поллинг задач,
 * персист и сам стор — `shared/state/dipoleCalc.ts`; топокарты, гистограмма и
 * подсветка диполя — `shared/lib/spectrum.ts`, `shared/lib/dipolePoints.ts`.
 */
import {
  BANDWIDTH_RANGE,
  SINGLE_FREQ_RANGE,
  clamp,
  filterPresetIsValid,
  filterPresetOf,
  normalizeFilterBand,
  normalizeNotchHz,
  type CalcFilterPresetId,
} from '@/shared/lib/calcFilter'
import { DEFAULT_PLAYBACK_SPEED, type PlaybackSpeed } from '@/shared/lib/playback'
import type {
  DipoleRefineResult,
  DipoleScanResult,
  JobStatus,
  MetaResponse,
} from '@/shared/api/types'

/** Что открыто в выдвижной панели раздела: одна панель за раз. */
export type CalcView = 'none' | 'topomap' | 'fft'

/**
 * Кадр воспроизведения траектории (срез 3.7). Хранится в сторе, потому что
 * команда идёт из шапки (play/pause, покадрово, `Space`), а исполняется в рабочей
 * области: прямой «ручки» у проекций нет — как и у вьюера EDF.
 */
export type PlaybackState = {
  /** Идёт воспроизведение; на паузе кадр равен измеренной точке своей эпохи */
  playing: boolean
  /** Скорость: 1 — реальное время записи, 2 и 4 — ускорение */
  speed: PlaybackSpeed
  /** Текущая эпоха нарезки результата (0…`n_epochs_total`−1) */
  epochIndex: number
  /**
   * Счётчик **пользовательских** переходов к эпохе (кнопки, `Space`, клик по
   * строке): часы раздела берут кадр только при его смене, поэтому повторный
   * клик по той же эпохе всё равно её перезапускает (`navRequest.seq` в EDF).
   */
  seekSeq: number
  /** Показан ли кадр: пауза его оставляет, «снять кадр» — убирает */
  active: boolean
}

export const PLAYBACK_DEFAULTS: PlaybackState = {
  playing: false,
  speed: DEFAULT_PLAYBACK_SPEED,
  epochIndex: 0,
  seekSeq: 0,
  active: false,
}

/**
 * Параметры расчёта: то, что уходит в задачу быстрого расчёта диполей и в задачу
 * спектра. Хранятся только **данные** — подписи контролов выводятся из них
 * (`shared/lib/calcFilter.ts`), поэтому форма и запрос не могут разойтись.
 */
export type CalcParams = {
  /**
   * Выбор пользователя в списке «Фильтр расчёта»: пресет диапазона (δ…γ из
   * `/meta`), «одиночная частота», «свой диапазон» или «без фильтра».
   */
  filterPreset: CalcFilterPresetId
  /**
   * Полоса фильтра, Гц; `null` — без фильтра. **То, что уходит в задачу**
   * (`band_min`/`band_max`) и входит в отпечаток результата; пересчитывается
   * каждым сеттером формы (`shared/lib/calcFilter.ts`).
   */
  filterBandHz: [number, number] | null
  notchHz: number | null
  /** Одиночная частота, Гц: полосу считает `singleFreqBand` (f ± bw/2) */
  singleFreqHz: number
  /** Ширина полосы вокруг одиночной частоты, Гц */
  bandwidthHz: number
  epochLengthMs: number
  rejectThresholdUv: number
  /** Шаг объёмной сетки поиска диполей, мм */
  gridMm: number
}

export const CALC_PARAM_DEFAULTS: CalcParams = {
  filterPreset: 'band_1_40',
  filterBandHz: [1, 40],
  notchHz: null,
  // Значения одиночной частоты — заготовка формы: 7.83 Гц (частота Шумана) с
  // полосой ±0.25 Гц. Ширина по умолчанию та же, что у предподготовки записи
  // (`settings.default_single_freq_bandwidth_hz`), иначе формы расходились бы.
  singleFreqHz: 7.83,
  bandwidthHz: 0.5,
  epochLengthMs: 1000,
  rejectThresholdUv: 150,
  gridMm: 7,
}

/** Ограничения контролов панели (совпадают со схемой формы на сервере). */
export const GRID_MM_RANGE: [number, number] = [2, 20]
export const THRESHOLD_NAM_RANGE: [number, number] = [0, 1000]

/** Состояние одной фоновой задачи раздела: прогресс по этапам и эпохам. */
export type CalcJob = {
  status: 'running' | 'succeeded' | 'failed'
  progress: number
  message: string
  stage: string
  epochsDone: number
  epochsTotal: number
  error: string | null
}

/** Задача из ответа сервера в состояние панели (одно место на обе задачи). */
export function calcJobFromStatus(job: JobStatus): CalcJob {
  return {
    status:
      job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : 'running',
    progress: job.progress,
    message: job.message,
    stage: job.stage,
    epochsDone: job.epochs_done,
    epochsTotal: job.epochs_total,
    error: job.status === 'failed' ? (job.error ?? 'Задача завершилась ошибкой') : null,
  }
}

/** Подпись хода задачи: этап, прогресс и «N из M эпох», когда они есть. */
export function calcJobSummary(job: CalcJob | null): string {
  if (job === null) return 'Расчёт не запускался'
  if (job.status === 'failed') return `Ошибка: ${job.error ?? 'задача завершилась ошибкой'}`
  const parts = [job.message || job.stage]
  if (job.epochsTotal > 0) parts.push(`эпох ${job.epochsDone} из ${job.epochsTotal}`)
  parts.push(`${Math.round(job.progress * 100)} %`)
  return parts.join(' · ')
}

/** Форма запроса быстрого расчёта диполей: параметры идут как есть, без догадок. */
export function buildDipoleForm(params: CalcParams): FormData {
  const form = new FormData()
  if (params.filterBandHz) {
    form.set('band_min', String(params.filterBandHz[0]))
    form.set('band_max', String(params.filterBandHz[1]))
  }
  if (params.notchHz) form.set('notch_hz', String(params.notchHz))
  form.set('epoch_length_ms', String(params.epochLengthMs))
  form.set('reject_threshold_uv', String(params.rejectThresholdUv))
  form.set('grid_mm', String(params.gridMm))
  return form
}

/**
 * Форма точного уточнения эпохи (F19): поля берутся из **результата** быстрого
 * расчёта, а не из текущей формы панели — номер эпохи привязан к нарезке
 * результата, и правка параметров после расчёта не должна её подменять.
 */
export function buildRefineForm(
  result: DipoleScanResult,
  epochIndex: number,
  halfwinMs = 0,
): FormData {
  const form = new FormData()
  form.set('epoch_index', String(epochIndex))
  if (result.filter_band_hz) {
    form.set('band_min', String(result.filter_band_hz[0]))
    form.set('band_max', String(result.filter_band_hz[1]))
  }
  if (result.notch_hz) form.set('notch_hz', String(result.notch_hz))
  form.set('reference', result.reference)
  if (result.reference_channels?.length) {
    form.set('reference_channels', result.reference_channels.join(','))
  }
  form.set('epoch_length_ms', String(result.epoch_length_ms))
  form.set('reject_threshold_uv', String(result.reject_threshold_uv))
  form.set('grid_mm', String(result.grid_mm))
  // Окно свободного фитинга (шаг 1.5): 0 — только пик GFP. Каждый отсчёт стоит
  // ≈7 с на сервере, поэтому окно — явный выбор пользователя, а не «пошире».
  form.set('halfwin_ms', String(halfwinMs))
  return form
}

/**
 * Варианты окна свободного фитинга уточнения, мс (шаг 1.5).
 *
 * `0` — только пик GFP: тот самый отсчёт, по которому уже посчитан быстрый
 * результат. Каждый следующий отсчёт окна стоит ≈7 с на BEM-модели (замер
 * 20.09.2026, `docs/rules/dipoles.md`), поэтому «пошире» выбирается осознанно.
 */
export const REFINE_HALFWIN_OPTIONS = [0, 2, 5, 10] as const

export type RefineHalfwinMs = (typeof REFINE_HALFWIN_OPTIONS)[number]

/** Подпись варианта окна: «только пик GFP (±0 мс)» / «±5 мс». */
export function refineHalfwinLabel(halfwinMs: number): string {
  return halfwinMs === 0 ? 'только пик GFP (±0 мс)' : `±${halfwinMs} мс`
}

/**
 * Округление «половина к чётному» (как Python `round`): сервер считает границы
 * окна через `round(halfwin_ms/1000 · sfreq)`, и клиентская оценка времени обязана
 * давать **то же** число отсчётов, иначе подсказка «≈N с» разойдётся с расчётом
 * (JS `Math.round(2.5)` даёт 3, а Python `round(2.5)` — 2).
 */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value)
  const rest = value - floor
  if (rest > 0.5) return floor + 1
  if (rest < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** Число отсчётов окна при данной частоте дискретизации: 2·halfwin·sfreq/1000 + 1. */
export function refineWindowSamples(halfwinMs: number, sfreq: number): number {
  if (!(halfwinMs > 0) || !(sfreq > 0)) return 1
  return 2 * roundHalfToEven((halfwinMs / 1000) * sfreq) + 1
}

/** Значение окна из сохранённых параметров: только варианты списка (иначе — пик). */
export function normalizeRefineHalfwin(halfwinMs: number | null | undefined): number {
  const stored = Number(halfwinMs)
  return REFINE_HALFWIN_OPTIONS.includes(stored as RefineHalfwinMs) ? stored : 0
}

/**
 * Оценка времени уточнения до запуска («сколько ждать», шаг 1.5): постоянная цена
 * (оценка узла на BEM) + отсчёты свободного фита. Числа берутся из `/meta` —
 * это замер сервера, а не предположение клиента, и подсказка не обещает
 * «мгновенно» там, где счёт идёт десятками секунд.
 */
export function refineCostHint(
  meta: Pick<
    MetaResponse,
    'dipole_refine_sec_fixed' | 'dipole_refine_sec_per_sample'
  > | null | undefined,
  sfreq: number | null,
  halfwinMs: number,
): string {
  if (!meta) return 'Оценка времени появится вместе с метаданными сервера (/meta)'
  const fixed = meta.dipole_refine_sec_fixed.toFixed(1)
  const perSample = meta.dipole_refine_sec_per_sample.toFixed(1)
  // Частота записи приходит с результатом расчёта: до него число отсчётов окна
  // неизвестно, и подставлять «примерно 500 Гц» было бы выдумкой клиента
  if (sfreq === null || !(sfreq > 0)) {
    return (
      `Оценка времени: ≈${fixed} с на оценку узла на BEM + ≈${perSample} с за отсчёт окна ` +
      '(частота записи станет известна после расчёта диполей)'
    )
  }
  const samples = refineWindowSamples(halfwinMs, sfreq)
  const freeSec = samples * meta.dipole_refine_sec_per_sample
  const totalSec = meta.dipole_refine_sec_fixed + freeSec
  return (
    `Ожидаемое время ≈${Math.round(totalSec)} с: оценка узла на BEM ≈${fixed} с + ` +
    `свободный фит ${samples} отсч. ≈${Math.round(freeSec)} с`
  )
}

/**
 * Однострочное «стало» уточнения (F19): BEM GOF, GOF узла сетки на той же
 * модели и сдвиг позиции — видно, что дал точный профиль, без подмены метода.
 *
 * Если свободный фит не выполнился, «стало» — это оценка узла сетки на BEM, и
 * строка **обязана** называть её узлом, а не «уточнённой точкой» (шаг 1.5).
 */
export function refinedSummary(refined: DipoleRefineResult): string {
  if (!refined.free_fit) {
    return `Оценка узла сетки на BEM: GOF ${(refined.point.gof * 100).toFixed(1)} % · свободный фит не выполнен`
  }
  const parts = [`BEM GOF ${(refined.point.gof * 100).toFixed(1)} %`]
  if (refined.grid_gof_bem !== null) {
    parts.push(`сетка на BEM ${(refined.grid_gof_bem * 100).toFixed(1)} %`)
  }
  parts.push(`Δ ${refined.shift_mm.toFixed(1)} мм`)
  return parts.join(' · ')
}

/**
 * Тултип уточнённой точки: полное «было/стало» — окно фитинга, MNI, сдвиг
 * от узла сетки и GOF обеих моделей. Одна строка — в title ячейки таблицы.
 */
export function refineTooltip(refined: DipoleRefineResult): string {
  const coords = refined.point.mni_coords
    ? `MNI ${refined.point.mni_coords.map((value) => value.toFixed(1)).join(' / ')}`
    : 'MNI нет'
  const gridBem =
    refined.grid_gof_bem !== null
      ? `, тот же узел на BEM: ${(refined.grid_gof_bem * 100).toFixed(1)} %`
      : ''
  const head = refined.free_fit
    ? 'Уточнено точным профилем'
    : 'Свободный фит не выполнен — показана оценка узла сетки на BEM'
  return (
    `${head} (окно ${refined.window_ms.map((v) => v.toFixed(0)).join('…')} мс, ` +
    `±${refined.halfwin_ms.toFixed(0)} мс): GOF ${(refined.point.gof * 100).toFixed(1)} %, ${coords}, ` +
    `сдвиг от узла сетки ${refined.shift_mm.toFixed(1)} мм. ` +
    `Было — сетка: GOF ${(refined.fast_gof * 100).toFixed(1)} %${gridBem}.`
  )
}

/**
 * Номер эпохи из id точки слоя/строки таблицы (`"{epoch_index}-{time_ms}"`,
 * один формат в `dipolePoints.ts` и `tableRows.ts`). Нужен кнопке «Уточнить»
 * тулс-хедера: выбранная на проекции точка → эпоха для `dipole_refine`.
 */
export function epochIndexOfPointId(pointId: string | null): number | null {
  if (!pointId) return null
  const sep = pointId.indexOf('-')
  const value = Number(sep === -1 ? pointId : pointId.slice(0, sep))
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** Форма запроса спектра: полоса та же, что у расчёта диполей (один источник). */
export function buildSpectrumForm(params: CalcParams): FormData {
  const form = new FormData()
  if (params.filterBandHz) {
    form.set('band_min', String(params.filterBandHz[0]))
    form.set('band_max', String(params.filterBandHz[1]))
  }
  if (params.notchHz) form.set('notch_hz', String(params.notchHz))
  form.set('epoch_length_ms', String(params.epochLengthMs))
  form.set('reject_threshold_uv', String(params.rejectThresholdUv))
  return form
}

/**
 * Отпечаток параметров расчёта: одна и та же строка для параметров и для
 * результата, поэтому их расхождение = «результат посчитан на других настройках».
 *
 * Нужно таблице локализации (срез 4): она показывает результат **как есть** (в
 * том числе после правки настроек панели) и обязана сказать, что с текущими
 * параметрами он уже не совпадает, — иначе числа таблицы читались бы как
 * «посчитано на этих настройках».
 */
function signatureOf(parts: {
  band: [number, number] | null
  notchHz: number | null
  epochLengthMs: number
  rejectThresholdUv: number
  gridMm: number
}): string {
  const band = parts.band ? `${parts.band[0]}-${parts.band[1]}` : 'none'
  return [
    band,
    parts.notchHz ?? 'none',
    parts.epochLengthMs,
    parts.rejectThresholdUv,
    parts.gridMm,
  ].join('|')
}

/** Отпечаток параметров из панели расчёта. */
export function calcSignature(params: CalcParams): string {
  return signatureOf({
    band: params.filterBandHz,
    notchHz: params.notchHz,
    epochLengthMs: params.epochLengthMs,
    rejectThresholdUv: params.rejectThresholdUv,
    gridMm: params.gridMm,
  })
}

/** Отпечаток параметров, с которыми реально посчитан результат задачи (эхо сервера). */
export function resultSignature(result: DipoleScanResult): string {
  const band = result.filter_band_hz
  return signatureOf({
    band: band && band.length === 2 ? [band[0], band[1]] : null,
    notchHz: result.notch_hz,
    epochLengthMs: result.epoch_length_ms,
    rejectThresholdUv: result.reject_threshold_uv,
    gridMm: result.grid_mm,
  })
}

/** Результат соответствует текущим параметрам расчёта? `false` — он устарел. */
export function resultMatchesParams(result: DipoleScanResult, params: CalcParams): boolean {
  return resultSignature(result) === calcSignature(params)
}

/**
 * Параметры расчёта в целостном виде: сохранённые в localStorage значения могут
 * быть из другой версии UI (без полей формы фильтра) или содержать мусор — и то
 * и другое приводится к правилам контролов, а не уходит в задачу как есть.
 */
export function normalizeCalcParams(params: CalcParams): CalcParams {
  const filterBandHz = normalizeFilterBand(params.filterBandHz)
  const storedPreset = filterPresetIsValid(params.filterPreset) ? params.filterPreset : 'custom'
  // Пара «пресет + полоса» должна быть непротиворечивой: пустая полоса — только у
  // «без фильтра», а непустая не может стоять у него же. Пресет при этом берём из
  // полосы (`filterPresetOf` без метаданных: 1–40 → «широкий», полоса одиночной
  // частоты → «одиночная», иначе «свой диапазон» — его поля покажут эти числа).
  const filterPreset =
    filterBandHz === null
      ? 'none'
      : storedPreset === 'none'
        ? filterPresetOf({ ...params, filterBandHz }, {})
        : storedPreset

  return {
    ...params,
    filterPreset,
    filterBandHz,
    notchHz: normalizeNotchHz(params.notchHz),
    singleFreqHz: clamp(params.singleFreqHz, SINGLE_FREQ_RANGE),
    bandwidthHz: clamp(params.bandwidthHz, BANDWIDTH_RANGE),
    epochLengthMs: Math.round(params.epochLengthMs),
    gridMm: clamp(params.gridMm, GRID_MM_RANGE),
    rejectThresholdUv: Math.max(0, params.rejectThresholdUv),
  }
}
