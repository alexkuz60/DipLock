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
 * * **Цвет полосы** — гамма от красного (дельта) до ярко-фиолетового (высокая
 *   гамма): оттенок HSL растёт с позицией полосы на лог-частотной оси. Границы
 *   берутся из `band_hz` точки/прогона (`DipoleBandRunOut`), поэтому «свои»
 *   диапазоны `custom:от-до` и функциональные ритмы получают детерминированный
 *   цвет по своим частотам — выбор чекбоксов на цвет не влияет.
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
 * Оттенки гаммы HSL: 0° — красный (дельта), `BAND_HUE_HI` — ярко-фиолетовый
 * (высокая гамма). Яркость/насыщенность постоянные — полосы различаются
 * оттенком, а не светлотой (светлота на МРТ-подложке читается хуже).
 */
export const BAND_HUE_LO = 0
export const BAND_HUE_HI = 280
export const BAND_COLOR_SATURATION = 85
export const BAND_COLOR_LIGHTNESS = 55

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
 * Цвет полосы в CSS-синтаксисе `hsl(H, S%, L%)`: красный → ярко-фиолетовый по
 * позиции (`bandPosition`). Функция чистая и детерминированная: одна и та же
 * полоса всегда одного цвета — цвет это адрес полосы на фигуре, а не украшение.
 */
export function bandColor(bandHz: readonly number[]): string {
  const hue = BAND_HUE_LO + (BAND_HUE_HI - BAND_HUE_LO) * bandPosition(bandHz)
  return `hsl(${hue.toFixed(1)}, ${BAND_COLOR_SATURATION}%, ${BAND_COLOR_LIGHTNESS}%)`
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