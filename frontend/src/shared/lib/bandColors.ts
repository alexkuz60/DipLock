/**
 * Полосная гамма пакета диполей: цвет и длина вектора момента по частотам полосы.
 *
 * Пакет поддиапазонов (С1) даёт точки «эпоха × полоса»: на проекциях и в анимации
 * одновременно живут диполи δ…high_gamma, и каждая полоса обязана читаться своим
 * цветом (пункт 1 правки 17.10.2026). Модуль — чистая математика без DOM и
 * zustand (как `playback.ts`/`dipolePoints.ts`), правила проверяются тестами.
 *
 * Две величины:
 *
 * * **Цвет полосы** — гамма от красного (дельта) до фиолетового (высокая гамма)
 *   через якоря каталога (правка 19.10.2026): δ/θ — оранжевый, θ — жёлтый,
 *   γ — синий, но светлее (диполи читаются на тёмном фоне проекций). Оттенок и
 *   светлота интерполируются по лог-частотной оси между якорями
 *   (`BAND_HUE_ANCHORS`, `BAND_LIGHTNESS_ANCHORS`). Границы берутся из `band_hz`
 *   точки/прогона (`DipoleBandRunOut`), поэтому «свои» диапазоны `custom:от-до`
 *   и функциональные ритмы получают детерминированный цвет по своим частотам —
 *   выбор чекбоксов на цвет не влияет.
 *
 * * **Длина вектора момента** обратно зависима от частот полосы: самые длинные
 *   у низкой дельты, самые короткие у высокой гаммы (`BAND_VECTOR_MAX_PX` …
 *   `BAND_VECTOR_MIN_PX`, монотонно по той же позиции). В **анимации** длина
 *   фиксирована полосой (хорошо читается поток), в **облаке** полосный масштаб
 *   умножается на долю амплитуды момента (гибрид, решение 17.10.2026).
 *   Наконечник стрелы — один размер для всех полос (`DIPOLE_ARROW_PX` в
 *   `dipolePoints.ts`), треугольник залит цветом полосы.
 */

/**
 * Якоря гаммы HSL: пары «центр-частота полосы, Гц → значение». Оттенок идёт
 * красный (дельта) → оранжевый (δ/θ) → жёлтый (θ) → зелёный (α) →
 * зелёно-голубой (β) → синий (γ) → фиолетовый (высокая γ); между якорями —
 * линейная интерполяция по логарифму частоты (октавы идут равномерно), вне
 * диапазона значение зажимается крайним. Якоря стоят в центрах полос каталога
 * `freq_bands` (`core/config.py`), поэтому каталожные полосы получают ровно
 * свои цвета (δ/θ — оранжевый, θ — жёлтый, γ — синий), а «свои» диапазоны —
 * детерминированный промежуточный по своему центру.
 */
export const BAND_HUE_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1.25, 0], // delta — красный
  [3, 36], // delta_theta — оранжевый
  [6, 60], // theta — жёлтый
  [12, 110], // alpha — зелёный
  [24, 165], // beta — зелёно-голубой
  [48, 215], // gamma — синий
  [96, 275], // high_gamma — фиолетовый
]

/**
 * Светлота гаммы, %: у низких полос постоянная (`BAND_LIGHTNESS_LO`), к верхним
 * растёт до `BAND_LIGHTNESS_HI` — тёмно-синие/фиолетовые диполи на тёмном фоне
 * проекций читались хуже (правка 19.10.2026: «gamma — синий, но светлее»).
 */
export const BAND_LIGHTNESS_LO = 55
export const BAND_LIGHTNESS_HI = 70

export const BAND_LIGHTNESS_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [1.25, BAND_LIGHTNESS_LO],
  [24, BAND_LIGHTNESS_LO],
  [48, 68],
  [96, BAND_LIGHTNESS_HI],
]

/** Насыщенность гаммы, %: постоянная — полосы различаются оттенком и светлотой. */
export const BAND_COLOR_SATURATION = 85

/**
 * Опорные частоты гаммы, Гц: центры полос delta (0.5–2) и high_gamma (64–128) из
 * `core/config.py`. Позиция полосы нормируется по **логарифму** центр-частоты:
 * октавы идут равномерно (delta→theta столько же «шагов», сколько gamma→high_gamma),
 * и цвет не «сжимается» к низким частотам. Вне диапазона позиция зажимается 0…1.
 */
export const BAND_GAMMA_HZ_LO = 1.25
export const BAND_GAMMA_HZ_HI = 96

