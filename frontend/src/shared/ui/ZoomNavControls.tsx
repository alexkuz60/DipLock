/**
 * Навигация по окну и выбор масштаба времени — один контрол на разделы (2.9, «ЭЭГ»).
 *
 * Комбо-бокс дублирует колесо мыши и контрол панели, но всегда под рукой:
 * уровень — это индекс в `TIME_LEVELS` (×1 — вся сессия … ×16). Правка ничего не
 * запускает: зум — параметр отрисовки, расчёт от него не устаревает.
 *
 * Кнопки `<<` `<` `>` `>>` листают окно, а окно у разделов своё (вьюер EDF —
 * `navRequest`, «ЭЭГ» — `eegNav`), поэтому команда идёт **наверх** колбэком, а
 * не напрямую в стор: вьюер получает её через состояние, как и раньше.
 * При ×1 видна вся запись — двигать некуда, кнопки выключены.
 *
 * Компонент вынесен из `EdfZoomSelect`, чтобы оба раздела пользовались одной
 * разметкой и одними подписями: второй такой же контрол неизбежно разошёлся бы
 * с первым (тот же уровень зума, но «немного другие» кнопки).
 */
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ZoomIn } from 'lucide-react'
import { TIME_LEVELS } from '@/shared/state/edfParams'
import { IconButton } from './IconButton'

/** Команда листания окна: `start`/`end` — края записи, `prev`/`next` — на ширину окна */
export type ZoomNavCommand = 'start' | 'prev' | 'next' | 'end'

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

export type ZoomNavControlsProps = {
  /** Индекс уровня зума в `TIME_LEVELS` (0 — вся сессия) */
  timeLevel: number
  onTimeLevel: (level: number) => void
  onNav: (command: ZoomNavCommand) => void
  /** Доступное имя селекта: у разделов оно разное («отрисовки ЭЭГ», «спектрограммы») */
  zoomLabel: string
  /** Подсказка селекта: что именно меняет масштаб */
  zoomTitle: string
  /** Подсказка кнопок листания при ×1 */
  navDisabledTooltip?: string
}

export function ZoomNavControls({
  timeLevel,
  onTimeLevel,
  onNav,
  zoomLabel,
  zoomTitle,
  navDisabledTooltip = 'При ×1 видна вся запись — листать нечего',
}: ZoomNavControlsProps) {
  // При ×1 в окне вся запись целиком — листать нечего
  const navDisabled = timeLevel === 0
  const navTooltip = (fallback: string) => (navDisabled ? navDisabledTooltip : fallback)

  const navButtons = (items: (typeof NAV_BUTTONS)[number][]) =>
    items.map((spec) => (
      <IconButton
        key={spec.command}
        label={spec.label}
        tooltip={navTooltip(spec.tooltip)}
        icon={spec.icon}
        disabled={navDisabled}
        onClick={() => onNav(spec.command)}
      />
    ))

  return (
    <div className="flex items-center gap-1">
      {navButtons([NAV_BUTTONS[0], NAV_BUTTONS[1]])}
      <label className="flex items-center gap-2 text-sm text-fg-2">
        <ZoomIn className="size-4 shrink-0" aria-hidden />
        <select
          aria-label={zoomLabel}
          title={zoomTitle}
          value={String(timeLevel)}
          onChange={(event) => onTimeLevel(Number(event.target.value))}
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
