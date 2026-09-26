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
 *
 * Обёртка скрытия есть **только у сворачиваемой секции**, раскрытая — прозрачна
 * для раскладки (`display: contents`). Лишний блок между секцией и содержимым рвёт
 * flex-цепочку «Треки записи» (`flex-1 min-h-0` перестаёт держать высоту области),
 * замер области растёт вместе с контентом, и разворот трека вьюера входит в
 * бесконечный рост — вкладка зависает намертво (регрессия 22.09.2026, ловушка —
 * `docs/rules/frontend-perf.md` п. 3.7).
 */
import { ChevronRight } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useUiStore } from '@/shared/state/uiStore'
import { cx } from './cx'
import { usePanelNavRegistry } from './panelNav'
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
  /**
   * Регистрация в меню быстрого перемещения панели опций: секция внутри панели
   * (`scope !== null`) объявляет себя реестру (`panelNav.ts`), чтобы хедер панели
   * показал её пунктом меню. Вне панели реестра нет — регистрировать некого.
   */
  const navRegistry = usePanelNavRegistry()
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (scope === null || navRegistry === null) return
    const el = sectionRef.current
    if (!el) return
    return navRegistry.register({ key: panelKey, title, el })
  }, [scope, navRegistry, panelKey, title])
  const header = <span className="block">{title}</span>
  const content = (
    <>
      {children}
      {hint ? <p className="mt-2 text-sm text-fg-2">{hint}</p> : null}
    </>
  )

  return (
    <section
      ref={sectionRef}
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
      {isCollapsible ? (
        // Раскрытая обёртка прозрачна для раскладки (`contents`), свёрнутая скрыта `hidden`
        <div id={contentId} hidden={hidden} className={hidden ? undefined : 'contents'}>
          {content}
        </div>
      ) : (
        content
      )}
    </section>
  )
}

