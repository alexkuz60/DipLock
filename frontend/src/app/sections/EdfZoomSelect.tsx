/**
 * Навигация по окну и комбо-бокс зума отрисовки ЭЭГ в тулс-хедере раздела EDF.
 *
 * Комбо-бокс дублирует колесо мыши и контрол панели, но всегда под рукой:
 * уровень — это индекс в `TIME_LEVELS` (×1 — вся сессия … ×16). Правка ничего не
 * запускает: зум — параметр отрисовки, расчёт от него не устаревает.
 *
 * Кнопки `<<` `<` `>` `>>` листают окно, но центр окна — локальное состояние
 * вьюера (`TrackStack`), поэтому команда идёт через стор записи
 * (`requestNav`), а не напрямую. При ×1 видна вся запись — двигать некуда,
 * кнопки выключены.
 */
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ZoomIn } from 'lucide-react'
import { TIME_LEVELS, useEdfParams } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { IconButton } from '@/shared/ui/IconButton'

/** Кнопки листания окна в порядке отрисовки: в начало, назад, вперёд, в конец */
const NAV_BUTTONS = [
  {
    command: 'start',
    label: 'В начало записи',
    tooltip: 'Показать начало записи',
    icon: <ChevronsLeft aria-hidden />,
  },
  {
    command: 'prev',
    label: 'Предыдущее окно',
    tooltip: 'Предыдущее окно — на ширину текущего',
    icon: <ChevronLeft aria-hidden />,
  },
  {
    command: 'next',
    label: 'Следующее окно',
    tooltip: 'Следующее окно — на ширину текущего',
    icon: <ChevronRight aria-hidden />,
  },
  {
    command: 'end',
    label: 'В конец записи',
    tooltip: 'Показать конец записи',
    icon: <ChevronsRight aria-hidden />,
  },
] as const

export function EdfZoomSelect() {
  const level = useEdfParams((state) => state.params.timeLevel)
  const setParams = useEdfParams((state) => state.setParams)
  const requestNav = useEdfRecording((state) => state.requestNav)

  // При ×1 в окне вся запись целиком — листать нечего
  const navDisabled = level === 0
  const navTooltip = (fallback: string) =>
    navDisabled ? 'При ×1 видна вся запись — листать нечего' : fallback

  const navButtons = (items: typeof NAV_BUTTONS[number][]) =>
    items.map((spec) => (
      <IconButton
        key={spec.command}
        label={spec.label}
        tooltip={navTooltip(spec.tooltip)}
        icon={spec.icon}
        disabled={navDisabled}
        onClick={() => requestNav(spec.command)}
      />
    ))

  return (
    <div className="flex items-center gap-1">
      {navButtons([NAV_BUTTONS[0], NAV_BUTTONS[1]])}
      <label className="flex items-center gap-2 text-sm text-fg-2">
        <ZoomIn className="size-4 shrink-0" aria-hidden />
        <select
          aria-label="Зум отрисовки ЭЭГ"
          title="Масштаб по времени: ×1 — вся сессия, ×16 — максимальное приближение"
          value={String(level)}
          onChange={(event) => setParams({ timeLevel: Number(event.target.value) })}
          className="tnum rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg-0"
        >
          {TIME_LEVELS.map((factor, index) => (
            <option key={factor} value={index}>
              ×{factor}
              {index === 0 ? ' (вся сессия)' : ''}
            </option>
          ))}
        </select>
      </label>
      {navButtons([NAV_BUTTONS[2], NAV_BUTTONS[3]])}
    </div>
  )
}

