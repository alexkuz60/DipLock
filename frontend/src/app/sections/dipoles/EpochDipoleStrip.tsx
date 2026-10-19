/**
 * Индикатор эпох/диполей — второй ряд тулс-хедера раздела «Диполи» (3.1–3.4).
 *
 * Ряд интерактивных прямоугольников (высота 10 px, зазор 2 px, на всю ширину
 * основной области): по одной ячейке на эпоху нарезки **включая BAD**. Ячейка
 * совмещает роли:
 *
 * * **готовность расчёта** (3.1) — готовая ячейка несёт заливку-микс, пустая
 *   остаётся без заливки; во время пакетной задачи (в том числе перерасчёта)
 *   прежняя раскраска **стирается**, и ряд предзаливается по
 *   `epochs_done`/`epochs_total` — иначе прогресс не виден под старой заливкой;
 * * **полосы пакета** (3.1) — микс цветов готовых полос (`bandColor`) на весь
 *   прямоугольник ячейки: слои с прозрачностями `0.75 / n`, суммарная
 *   непрозрачность ≤ 75% при любом числе полос; вертикальных полосок нет
 *   (слишком тесные и крикливо-яркие);
 * * **BAD-эпохи** (3.2) — warn-цвет и номера серий под рядом («12» или
 *   «12–15»), тултип ячейки называет эпоху целиком;
 * * **текущая эпоха** (3.3/3.4) — одна **белая рамка** на выбор кликом и кадр
 *   анимации: клик по ячейке выбирает пакет диполей своей эпохи и перематывает
 *   кадр на неё же (так индикатор заменяет покадровые кнопки «<»/«>»), а в Плей
 *   выделение **следует за кадром** — рамка едет по эпохам, и проекции показывают
 *   пакет диполей той эпохи, где стоит анимация. На паузе рамка фиксируется;
 *   play/pause и скорость остаются в шапке.
 *
 * Данные — чистые функции `shared/lib/epochStrip.ts`; компонент только рисует
 * и шлёт команды стора (`toggleSelectedEpoch`). Расчёт запускается кнопкой
 * шапки, индикатор — отображение.
 */
import { useMemo } from 'react'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { bandTagOf } from '@/shared/lib/dipoleBatch'
import {
  epochStripBadRunLabel,
  epochStripBadRuns,
  epochStripCells,
  epochStripCellTitle,
  stripProgressCells,
  type EpochStripBand,
  type EpochStripCell,
  type EpochStripMixLayer,
} from '@/shared/lib/epochStrip'
import type { DipoleBatchResult } from '@/shared/api/types'
import { cx } from '@/shared/ui/cx'

/** Высота ячейки, px: 10 — тонкая полоса-шкала, а не график. */
const CELL_H = 'h-2.5'

/**
 * Сборка полос индикатора из набора пакета: только отображаемые полосы
 * (`playbackBandKeys`), готовность — по точкам своей полосы, BAD — по её сетке
 * отброшенных эпох (у полос разные краевые буферы фильтра — своя сетка BAD).
 */
function stripBands(
  batch: DipoleBatchResult | null,
  playbackBandKeys: readonly string[],
): EpochStripBand[] {
  const bands = batch?.bands ?? []
  const selected = new Set(playbackBandKeys)
  return bands
    .filter((band) => selected.has(band.band_key))
    .map((band) => {
      const tag = bandTagOf(band)
      return {
        bandKey: tag.key,
        label: tag.label,
        color: tag.color,
        readyEpochs: new Set((band.points ?? []).map((point) => point.epoch_index)),
        badEpochs: new Set(band.bad_epoch_indexes ?? []),
      }
    })
}

/**
 * Заливка-микс ячейки: слои цветов готовых полос поверх **всего** прямоугольника
 * (вертикальных полосок нет). Непрозрачности посчитаны `epochStripCellMix` —
 * суммарно не более 75% при любом числе слоёв.
 */
function CellMix({ mix }: { mix: readonly EpochStripMixLayer[] }) {
  if (mix.length === 0) return null
  return (
    <span aria-hidden className="absolute inset-0">
      {mix.map((layer) => (
        <span
          key={layer.bandKey}
          className="absolute inset-0"
          style={{ backgroundColor: layer.color, opacity: layer.opacity }}
        />
      ))}
    </span>
  )
}

