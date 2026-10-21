/**
 * Человекочитаемые имена полос-«инструментов» (ключи `freq_bands`) — общий
 * источник подписей для рабочей области (источник сигнала), панели «Файлы»
 * и заголовков раздела «Нейромузыка».
 */
export const BAND_LABELS: Record<string, string> = {
  delta: 'δ — дельта',
  delta_theta: 'δ/θ — дельта-тета',
  theta: 'θ — тета',
  alpha: 'α — альфа',
  beta: 'β — бета',
  gamma: 'γ — гамма',
  high_gamma: 'γ-high — высокая гамма',
}

/**
 * Ключи полос по возрастанию частоты (порядок `freq_bands` из
 * `core/config.py`): δ 0.5–2 → … → γ-high 64–128 — им же заполняется комбо
 * выбора сигнала (приёмка 07.10.2026).
 */
export const BAND_ORDER: readonly string[] = [
  'delta',
  'delta_theta',
  'theta',
  'alpha',
  'beta',
  'gamma',
  'high_gamma',
]

/**
 * Частотные границы базовых полос `freq_bands` (`core/config.py`), Гц —
 * дублирование каталога бэкенда для UI: цвета гаммы полос
 * (`shared/lib/bandColors.ts` берут границы точек/прогонов диполей, а
 * радар «Эмо» красит свои секторы по этим ключам без данных бэкенда).
 */
export const BAND_HZ: Record<string, readonly [number, number]> = {
  delta: [0.5, 2],
  delta_theta: [2, 4],
  theta: [4, 8],
  alpha: [8, 16],
  beta: [16, 32],
  gamma: [32, 64],
  high_gamma: [64, 128],
}

/**
 * Сортировка ключей полос по возрастанию частоты (порядок сохраняется и для
 * неизвестных ключей — они уходят в конец, relative order гарантирован
 * стабильностью `Array.prototype.sort`).
 */
export function sortBandsByFrequency(bands: readonly string[]): string[] {
  const rank = (band: string): number => {
    const index = BAND_ORDER.indexOf(band)
    return index === -1 ? BAND_ORDER.length : index
  }
  return [...bands].sort((a, b) => rank(a) - rank(b))
}

export function bandLabel(band: string): string {
  return BAND_LABELS[band] ?? band
}

/** Подпись источника «микс до пост-обработки эффектами» (мастер-файл). */
export const MIX_LABEL = 'Микс (до эффектов)'
