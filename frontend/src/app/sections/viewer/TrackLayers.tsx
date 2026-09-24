/**
 * Слои результата поверх треков вьюера (срез 2.6): зоны артефактов, границы
 * эпох и штриховка отброшенных эпох.
 *
 * Слои — чистый DOM поверх canvas-треков: uPlot рисует сигнал, React — результат
 * предподготовки. Так проще тултипы/выделение (зоны это кнопки), а зум не требует
 * перерисовки canvas: пересчитываются только позиции по окну (`timeToX`).
 *
 * Геометрия общая с курсором и мышью вьюера: колонка подписей (``LABEL_WIDTH``)
 * вычитается из координат один раз, дальше всё живёт в пикселях трека.
 */
import { useEffect, useRef, useState } from 'react'
import { ARTIFACT_COLORS, ARTIFACT_KINDS, ARTIFACT_SHORT_LABELS, artifactFill } from '@/shared/lib/artifacts'
import type { NavMode } from '@/shared/state/edfParams'
import { timeToX, type TimeWindow } from '@/shared/lib/viewerMath'
import {
  artifactZoneText,
  epochMarkTitle,
  formatSecondsRange,
  isEpochBlocked,
  type ArtifactZone,
  type EpochCell,
} from '@/shared/lib/viewerLayers'
import { cx } from '@/shared/ui/cx'

export type LayerGeometry = {
  window: TimeWindow
  /** Ширина области треков без колонки подписей, px */
  trackWidth: number
}

