/**
 * Контракт типов артефактов: имена, подписи, цвета (срез 2.0, вынесено в 2.6).
 *
 * Типы совпадают с `ArtifactTypes` контракта API (`backend/app/schemas/analysis.py`).
 * Модуль намеренно не зависит от zustand: им пользуются и стор параметров
 * (`shared/state/edfParams.ts` реэкспортирует отсюда), и чистые слои вьюера
 * (`shared/lib/viewerLayers.ts`), и отрисовка треков.
 *
 * Цвета — токены темы (`styles/index.css`), а не hex: DOM-слои читают CSS-переменные,
 * поэтому зоны артефактов, легенда и панель не дублируют значения цветов.
 */

export type ArtifactKind = 'zscore_outlier' | 'peak_to_peak' | 'flat_line' | 'ica_eog'

export const ARTIFACT_KINDS: ArtifactKind[] = [
  'zscore_outlier',
  'peak_to_peak',
  'flat_line',
  'ica_eog',
]

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  zscore_outlier: 'z-score выбросы',
  peak_to_peak: 'Превышение peak-to-peak',
  flat_line: 'Плоская линия',
  ica_eog: 'ICA: EOG-компоненты',
}

/** Цвет зоны артефакта: токен темы, синхронизирован с легендой и панелью */
export const ARTIFACT_COLORS: Record<ArtifactKind, string> = {
  zscore_outlier: 'var(--color-artifact-zscore)',
  peak_to_peak: 'var(--color-artifact-pp)',
  flat_line: 'var(--color-artifact-flat)',
  ica_eog: 'var(--color-artifact-ica)',
}

/** Короткая подпись типа для тултипа/легенды: «z-score», «ICA», «flat-line», «peak-to-peak» */
export const ARTIFACT_SHORT_LABELS: Record<ArtifactKind, string> = {
  zscore_outlier: 'z-score',
  peak_to_peak: 'peak-to-peak',
  flat_line: 'flat-line',
  ica_eog: 'ICA',
}

/**
 * Полупрозрачная заливка зоны: тот же токен, ослабленный до ``percent`` %.
 * `color-mix` вместо rgba, чтобы не дублировать hex-значения темы в JS.
 */
export function artifactFill(kind: ArtifactKind, percent = 18): string {
  return `color-mix(in srgb, ${ARTIFACT_COLORS[kind]} ${percent}%, transparent)`
}
