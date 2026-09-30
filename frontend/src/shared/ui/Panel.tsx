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
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useUiStore } from '@/shared/state/uiStore'
import { cx } from './cx'
import { usePanelNavRegistry } from './panelNav'
import { PanelActionsHostContext } from './panelActions'
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
  /**
   * Содержимое подзаголовка слева от слота действий: комбо слоёв/полосы
   * секции «Треки записи» (правка 30.09.2026). Portal кнопок экспорта
   * (`usePanelActionsHost`) монтируется следом — экспорта и контролы делят
   * одну строку заголовка.
   */
  actions?: ReactNode
}

export function Panel({
  title,
  hint,
  children,
  className,
  collapsible,
  defaultOpen = true,
  actions,
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
  /** Слот действий в заголовке (portal кнопок экспорта вьюера, см. контекст выше) */
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (scope === null || navRegistry === null) return
    const el = sectionRef.current
    if (!el) return
    return navRegistry.register({ key: panelKey, title, el, defaultOpen })
  }, [scope, navRegistry, panelKey, title, defaultOpen])
  const header = <span className="block truncate">{title}</span>
  const content = (
    <>
      {children}
      {hint ? <p className="mt-2 text-sm text-fg-2">{hint}</p> : null}
    </>
  )

  return (
    <PanelActionsHostContext.Provider value={actionsHost}>
      <section
        ref={sectionRef}
        data-panel-key={panelKey}
        data-collapsed={hidden ? 'true' : 'false'}
        className={cx('rounded-lg border border-border bg-bg-2 p-3', className)}
      >
        <h3
          className={cx(
            'flex items-center gap-2 text-sm font-semibold tracking-wide text-fg-2 uppercase',
            hidden ? undefined : 'mb-2',
          )}
        >
          {isCollapsible ? (
            <button
              type="button"
              aria-expanded={!hidden}
              aria-controls={contentId}
              title={hidden ? 'Развернуть секцию' : 'Свернуть секцию'}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left uppercase hover:text-fg"
              onClick={() => setPanelCollapsed(panelKey, !collapsed)}
            >
              <ChevronRight
                aria-hidden
                className={cx('size-4 shrink-0 transition-transform', hidden ? undefined : 'rotate-90')}
              />
              {header}
            </button>
          ) : (
            <span className="min-w-0 flex-1">{header}</span>
          )}
          {actions ? (
            <span className="flex shrink-0 items-center gap-1">{actions}</span>
          ) : null}
          {/* Слот действий подзаголовка: сюда portal'ятся кнопки содержимого */}
          <span ref={setActionsHost} className="flex shrink-0 items-center gap-1" />
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
    </PanelActionsHostContext.Provider>
  )
}

