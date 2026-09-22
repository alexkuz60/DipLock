/**
 * Секция правого сайдбара: заголовок + содержимое + необязательная подсказка.
 *
 * Внутри панели опций (`PanelScopeContext`, даёт `RightPanel`) секция — **аккордеон**:
 * заголовок стал кнопкой, содержимое сворачивается, а свёрнутость хранится в
 * `uiStore` (`collapsedPanels`, ключ «раздел:заголовок») и переживает перезаход в
 * раздел — иначе место экономится только до первого перехода между разделами.
 * Вне панели (рабочая область) секция рисуется как раньше, без кнопки: прятать
 * контент посреди экрана незачем.
 *
 * Свёрнутая секция остаётся в DOM (`hidden`), а не размонтируется: внутреннее
 * состояние контролов не теряется, а вид панели расчёт не устаревает
 * (правило в `docs/rules/frontend-state.md`).
 */
import { ChevronRight } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useUiStore } from '@/shared/state/uiStore'
import { cx } from './cx'
import { usePanelScope } from './panelScope'

export type PanelProps = {
  title: string
  hint?: string
  children: ReactNode
  className?: string
  /** Аккордеон: по умолчанию — только внутри панели опций. */
  collapsible?: boolean
  /** Открыта ли секция, пока пользователь её не трогал. */
  defaultOpen?: boolean
}

export function Panel({
  title,
  hint,
  children,
  className,
  collapsible,
  defaultOpen = true,
}: PanelProps) {
  const scope = usePanelScope()
  const contentId = useId()
  const isCollapsible = collapsible ?? scope !== null
  /**
   * Ключ хранилища: «раздел:заголовок». Одинаковые заголовки внутри одного раздела
   * делят состояние свёрнутости — отдельного `id` у секции нет, а плодить его ради
   * каждой панели значит менять все 30+ мест вызова.
   */
  const panelKey = `${scope ?? 'section'}:${title}`
  const collapsed = useUiStore((state) => state.collapsedPanels[panelKey] ?? !defaultOpen)
  const setPanelCollapsed = useUiStore((state) => state.setPanelCollapsed)
  const hidden = isCollapsible && collapsed
  const header = <span className="block">{title}</span>

  return (
    <section
      data-panel-key={panelKey}
      data-collapsed={hidden ? 'true' : 'false'}
      className={cx('rounded-lg border border-border bg-bg-2 p-3', className)}
    >
      <h3
        className={cx(
          'text-sm font-semibold tracking-wide text-fg-2 uppercase',
          hidden ? undefined : 'mb-2',
        )}
      >
        {isCollapsible ? (
          <button
            type="button"
            aria-expanded={!hidden}
            aria-controls={contentId}
            title={hidden ? 'Развернуть секцию' : 'Свернуть секцию'}
            className="flex w-full cursor-pointer items-center gap-1 text-left uppercase hover:text-fg"
            onClick={() => setPanelCollapsed(panelKey, !collapsed)}
          >
            <ChevronRight
              aria-hidden
              className={cx('size-4 shrink-0 transition-transform', hidden ? undefined : 'rotate-90')}
            />
            {header}
          </button>
        ) : (
          header
        )}
      </h3>
      <div id={contentId} hidden={hidden}>
        {children}
        {hint ? <p className="mt-2 text-sm text-fg-2">{hint}</p> : null}
      </div>
    </section>
  )
}