/**
 * Ячейка эпохи. Клик выбирает эпоху и перематывает кадр (3.3/3.4); текущая эпоха
 * (выбор = кадр в Плей) помечена одной белой рамкой. Пока идёт задача, заливка
 * стёрта и ячейка показывает только предзаливку прогресса.
 */
function EpochCell({
  cell,
  selected,
  fill,
  progress,
  onSelect,
}: {
  cell: EpochStripCell
  selected: boolean
  /** Рисовать заливку/BAD: на время задачи раскраска стёрта (прогресс виден) */
  fill: boolean
  /** Предзаливка идущей задачи (кликабельность сохраняется) */
  progress: boolean
  onSelect: (epochIndex: number) => void
}) {
  return (
    <button
      type="button"
      data-testid="epoch-strip-cell"
      data-epoch={cell.epochIndex}
      title={epochStripCellTitle(cell)}
      aria-label={epochStripCellTitle(cell)}
      aria-pressed={selected}
      onClick={() => onSelect(cell.epochIndex)}
      className={cx(
        'relative min-w-0 flex-1 cursor-pointer bg-bg-3 transition-colors',
        CELL_H,
        selected ? 'outline outline-2 outline-offset-1 outline-fg-0' : '',
      )}
    >
      {!fill ? (
        progress ? (
          <span aria-hidden className="block h-full w-full bg-accent opacity-25" />
        ) : null
      ) : cell.bad ? (
        <span aria-hidden className="block h-full w-full bg-warn opacity-80" />
      ) : (
        <CellMix mix={cell.mix} />
      )}
    </button>
  )
}

export function EpochDipoleStrip() {
  const batch = useDipoleCalc((state) => state.batch)
  const result = useDipoleCalc((state) => state.result)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const batchJob = useDipoleCalc((state) => state.batchJob)
  const selectedEpochIndex = useDipoleCalc((state) => state.selectedEpochIndex)
  const toggleSelectedEpoch = useDipoleCalc((state) => state.toggleSelectedEpoch)

  const bands = useMemo(() => stripBands(batch, playbackBandKeys), [batch, playbackBandKeys])
  // Сетка эпох — из результата (`n_epochs_total` включает BAD); до первого
  // результата сетку подсказывает идущая задача («эпох N из M» в прогрессе)
  const running = batchJob?.status === 'running'
  const totalEpochs = result?.n_epochs_total ?? (running ? (batchJob?.epochsTotal ?? 0) : 0)
  const cells = useMemo(() => epochStripCells(totalEpochs, bands), [totalEpochs, bands])
  const badRuns = useMemo(() => epochStripBadRuns(cells), [cells])
  const progressCells = running
    ? stripProgressCells(totalEpochs, batchJob?.epochsDone ?? 0, batchJob?.epochsTotal ?? 0)
    : 0

  // Ни результата, ни идущей задачи — показывать нечего (а не «пустой ряд»)
  if (totalEpochs <= 0) return null

  return (
    <div className="w-full" data-testid="epoch-strip">
      <div className="flex w-full items-end gap-[2px]">
        {cells.map((cell) => (
          <EpochCell
            key={cell.epochIndex}
            cell={cell}
            selected={selectedEpochIndex === cell.epochIndex}
            fill={!running}
            progress={cell.epochIndex < progressCells}
            onSelect={toggleSelectedEpoch}
          />
        ))}
      </div>
      {/* Подписи BAD-серий — как и раскраска, о прошлом результате: на время
          перерасчёта они стёрты, чтобы ряд читался как прогресс */}
      {!running && badRuns.length > 0 ? (
        /* Номера BAD-серий под рядом («12» или «12–15»): одна подпись на серию,
           иначе числа соседних эпох на ширине ячейки налезают друг на друга */
        <div aria-hidden className="flex w-full gap-[2px]">
          {cells.map((cell, cellIndex) => {
            const run = badRuns.find((item) => item.cellIndex === cellIndex)
            return (
              <span key={cell.epochIndex} className="relative min-w-0 flex-1">
                {run ? (
                  <span className="absolute left-1/2 top-0 -translate-x-1/2 text-[8px] leading-3 whitespace-nowrap text-warn select-none">
                    {epochStripBadRunLabel(run)}
                  </span>
                ) : null}
              </span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}