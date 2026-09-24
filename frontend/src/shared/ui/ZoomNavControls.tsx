/**
 * Навигация по окну и выбор масштаба времени — один контрол на разделы (2.9, «ЭЭГ»).
 *
 * Комбо-бокс дублирует контрол панели, но всегда под рукой (колесо мыши дублирует
 * его только в «ЭЭГ»: в EDF колесо прокручивает треки — `viewer/TrackStack`):
 * уровень — это индекс в `TIME_LEVELS` (×1 — вся сессия … ×16). Правка ничего не
 * запускает: зум — параметр отрисовки, расчёт от него не устаревает.
 *
 * Кнопки `<<` `<` `>` `>>` листают окно, а окно у разделов своё (вьюер EDF —
 * `navRequest`, «ЭЭГ» — `eegNav`), поэтому команда идёт **наверх** колбэком, а
 * не напрямую в стор: вьюер получает её через состояние, как и раньше.
 * При ×1 видна вся запись — двигать некуда, кнопки выключены.
 *
 * Два режима (`navMode`, переключатель — пункт «Вкл/Выкл режима "Навигация"» в
 * меню пиуль легенды): `window` — листание окна, `artifact` — шаги по номеру
 * найденного артефакта **выбранного типа** («по своим»: тип задаёт пилюля,
 * `navKind`) с учётом выбранного зума; номер шага («3/47») —
 * информативность, его держит стор раздела (`ArtifactNavStep`).
 *
 * Компонент вынесен из `EdfZoomSelect`, чтобы оба раздела пользовались одной
 * разметкой и одними подписями: второй такой же контрол неизбежно разошёлся бы
 * с первым (тот же уровень зума, но «немного другие» кнопки).
 */
import type { ReactElement } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ZoomIn } from 'lucide-react'
import type { ArtifactNavStep } from '@/shared/lib/viewerLayers'
import { TIME_LEVELS, type NavMode } from '@/shared/state/edfParams'
import { IconButton } from './IconButton'

/** Команда листания окна: `start`/`end` — края записи, `prev`/`next` — на ширину окна */
export type ZoomNavCommand = 'start' | 'prev' | 'next' | 'end'

type NavButtonSpec = {
  command: ZoomNavCommand
  label: string
  tooltip: string
  icon: ReactElement
}

/** Режим «окно»: кнопки листают окно на его ширину и к краям записи */
const WINDOW_NAV_BUTTONS: NavButtonSpec[] = [
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
]

/**
 * Режим «Навигация» (вкл. из меню пиуль легенды): те же кнопки шагают по номеру
 * найденного артефакта, окно центрируется на зоне текущим зумом (ширина окна не
 * меняется — «с учётом выбранного зума»).
 */
const ARTIFACT_NAV_BUTTONS: NavButtonSpec[] = [
  {
    command: 'start',
    label: 'К первому артефакту',
    tooltip: 'Перейти к первому найденному артефакту',
    icon: <ChevronsLeft aria-hidden />,
  },
  {
    command: 'prev',
    label: 'Предыдущий артефакт',
    tooltip: 'Предыдущий найденный артефакт (по номеру)',
    icon: <ChevronLeft aria-hidden />,
  },
  {
    command: 'next',
    label: 'Следующий артефакт',
    tooltip: 'Следующий найденный артефакт (по номеру)',
    icon: <ChevronRight aria-hidden />,
  },
  {
    command: 'end',
    label: 'К последнему артефакту',
    tooltip: 'Перейти к последнему найденному артефакту',
    icon: <ChevronsRight aria-hidden />,
  },
]

export type ZoomNavControlsProps = {
  /** Индекс уровня зума в `TIME_LEVELS` (0 — вся сессия) */
  timeLevel: number
  onTimeLevel: (level: number) => void
  onNav: (command: ZoomNavCommand) => void
  /** Режим навигатора: окно (по умолчанию) или «Навигация» по артефактам */
  navMode?: NavMode
  /** Шаг режима «Навигация»: номер артефакта и их число (счётчик «3/47») */
  step?: ArtifactNavStep | null
  /** Доступное имя селекта: у разделов оно разное («отрисовки ЭЭГ», «спектрограммы») */
  zoomLabel: string
  /** Подсказка селекта: что именно меняет масштаб */
  zoomTitle: string
  /** Подсказка кнопок листания при ×1 */
  navDisabledTooltip?: string
  /** Подсказка кнопок шага, когда видимых зон артефактов нет */
  artifactDisabledTooltip?: string
}

export function ZoomNavControls({
  timeLevel,
  onTimeLevel,
  onNav,
  navMode = 'window',
  step = null,
  zoomLabel,
  zoomTitle,
  navDisabledTooltip = 'При ×1 видна вся запись — листать нечего',
  artifactDisabledTooltip = 'Видимых зон артефактов нет — выполните стадию «Поиск артефактов» или включите слои в легенде',
}: ZoomNavControlsProps) {
  const artifactMode = navMode === 'artifact'
  const buttons = artifactMode ? ARTIFACT_NAV_BUTTONS : WINDOW_NAV_BUTTONS
  // Режим «окно» при ×1 не листается (вся запись и так видна); «Навигация»
  // шагает при любом зуме, но только когда видимыми зонами есть чем шагать
  const navDisabled = artifactMode ? (step?.total ?? 0) === 0 : timeLevel === 0
  const disabledTooltip = artifactMode ? artifactDisabledTooltip : navDisabledTooltip
  const navTooltip = (fallback: string) => (navDisabled ? disabledTooltip : fallback)

  const navButtons = (items: NavButtonSpec[]) =>
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
      {navButtons(buttons.slice(0, 2))}
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
      {artifactMode && step && step.total > 0 ? (
        <span
          data-testid="artifact-nav-step"
          title={`Навигация по артефактам: шаг ${step.index + 1} из ${step.total}`}
          className="tnum rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg-1"
        >
          {step.index + 1}/{step.total}
        </span>
      ) : null}
      {navButtons(buttons.slice(2))}
    </div>
  )
}