/** Зоны артефактов: заливка по типу, клик — выделение и панель с деталями. */
export function ArtifactZoneLayer({
  zones,
  geometry,
  selectedId,
  onSelect,
}: {
  zones: ArtifactZone[]
  geometry: LayerGeometry
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  return (
    <>
      {zones.map((zone) => {
        const rawLeft = timeToX(zone.onsetSec, geometry.window, geometry.trackWidth)
        const rawRight = timeToX(
          zone.onsetSec + zone.durationSec,
          geometry.window,
          geometry.trackWidth,
        )
        // Зона вне окна — не рендерим; заходящая за край — обрезаем по окну
        if (rawRight <= 0 || rawLeft >= geometry.trackWidth) return null
        const left = Math.max(0, rawLeft)
        const width = Math.max(2, Math.min(geometry.trackWidth, rawRight) - left)
        const selected = zone.id === selectedId
        return (
          <button
            key={zone.id}
            type="button"
            data-testid={`zone-${zone.id}`}
            data-kind={zone.kind}
            data-selected={selected ? 'true' : undefined}
            title={artifactZoneText(zone)}
            aria-label={artifactZoneText(zone)}
            aria-pressed={selected}
            onClick={() => onSelect(selected ? null : zone.id)}
            className={cx(
              'pointer-events-auto absolute inset-y-0 rounded-[3px] transition',
              selected ? 'ring-1 ring-fg-0' : 'hover:ring-1 hover:ring-fg-2/50',
            )}
            style={{
              left,
              width,
              backgroundColor: artifactFill(zone.kind),
              borderLeft: `2px solid ${ARTIFACT_COLORS[zone.kind]}`,
            }}
          />
        )
      })}
    </>
  )
}

/** Косая штриховка «эпоха не пойдёт в расчёт»: цвет — токен темы, не hex в JS. */
function hatchImage(density: number): string {
  return `repeating-linear-gradient(45deg, color-mix(in srgb, var(--color-danger) ${density}%, transparent) 0 2px, transparent 2px 7px)`
}

/**
 * Границы эпох и штриховка эпох, исключённых из расчёта.
 *
 * Номера эпох рисует только липкая шкала (`TrackRulers.EpochRuler`): строки
 * границ без подписей — иначе номера дублировались бы над верхним треком
 * (ручная проверка, 23.09.2026).
 *
 * Штриховка рисуется по итоговому вердикту (`isEpochBlocked`): решение
 * reject-фильтра плюс ручная правка пользователя (срез 2.10). Правка видна
 * даже при выключенном тумблере «штриховка отброшенных» — это действие
 * пользователя, а не слой результата: `manual: 'blocked'` даёт свою штриховку
 * с акцентной границей, `manual: 'allowed'` — пунктирный контур «разблокировано».
 */
export function EpochLayer({
  cells,
  geometry,
  showBoundaries,
  showHatch,
}: {
  cells: EpochCell[]
  geometry: LayerGeometry
  showBoundaries: boolean
  showHatch: boolean
}) {
  const marks = cells.filter(
    (cell) => cell.manual !== null || (showHatch && isEpochBlocked(cell.rejected, cell.manual)),
  )

  return (
    <>
      {marks.map((cell) => {
        const left = timeToX(cell.onsetSec, geometry.window, geometry.trackWidth)
        const right = timeToX(
          cell.onsetSec + cell.durationSec,
          geometry.window,
          geometry.trackWidth,
        )
        if (right <= 0 || left >= geometry.trackWidth) return null
        const clippedLeft = Math.max(0, left)
        const title = epochMarkTitle(cell)
        const manual = cell.manual
        return (
          <div
            key={`hatch-${cell.index}`}
            data-testid={`epoch-hatch-${cell.index}`}
            data-manual={manual ?? undefined}
            {...(manual === null
              ? { 'aria-hidden': true }
              : { role: 'img' as const, 'aria-label': title, title })}
            className="pointer-events-none absolute inset-y-0"
            style={{
              left: clippedLeft,
              width: Math.max(1, Math.min(geometry.trackWidth, right) - clippedLeft),
              backgroundImage: isEpochBlocked(cell.rejected, manual)
                ? hatchImage(manual === 'blocked' ? 58 : 34)
                : undefined,
              // Ручные пометки должны читаться и без штриховки: контур — свой у каждой
              borderLeft:
                manual === 'blocked'
                  ? '2px solid var(--color-danger)'
                  : manual === 'allowed'
                    ? '2px dashed var(--color-ok)'
                    : undefined,
            }}
          />
        )
      })}

      {showBoundaries
        ? cells.map((cell) => {
            // Начало первой эпохи — это край записи, а не граница: линию не рисуем
            if (cell.onsetSec <= geometry.window.t0) return null
            const left = timeToX(cell.onsetSec, geometry.window, geometry.trackWidth)
            if (left < 0 || left > geometry.trackWidth) return null
            return (
              <div
                key={`edge-${cell.index}`}
                className="pointer-events-none absolute inset-y-0 border-l border-dashed border-fg-2/45"
                data-testid={`epoch-edge-${cell.index}`}
                style={{ left }}
              />
            )
          })
        : null}
    </>
  )
}

/**
 * Рамки эпох-отбросов в треке канала-виновника (причины блокировки): reject-
 * фильтр ронял эти эпохи именно по этому каналу (`drop_log` MNE →
 * `EpochCell.rejectChannels`). Рамка **дополняет** полновысотную штриховку
 * `EpochLayer`: штриховка — факт блокировки по всей высоте стека, рамка — какой
 * канал её вызвал. Декоративна: клики и тултипы причин живут на таймлайнах
 * (`TrackRulers`), треки клик остаётся курсором.
 */
export function EpochFrameLayer({
  cells,
  geometry,
}: {
  cells: EpochCell[]
  geometry: LayerGeometry
}) {
  return (
    <>
      {cells.map((cell) => {
        const left = timeToX(cell.onsetSec, geometry.window, geometry.trackWidth)
        const right = timeToX(
          cell.onsetSec + cell.durationSec,
          geometry.window,
          geometry.trackWidth,
        )
        if (right <= 0 || left >= geometry.trackWidth) return null
        const clippedLeft = Math.max(0, left)
        return (
          <div
            key={cell.index}
            aria-hidden
            data-testid={`epoch-frame-${cell.index + 1}`}
            className="pointer-events-none absolute inset-y-0 rounded-[3px] border-2 border-danger/80"
            style={{
              left: clippedLeft,
              width: Math.max(2, Math.min(geometry.trackWidth, right) - clippedLeft),
            }}
          />
        )
      })}
    </>
  )
}

/**
 * Легенда вьюера: чипы типов артефактов с числом зон в текущем кадре.
 *
 * Клик по пилюле (правка 24.09.2026, уточнение — по числу зон типа):
 *
 * * **зон этого типа нет (0)** — сразу тумблер слоя (`onToggle`), меню не
 *   открывается: пункту «Навигация» нечего предлагать, шагать не по чему;
 * * **зоны есть (> 0)** — меню: «Вкл/Выкл слой» — тот же тумблер, что чекбоксы
 *   правой панели (состояние одно — `artifactVisibility`), разделитель и
 *   «Вкл/Выкл режима "Навигация"» — режим навигатора зума в шапке, шагающий
 *   **по артефактам этого типа** («по своим»: галочка — только у своей пилюли,
 *   `navKind`; клик по своей выключает режим, по чужой — переключает на её тип).
 *
 * Меню открывается **над** пилюлей и слоем выше липкой шкалы эпох
 * (`TrackRulers.EpochRuler` держит `z-20`, меню — `z-30`): при равных z и
 * открытии вниз шкала рисовалась поверх меню (фидбэк 24.09.2026).
 * ICA-чип — информационный, меню не имеет.
 */
export function LayersLegend({
  counts,
  visibility,
  onToggle,
  navMode = 'window',
  navKind = null,
  onToggleNavMode,
  className,
}: {
  counts: Record<string, number>
  visibility: Record<string, boolean>
  onToggle: (kind: (typeof ARTIFACT_KINDS)[number]) => void
  /** Режим навигатора шапки: галочка пункта меню */
  navMode?: NavMode
  /** Тип артефактов текущей «Навигации» («по своим»): галочка — у своей пилюли */
  navKind?: (typeof ARTIFACT_KINDS)[number] | null
  /** Тумблер режима «Навигация» по артефактам типа (нет — пункт меню не показывается) */
  onToggleNavMode?: (kind: (typeof ARTIFACT_KINDS)[number]) => void
  className?: string
}) {
  /** Открытое меню пилюли: одно на легенду, закрывается кликом мимо или Escape */
  const [openKind, setOpenKind] = useState<(typeof ARTIFACT_KINDS)[number] | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (openKind === null) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpenKind(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenKind(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openKind])

  return (
    <div
      className={cx('flex flex-wrap items-center gap-1.5', className)}
      role="group"
      aria-label="Легенда слоёв"
    >
      {ARTIFACT_KINDS.map((kind) => {
        const on = visibility[kind] !== false
        // ICA: EOG-компоненты не привязаны ко времени (зона контрактом не
        // создаётся — фидбэк 24.09.2026), поэтому чип только информационный:
        // тумблеру нечего скрывать, а число — счётчик компонент стадии
        if (kind === 'ica_eog') {
          return (
            <span
              key={kind}
              data-testid={`legend-${kind}`}
              title={`ICA: ${counts[kind] ?? 0} EOG-компонент — без привязки ко времени, слой не рисуется`}
              className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-fg-1"
            >
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: ARTIFACT_COLORS[kind] }}
              />
              {ARTIFACT_SHORT_LABELS[kind]}
              <span className="tnum text-fg-2">{counts[kind] ?? 0}</span>
            </span>
          )
        }
        return (
          <div key={kind} className="relative" ref={openKind === kind ? menuRef : null}>
            <button
              type="button"
              aria-pressed={on}
              aria-haspopup="menu"
              aria-expanded={openKind === kind}
              data-testid={`legend-${kind}`}
              onClick={() => {
                // Зон этого типа нет — сразу тумблер слоя, без меню: «Навигации»
                // нечего предлагать (фидбэк 24.09.2026)
                if ((counts[kind] ?? 0) === 0) {
                  onToggle(kind)
                  return
                }
                setOpenKind((current) => (current === kind ? null : kind))
              }}
              title={
                (counts[kind] ?? 0) === 0
                  ? `${ARTIFACT_SHORT_LABELS[kind]}: 0 зон — клик включает/выключает слой`
                  : `${ARTIFACT_SHORT_LABELS[kind]}: ${counts[kind]} зон — клик открывает меню (слой и режим «Навигация» по этим артефактам)`
              }
              className={cx(
                'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition',
                on ? 'border-border text-fg-1' : 'border-border/60 text-fg-2/60',
              )}
            >
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: ARTIFACT_COLORS[kind], opacity: on ? 1 : 0.3 }}
              />
              {ARTIFACT_SHORT_LABELS[kind]}
              <span className="tnum text-fg-2">{counts[kind] ?? 0}</span>
            </button>
            {openKind === kind ? (
              <div
                role="menu"
                data-testid={`legend-menu-${kind}`}
                aria-label={`Меню слоя ${ARTIFACT_SHORT_LABELS[kind]}`}
                // Над пилюлей и слоем выше липкой шкалы эпох (`EpochRuler` — z-20):
                // при равных z и открытии вниз линейка рисовалась поверх меню
                className="absolute bottom-full left-0 z-30 mb-1 min-w-56 rounded-lg border border-border bg-bg-2 p-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  data-testid={`legend-menu-toggle-${kind}`}
                  onClick={() => {
                    onToggle(kind)
                    setOpenKind(null)
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg-1 hover:bg-bg-3"
                >
                  <span aria-hidden className="w-3 text-center">
                    {on ? '✓' : ''}
                  </span>
                  Вкл/Выкл слой
                </button>
                {onToggleNavMode ? (
                  <>
                    <div role="separator" className="my-1 border-t border-border" />
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={navMode === 'artifact' && navKind === kind}
                      data-testid={`legend-menu-nav-${kind}`}
                      title="Режим «Навигация» в шапке: кнопки шагают по артефактам этого типа"
                      onClick={() => {
                        onToggleNavMode(kind)
                        setOpenKind(null)
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg-1 hover:bg-bg-3"
                    >
                      <span aria-hidden className="w-3 text-center">
                        {navMode === 'artifact' && navKind === kind ? '✓' : ''}
                      </span>
                      Вкл/Выкл режима "Навигация"
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Панель выделенной зоны: тип, интервал, длительность и каналы. Появляется по
 * клику на зону и закрывается повторным кликом или крестиком — то, что спека
 * называет «клик по зоне → тултип».
 */
export function SelectedZoneCard({
  zone,
  onClose,
  className,
}: {
  zone: ArtifactZone
  onClose: () => void
  className?: string
}) {
  return (
    <div
      role="status"
      data-testid="zone-details"
      className={cx(
        'flex items-start gap-2 rounded-md border border-border bg-bg-2/95 px-2.5 py-1.5 text-xs shadow-lg',
        className,
      )}
    >
      <span
        aria-hidden
        className="mt-0.5 size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: ARTIFACT_COLORS[zone.kind] }}
      />
      <div className="min-w-0">
        <div className="text-fg-0">{ARTIFACT_SHORT_LABELS[zone.kind]}</div>
        <div className="tnum text-fg-1">
          {formatSecondsRange(zone.onsetSec, zone.durationSec)} · {zone.durationSec.toFixed(3)} с
        </div>
        <div className="truncate text-fg-2" title={zone.channels.join(', ')}>
          Каналы: {zone.channels.length ? zone.channels.join(', ') : 'весь монтаж'}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Скрыть детали зоны"
        className="ml-1 shrink-0 cursor-pointer text-fg-2 hover:text-fg-0"
      >
        ✕
      </button>
    </div>
  )
}
