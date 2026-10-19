/**
 * Индикатор эпох/диполей (второй ряд тулс-хедера «Диполей»): чистые помощники
 * полосы ячеек «эпоха × готовность/BAD/полосы пакета».
 *
 * Ряд ячеек = сетка нарезки результата **включая отброшенные BAD_**: ровно
 * `n_epochs_total` ячеек, номер эпохи — позиция в drop_log (тот же «ключ связи с
 * диполями», что `epoch_index` точек). Ячейка несёт три слоя смысла:
 *
 * * **готовность** (3.1) — есть ли диполь этой эпохи: готовая ячейка заливается
 *   насыщеннее, неготовая остаётся бледной; во время задачи предзаливка идёт по
 *   `epochs_done`/`epochs_total` (`stripProgressCells`);
 * * **BAD** (3.2) — эпоха отброшена **во всех** отображаемых полосах: warn-цвет
 *   и номер эпохи в подписи/тултипе; если полосы расходятся (у каждой свой
 *   краевой буфер BAD_edge) — просто неготовые полоски без метки BAD;
 * * **полосы** (3.1, пакет) — вертикальные полоски в цветах гаммы (`bandColor`)
 *   по отображаемым полосам: готовая полоска — полный цвет, неготовая — бледная.
 *
 * Выбор эпохи (3.3) и кадр анимации (3.4) — состояния ячейки, но помечает их
 * рамками компонент (`EpochDipoleStrip`); здесь — только данные. Модуль чистый
 * (без DOM и zustand, как `playback.ts`/`dipolePoints.ts`): правила проверяются
 * тестами без рендера.
 */

/** Одна отображаемая полоса пакета с её готовностью/отбраковкой по эпохам. */
export type EpochStripBand = {
  bandKey: string
  /** Подпись полосы для тултипа («α (8–16 Гц)») */
  label: string
  /** Цвет полосы из гаммы red→violet (`bandColor`) */
  color: string
  /** Номера эпох с диполем (сетка нарезки включая BAD) */
  readyEpochs: ReadonlySet<number>
  /** Номера отброшенных эпох этой полосы (сетка drop_log) */
  badEpochs: ReadonlySet<number>
}

/** Полоска заливки ячейки: одна отображаемая полоса и её состояние в эпохе. */
export type EpochStripFill = {
  bandKey: string
  label: string
  color: string
  /** Готова (есть диполь): полный цвет полосы; нет — бледный вариант */
  ready: boolean
  /** Эпоха отброшена в этой полосе (BAD_/reject её нарезки) */
  bad: boolean
}

/** Ячейка индикатора: одна эпоха нарезки (включая BAD). */
export type EpochStripCell = {
  /** Номер эпохи нарезки (0-based, позиция в drop_log) */
  epochIndex: number
  /** Готова: есть диполь хотя бы в одной отображаемой полосе */
  ready: boolean
  /** Чистый BAD: эпоха отброшена во **всех** отображаемых полосах */
  bad: boolean
  /** Полоски заливки (по отображаемым полосам в порядке `bands`) */
  fills: EpochStripFill[]
}

/**
 * Ячейки индикатора по сетке эпох. `totalEpochs` — `n_epochs_total` результата
 * (включая BAD); `bands` — отображаемые полосы (`playbackBandKeys` пакета).
 * Пустой набор полос даёт ячейки без полосок (тултип — только номер эпохи).
 */
export function epochStripCells(
  totalEpochs: number,
  bands: readonly EpochStripBand[],
): EpochStripCell[] {
  const cells: EpochStripCell[] = []
  for (let epochIndex = 0; epochIndex < Math.max(0, Math.floor(totalEpochs)); epochIndex += 1) {
    const fills = bands.map((band) => ({
      bandKey: band.bandKey,
      label: band.label,
      color: band.color,
      ready: band.readyEpochs.has(epochIndex),
      bad: band.badEpochs.has(epochIndex),
    }))
    cells.push({
      epochIndex,
      ready: fills.some((fill) => fill.ready),
      // Пустой набор полос — BAD не выдумываем («нет данных», а не «всё BAD»)
      bad: fills.length > 0 && fills.every((fill) => fill.bad),
      fills,
    })
  }
  return cells
}

/**
 * Подпись ячейки (тултип): «Эпоха N» + метка BAD + готовые полосы. Номер —
 * с 1, как в подписях точек (`dipolePointTitle`) и в таблице локализации.
 */
export function epochStripCellTitle(cell: EpochStripCell): string {
  const parts = [`Эпоха ${cell.epochIndex + 1}`]
  if (cell.bad) parts.push('BAD — отброшена')
  const ready = cell.fills.filter((fill) => fill.ready).map((fill) => fill.label)
  if (ready.length > 0) parts.push(`диполи: ${ready.join(', ')}`)
  else if (!cell.bad && cell.fills.length > 0) parts.push('диполей нет')
  return parts.join(' · ')
}

/**
 * Подписи BAD-серий под индикатором: непрерывные серии отброшенных эпох
 * складываются в одну подпись-диапазон («12» или «12–15»), иначе числа соседних
 * BAD-эпох на ширине ячейки (~5 px) налезают друг на друга. Позиционируется
 * подписью первой ячейки серии; тултип ячейки — источник полной истины.
 */
export function epochStripBadRuns(cells: readonly EpochStripCell[]): Array<{
  /** Номер первой ячейки серии в ряду (0-based) */
  cellIndex: number
  /** Первый номер серии (0-based, позиция в drop_log) */
  from: number
  /** Последний номер серии (включительно) */
  to: number
}> {
  const runs: Array<{ cellIndex: number; from: number; to: number }> = []
  cells.forEach((cell, cellIndex) => {
    if (!cell.bad) return
    const last = runs[runs.length - 1]
    if (last && last.to === cell.epochIndex - 1) {
      last.to = cell.epochIndex
      return
    }
    runs.push({ cellIndex, from: cell.epochIndex, to: cell.epochIndex })
  })
  return runs
}

/** Подпись серии BAD: «12» или «12–15» (номера с 1, как в тултипах ячеек). */
export function epochStripBadRunLabel(run: { from: number; to: number }): string {
  return run.from === run.to
    ? String(run.from + 1)
    : `${run.from + 1}–${run.to + 1}`
}

/**
 * Сколько ячеек предзаливается во время задачи: прогресс `epochs_done` из
 * `epochs_total` пропорционально всей сетке (0 — ничего, totalEpochs — всё).
 */
export function stripProgressCells(
  totalEpochs: number,
  epochsDone: number,
  epochsTotal: number,
): number {
  if (!(totalEpochs > 0) || !(epochsTotal > 0) || !(epochsDone > 0)) return 0
  const filled = Math.round((Math.min(epochsDone, epochsTotal) / epochsTotal) * totalEpochs)
  return Math.min(Math.max(0, filled), Math.floor(totalEpochs))
}
