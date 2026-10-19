/**
 * Индикатор эпох/диполей — второй ряд тулс-хедера раздела «Диполи» (3.1–3.4).
 *
 * Ряд интерактивных прямоугольников (высота 10 px, зазор 2 px, на всю ширину
 * основной области): по одной ячейке на эпоху нарезки **включая BAD**. Ячейка
 * совмещает четыре роли:
 *
 * * **готовность расчёта** (3.1) — готовая заливается насыщеннее; во время
 *   пакетной задачи ряд предзаливается по `epochs_done`/`epochs_total`;
 * * **полосы пакета** (3.1) — вертикальные полоски в цветах гаммы полос
 *   (`bandColor`), готовая полоска — полный цвет, неготовая — бледная;
 * * **BAD-эпохи** (3.2) — warn-цвет и номера серий под рядом («12» или
 *   «12–15»), тултип ячейки называет эпоху целиком;
 * * **выбор эпохи** (3.3) — клик по ячейке выбирает пакет диполей этой эпохи
 *   (рамка `outline` цвета акцента) и перематывает кадр анимации на неё же —
 *   так индикатор заменяет покадровые кнопки «<»/«>» (3.4): кадр анимации
 *   помечен белым кольцом, play/pause/stop и скорость остаются в шапке.
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
  type EpochStripFill,
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

/** Полоски заливки ячейки: готовая — полный цвет, неготовая — бледная (α 0.22). */
function CellFills({ fills }: { fills: readonly EpochStripFill[] }) {
  if (fills.length === 0) return null
  return (
    <span aria-hidden className="flex h-full w-full">
      {fills.map((fill) => (
        <span
          key={fill.bandKey}
          className="h-full flex-1"
          style={{
            backgroundColor: fill.color,
            opacity: fill.ready ? 1 : 0.22,
          }}
        />
      ))}
    </span>
  )
}

/**
 * Ячейка эпохи. Клик выбирает эпоху (3.3) и перематывает кадр (3.4); выбор
 * помечен рамкой акцента, кадр — белым кольцом (могут совпасть — это разные
 * рамки).
 */
function EpochCell({
  cell,
  selected,
  frame,
  progress,
  onSelect,
}: {
  cell: EpochStripCell
  selected: boolean
  frame: boolean
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
        selected ? 'outline outline-2 outline-offset-1 outline-accent' : '',
        frame ? 'ring-2 ring-inset ring-fg-0' : '',
      )}
    >
      {cell.bad ? (
        <span aria-hidden className="block h-full w-full bg-warn opacity-80" />
      ) : (
        <>
          <CellFills fills={cell.fills} />
          {!cell.ready && progress ? (
            <span aria-hidden className="block h-full w-full bg-accent opacity-25" />
          ) : null}
        </>
      )}
    </button>
  )
}

export function EpochDipoleStrip() {
  const batch = useDipoleCalc((state) => state.batch)
  const result = useDipoleCalc((state) => state.result)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const batchJob = useDipoleCalc((state) => state.batchJob)
  const playback = useDipoleCalc((state) => state.playback)
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
            frame={playback.active && playback.epochIndex === cell.epochIndex}
            progress={cell.epochIndex < progressCells}
            onSelect={toggleSelectedEpoch}
          />
        ))}
      </div>
      {badRuns.length > 0 ? (
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