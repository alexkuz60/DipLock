/**
 * Таймлайны вьюера треков: верхняя шкала эпох и нижняя шкала секунд.
 *
 * Обе полосы — выделенные кликабельные зоны (`cursor: pointer`, hover-подсветка
 * ячейки), где одиночный клик переключает блокировку эпохи — тот же вердикт,
 * что и Ctrl+двойной клик по трекам (`TrackStack.handleTrackDoubleClick`):
 *
 * * **верхняя** (липкая, `sticky top-0`) — сетка эпох с номерами; тултип ячейки
 *   объясняет причину: reject-фильтр (порог + каналы-виновники из `drop_log`
 *   MNE) либо ручная правка пользователя;
 * * **нижняя** — полоса поверх оси времени последнего трека (ось uPlot остаётся
 *   визуальным бэкграундом); клик по секунде тогглит эпоху, в которую она
 *   попадает.
 *
 * Обе полосы несут метку роли («эпохи»/«секунды»): это интерактивные оси, а не
 * подписи треков.
 */
import { timeToX } from '@/shared/lib/viewerMath'
import { LABEL_WIDTH } from '@/shared/lib/trackOptions'
import {
  cellAtTime,
  epochMarkTitle,
  isEpochBlocked,
  type EpochCell,
} from '@/shared/lib/viewerLayers'
import { cx } from '@/shared/ui/cx'
import type { LayerGeometry } from './TrackLayers'

/** Высота верхней шкалы эпох, px */
export const EPOCH_RULER_HEIGHT = 22

/** Высота нижней шкалы секунд, px (совпадает с осью времени uPlot, `axis.size`) */
export const TIME_RULER_HEIGHT = 26

/** Порог ширины ячейки, после которого номер/секунда не помещаются */
const RULER_NUMBER_MIN_PX = 22

/** Переключатель эпохи: интервал ячейки + вердикт reject-фильтра этой эпохи */
export type EpochToggleHandler = (
  interval: { onsetSec: number; durationSec: number },
  rejectedByAlgorithm: boolean,
) => void

/** Обрезка интервала по окну: left/width в пикселях трека, либо null вне окна */
function clipToWindow(
  onsetSec: number,
  durationSec: number,
  geometry: LayerGeometry,
): { left: number; width: number } | null {
  const rawLeft = timeToX(onsetSec, geometry.window, geometry.trackWidth)
  const rawRight = timeToX(onsetSec + durationSec, geometry.window, geometry.trackWidth)
  if (rawRight <= 0 || rawLeft >= geometry.trackWidth) return null
  const left = Math.max(0, rawLeft)
  return { left, width: Math.max(2, Math.min(geometry.trackWidth, rawRight) - left) }
}

/** Заливка ячейки по вердикту: заблокированная — красноватая, восстановленная — зеленоватая */
function cellFill(cell: EpochCell): string | undefined {
  if (isEpochBlocked(cell.rejected, cell.manual)) return 'bg-danger/15'
  if (cell.manual === 'allowed') return 'bg-ok/10'
  return undefined
}

/** Метка роли полосы — «эпохи»/«секунды» слева, в колонке подписей каналов */
function RulerTag({ text }: { text: string }) {
  return (
    <span
      aria-hidden
      className="absolute top-1/2 pr-1 -translate-y-1/2 text-right text-[10px] tracking-wider text-fg-2 uppercase"
      style={{ left: 0, width: LABEL_WIDTH }}
    >
      {text}
    </span>
  )
}

/**
 * Верхняя шкала эпох (липкая полоса-таймлайн): ячейка — одна эпоха, клик —
 * тоггл её блокировки, `aria-pressed` несёт текущий вердикт. Номера показываются,
 * пока ячейки шире `RULER_NUMBER_MIN_PX` — иначе остаётся hover-подсветка.
 */