/**
 * Длины полосных векторов момента, px: `BAND_VECTOR_MAX_PX` — у низкой дельты
 * (позиция 0), `BAND_VECTOR_MIN_PX` — у высокой гаммы (позиция 1). Границы
 * совпадают с амплитудной шкалой одиночного расчёта (`VECTOR_MAX_PX`/
 * `VECTOR_MIN_PX` в `dipolePoints.ts`), чтобы полосный и одиночный диполи
 * жили в одном масштабе фигуры.
 */
export const BAND_VECTOR_MAX_PX = 30
export const BAND_VECTOR_MIN_PX = 7

/** Зажим 0…1 (NaN и отсутствие значения — середина не выдумывается, а 0). */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Центр-частота полосы, Гц: середина её границ (арифметическая, как в подписях UI). */
export function bandCenterHz(bandHz: readonly number[]): number {
  const lo = Number.isFinite(bandHz[0]) ? bandHz[0] : 0
  const hi = Number.isFinite(bandHz[1]) ? bandHz[1] : lo
  const center = (Math.max(lo, hi) + Math.min(lo, hi)) / 2
  return center > 0 ? center : Number.POSITIVE_INFINITY
}

/**
 * Позиция полосы в гамме, 0…1: 0 — низкая дельта, 1 — высокая гамма.
 * Лог-ось между `BAND_GAMMA_HZ_LO` и `BAND_GAMMA_HZ_HI`; одиночная частота
 * (одна граница) и «свои» диапазоны считаются по своему центру.
 */
export function bandPosition(bandHz: readonly number[]): number {
  const center = bandCenterHz(bandHz)
  if (!Number.isFinite(center)) return 0
  const lo = Math.log10(BAND_GAMMA_HZ_LO)
  const hi = Math.log10(BAND_GAMMA_HZ_HI)
  return clamp01((Math.log10(center) - lo) / (hi - lo))
}

/**
 * Линейная интерполяция значения между якорями по **логарифму** центр-частоты:
 * октавы занимают равные отрезки, вне диапазона якорей значение зажимается
 * крайним. Не-числовая/неположительная частота — первый якорь (как зажатая
 * позиция 0 у `bandPosition`).
 */
function piecewiseByLogHz(
  centerHz: number,
  anchors: ReadonlyArray<readonly [number, number]>,
): number {
  const first = anchors[0]
  const last = anchors[anchors.length - 1]
  if (!Number.isFinite(centerHz) || !(centerHz > 0)) return first[1]
  if (centerHz <= first[0]) return first[1]
  if (centerHz >= last[0]) return last[1]
  for (let index = 1; index < anchors.length; index += 1) {
    const [prevHz, prevValue] = anchors[index - 1]
    const [nextHz, nextValue] = anchors[index]
    if (centerHz <= nextHz) {
      const lo = Math.log10(prevHz)
      const t = (Math.log10(centerHz) - lo) / (Math.log10(nextHz) - lo)
      return prevValue + (nextValue - prevValue) * t
    }
  }
  return last[1]
}

/**
 * Цвет полосы в CSS-синтаксисе `hsl(H, S%, L%)`: оттенок и светлота — по якорям
 * гаммы (`BAND_HUE_ANCHORS`/`BAND_LIGHTNESS_ANCHORS`) от центра частот полосы.
 * Функция чистая и детерминированная: одна и та же полоса всегда одного цвета —
 * цвет это адрес полосы на фигуре, а не украшение.
 */
export function bandColor(bandHz: readonly number[]): string {
  const center = bandCenterHz(bandHz)
  const hue = piecewiseByLogHz(center, BAND_HUE_ANCHORS)
  const lightness = piecewiseByLogHz(center, BAND_LIGHTNESS_ANCHORS)
  return `hsl(${hue.toFixed(1)}, ${BAND_COLOR_SATURATION}%, ${lightness.toFixed(1)}%)`
}

/**
 * Полная (полосная) длина вектора момента, px: линейно от `BAND_VECTOR_MAX_PX`
 * (дельта) к `BAND_VECTOR_MIN_PX` (высокая гамма) по позиции полосы — обратная
 * зависимость от частот. Это масштаб полосы: в анимации луч рисуется этой
 * длиной целиком, в облаке её уменьшает доля амплитуды (`dipoleVectorLength`).
 */
export function bandVectorPx(bandHz: readonly number[]): number {
  return BAND_VECTOR_MAX_PX - (BAND_VECTOR_MAX_PX - BAND_VECTOR_MIN_PX) * bandPosition(bandHz)
}