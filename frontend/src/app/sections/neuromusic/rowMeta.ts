/**
 * Метаданные рядов «Монтажа» для UI «Нейромузыки»: русские названия (как
 * `RowDef.label` на сервере), цвета модулей и полный список id.
 *
 * Отдельный модуль, а не экспорт из `BrainRoomView`: константами делятся
 * рабочая область (силуэт «Визуализации») и панель опций (правило
 * react-refresh).
 */

/** Русские названия рядов (в порядке `rows.ROW_DEFS`). */
export const ROW_LABELS: Record<string, string> = {
  frontal: 'Лобной',
  temporal: 'Височной',
  parietal: 'Теменной',
  occipital: 'Затылочный',
}

/** Цвет модуля-ряда (CSS-переменные `--color-nm-row-*` из index.css). */
export const ROW_COLORS: Record<string, string> = {
  frontal: 'var(--color-nm-row-frontal)',
  temporal: 'var(--color-nm-row-temporal)',
  parietal: 'var(--color-nm-row-parietal)',
  occipital: 'var(--color-nm-row-occipital)',
}

/**
 * Все 4 ряда «Монтажа» в порядке сервера — для силуэта до рендера, когда
 * `status.rows` ещё нет; после рендера UI берёт список из статуса (в
 * неполном EDF остаются только непустые ряды).
 */
export const MONTAGE_ROW_IDS = ['frontal', 'temporal', 'parietal', 'occipital'] as const