export function EpochRuler({
  cells,
  geometry,
  rejectThresholdUv,
  onToggle,
}: {
  cells: EpochCell[]
  geometry: LayerGeometry
  /** Порог reject-фильтра слоя — для причины в тултипе (null — не задан) */
  rejectThresholdUv: number | null
  onToggle: EpochToggleHandler
}) {
  return (
    <div
      data-testid="epoch-ruler"
      role="group"
      aria-label="Шкала эпох: клик блокирует эпоху или снимает блокировку"
      className="sticky top-0 z-20 shrink-0 border-b border-border bg-bg-2"
      style={{ height: EPOCH_RULER_HEIGHT }}
    >
      <RulerTag text="эпохи" />
      <div
        className="absolute inset-y-0"
        style={{ left: LABEL_WIDTH + 4, width: geometry.trackWidth }}
      >
        {cells.map((cell) => {
          const clipped = clipToWindow(cell.onsetSec, cell.durationSec, geometry)
          if (!clipped) return null
          const blocked = isEpochBlocked(cell.rejected, cell.manual)
          const title = epochMarkTitle(cell, rejectThresholdUv)
          return (
            <button
              key={cell.index}
              type="button"
              data-testid={`epoch-ruler-${cell.index + 1}`}
              data-blocked={blocked ? 'true' : undefined}
              title={title}
              aria-label={title}
              aria-pressed={blocked}
              onClick={() =>
                onToggle(
                  { onsetSec: cell.onsetSec, durationSec: cell.durationSec },
                  cell.rejected,
                )
              }
              className={cx(
                'absolute inset-y-0 cursor-pointer overflow-hidden border-r border-border/50 px-1 text-left hover:bg-bg-3',
                cellFill(cell),
              )}
              style={clipped}
            >
              {clipped.width >= RULER_NUMBER_MIN_PX ? (
                <span className="tnum block text-[10px] leading-[22px] text-fg-1">
                  {cell.index + 1}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Нижняя шкала секунд: полоса поверх оси времени последнего трека (прижата к
 * низу стека, высота = `axis.size` uPlot — ось остаётся визуальным бэкграундом).
 * Клик по секунде — тоггл эпохи, содержащей её; тултип объявляет и секунду, и
 * эпоху с её причиной.
 */
export function TimeRuler({
  cells,
  geometry,
  durationSec,
  rejectThresholdUv,
  onToggleAt,
}: {
  cells: EpochCell[]
  geometry: LayerGeometry
  durationSec: number
  /** Порог reject-фильтра слоя — для причины в тултипе (null — не задан) */
  rejectThresholdUv: number | null
  onToggleAt: (timeSec: number) => void
}) {
  const first = Math.max(0, Math.floor(geometry.window.t0))
  const last = Math.min(Math.ceil(durationSec), Math.ceil(geometry.window.t1))
  const seconds: number[] = []
  for (let sec = first; sec < last; sec += 1) seconds.push(sec)

  return (
    <div
      data-testid="time-ruler"
      role="group"
      aria-label="Шкала секунд: клик блокирует эпоху под секундой или снимает блокировку"
      className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-border bg-bg-2/85"
      style={{ height: TIME_RULER_HEIGHT }}
    >
      <RulerTag text="секунды" />
      <div
        className="absolute inset-y-0"
        style={{ left: LABEL_WIDTH + 4, width: geometry.trackWidth }}
      >
        {seconds.map((sec) => {
          const clipped = clipToWindow(sec, Math.min(1, durationSec - sec), geometry)
          if (!clipped) return null
          const cell = cellAtTime(cells, sec + 0.5)
          const blocked = cell ? isEpochBlocked(cell.rejected, cell.manual) : false
          const title = cell
            ? `Секунда ${sec}–${sec + 1} с · ${epochMarkTitle(cell, rejectThresholdUv)}`
            : `Секунда ${sec}–${sec + 1} с`
          return (
            <button
              key={sec}
              type="button"
              data-testid={`second-${sec}`}
              data-blocked={blocked ? 'true' : undefined}
              title={title}
              aria-label={title}
              onClick={() => onToggleAt(sec + 0.5)}
              className={cx(
                'pointer-events-auto absolute inset-y-0 cursor-pointer overflow-hidden border-l border-border/40 px-1 text-left hover:bg-bg-3',
                blocked && 'bg-danger/15',
              )}
              style={clipped}
            >
              {clipped.width >= RULER_NUMBER_MIN_PX * 1.5 ? (
                <span className="tnum block text-[10px] leading-[26px] text-fg-2">{sec}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}