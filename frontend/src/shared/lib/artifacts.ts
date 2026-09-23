/**
 * Контракт типов артефактов: имена, подписи, цвета (срез 2.0, вынесено в 2.6).
 *
 * Типы совпадают с `ArtifactKind` контракта API (`backend/app/schemas/analysis.py`):
 * счётчики по типам приходят открытым словарём (`artifact_types`), этот список —
 * полный каталог видов. Модуль намеренно не зависит от zustand: им пользуются и
 * стор параметров (`shared/state/edfParams.ts` реэкспортирует отсюда), и чистые
 * слои вьюера (`shared/lib/viewerLayers.ts`), и отрисовка треков.
 *
 * Цвета — токены темы (`styles/index.css`), а не hex: DOM-слои читают CSS-переменные,
 * поэтому зоны артефактов, легенда и панель не дублируют значения цветов.
 *
 * Правило «BAD_» (какие виды роняют эпохи) живёт только на сервере
 * (`backend/app/services/artifact_detector.py`, `EPOCH_REJECT_KINDS`): зоны всех
 * видов рисуются одинаково, различается только reject при нарезке эпох.
 */

export type ArtifactKind =
  | 'zscore_outlier' // Амплитудный выброс (robust z-score по окну, медиана/MAD)
  | 'peak_to_peak' // Peak-to-peak в скользящем окне (MNE reject-style)
  | 'flat_line' // «Плоский» канал: нулевой размах (мёртвый электрод)
  | 'clipping' // Клиппинг: плоский на пределе АЦП (насыщение/перегрузка)
  | 'break' // Разрыв записи: пропуски/NaN-участки сигнала
  | 'electrode_pop' // Всплеск электрода: ступенчатый скачок с возвратом (pop)
  | 'muscle_emg' // Мышечный (ЭМГ): всплеск высоких частот 20–100 Гц
  | 'line_noise' // Сетевой шум 50/60 Гц и гармоники (Welch-PSD детектор)
  | 'ocular' // Окулярный (моргание): медленные волны Fp1/Fp2 с высокой амплитудой
  | 'ecg' // ЭКГ-наводка: QRS-подобные пики на височных T7/T8
  | 'ica_eog' // Компонента ICA, съезжающая по корреляции с EOG (M5)

export const ARTIFACT_KINDS: ArtifactKind[] = [
  'zscore_outlier',
  'peak_to_peak',
  'flat_line',
  'clipping',
  'break',
  'electrode_pop',
  'muscle_emg',
  'line_noise',
  'ocular',
  'ecg',
  'ica_eog',
]

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  zscore_outlier: 'z-score выбросы',
  peak_to_peak: 'Превышение peak-to-peak',
  flat_line: 'Плоская линия',
  clipping: 'Клиппинг (насыщение)',
  break: 'Разрыв записи',
  electrode_pop: 'Всплеск электрода',
  muscle_emg: 'Мышечный (ЭМГ)',
  line_noise: 'Сетевой шум 50/60 Гц',
  ocular: 'Окулярный (моргание)',
  ecg: 'ЭКГ-наводка',
  ica_eog: 'ICA: EOG-компоненты',
}

/**
 * Имя CSS-токена типа артефакта.
 *
 * Нужно там, где цвет читают **не из DOM**: canvas не понимает `var(...)`, и
 * `themeColor` ждёт имя токена (`--color-artifact-zscore`). Держим имена здесь,
 * чтобы DOM-слой и холсты не расходились в названиях.
 */
export const ARTIFACT_COLOR_TOKENS: Record<ArtifactKind, string> = {
  zscore_outlier: '--color-artifact-zscore',
  peak_to_peak: '--color-artifact-pp',
  flat_line: '--color-artifact-flat',
  clipping: '--color-artifact-clipping',
  break: '--color-artifact-break',
  electrode_pop: '--color-artifact-pop',
  muscle_emg: '--color-artifact-muscle',
  line_noise: '--color-artifact-line',
  ocular: '--color-artifact-ocular',
  ecg: '--color-artifact-ecg',
  ica_eog: '--color-artifact-ica',
}

/** Цвет зоны артефакта: токен темы, синхронизирован с легендой и панелью */
export const ARTIFACT_COLORS: Record<ArtifactKind, string> = {
  zscore_outlier: `var(${ARTIFACT_COLOR_TOKENS.zscore_outlier})`,
  peak_to_peak: `var(${ARTIFACT_COLOR_TOKENS.peak_to_peak})`,
  flat_line: `var(${ARTIFACT_COLOR_TOKENS.flat_line})`,
  clipping: `var(${ARTIFACT_COLOR_TOKENS.clipping})`,
  break: `var(${ARTIFACT_COLOR_TOKENS.break})`,
  electrode_pop: `var(${ARTIFACT_COLOR_TOKENS.electrode_pop})`,
  muscle_emg: `var(${ARTIFACT_COLOR_TOKENS.muscle_emg})`,
  line_noise: `var(${ARTIFACT_COLOR_TOKENS.line_noise})`,
  ocular: `var(${ARTIFACT_COLOR_TOKENS.ocular})`,
  ecg: `var(${ARTIFACT_COLOR_TOKENS.ecg})`,
  ica_eog: `var(${ARTIFACT_COLOR_TOKENS.ica_eog})`,
}

/** Короткая подпись типа для тултипа/легенды: «z-score», «ICA», «flat-line», «peak-to-peak» */
export const ARTIFACT_SHORT_LABELS: Record<ArtifactKind, string> = {
  zscore_outlier: 'z-score',
  peak_to_peak: 'peak-to-peak',
  flat_line: 'flat-line',
  clipping: 'clip',
  break: 'break',
  electrode_pop: 'pop',
  muscle_emg: 'EMG',
  line_noise: '50/60',
  ocular: 'blink',
  ecg: 'ECG',
  ica_eog: 'ICA',
}

/**
 * Полупрозрачная заливка зоны: тот же токен, ослабленный до ``percent`` %.
 * `color-mix` вместо rgba, чтобы не дублировать hex-значения темы в JS.
 */
export function artifactFill(kind: ArtifactKind, percent = 18): string {
  return `color-mix(in srgb, ${ARTIFACT_COLORS[kind]} ${percent}%, transparent)`
}
