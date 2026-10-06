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

export function bandLabel(band: string): string {
  return BAND_LABELS[band] ?? band
}

/** Подпись источника «микс до пост-обработки эффектами» (мастер-файл). */
export const MIX_LABEL = 'Микс (до эффектов)'
