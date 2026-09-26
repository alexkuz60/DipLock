/** Правый сайдбар: расширенная информация и опции раздела. Закрытая панель не рисуется. */
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import type { SectionConfig } from '@/app/sections/registry'
import { useUiStore } from '@/shared/state/uiStore'
import { IconButton } from '@/shared/ui/IconButton'
import { PanelNavMenu } from '@/shared/ui/PanelNavMenu'
import { PanelScopeContext } from '@/shared/ui/panelScope'
import { PanelNavContext, type PanelNavItem, type PanelNavRegistry } from '@/shared/ui/panelNav'

export type RightPanelProps = {
  section: SectionConfig
  children?: ReactNode
}

export function RightPanel({ section, children }: RightPanelProps) {
  const open = useUiStore((state) => state.rightPanelOpen[section.id] ?? false)
  const setPanelCollapsed = useUiStore((state) => state.setPanelCollapsed)
  const setPanelsCollapsed = useUiStore((state) => state.setPanelsCollapsed)
  /** Фактическая свёрнутость секций — состояние триггера «все секции» в хедере */
  const collapsedPanels = useUiStore((state) => state.collapsedPanels)
  /**
   * Секции панели для меню быстрого перемещения: `Panel` регистрирует себя
   * монтированием (порядок пунктов = порядок секций в панели), снятие — cleanup.
   */
  const [navItems, setNavItems] = useState<PanelNavItem[]>([])
  const navRegistry = useMemo<PanelNavRegistry>(
    () => ({
      register: (item) => {
        setNavItems((prev) => {
          const index = prev.findIndex((entry) => entry.key === item.key)
          // Повторная регистрация (например, после смены заголовка) обновляет
          // запись на прежнем месте, а не уводит секцию в конец меню
          if (index >= 0) {
            const next = prev.slice()
            next[index] = item
            return next
          }
          return [...prev, item]
        })
        return () => setNavItems((prev) => prev.filter((entry) => entry.key !== item.key))
      },
    }),
    [],
  )

  /**
   * Выбор секции в меню: раскрыть (свёрнутость — `collapsedPanels`) и прокрутить
   * к ней панель. `scrollIntoView` бережём от jsdom (там его нет — как в
   * `LocalizationTable`).
   */
  const pickSection = useCallback(
    (item: PanelNavItem) => {
      setPanelCollapsed(item.key, false)
      if (typeof item.el.scrollIntoView === 'function') {
        item.el.scrollIntoView({ block: 'start' })
      }
    },
    [setPanelCollapsed],
  )

  if (!section.hasRightPanel) return null

  /**
   * Все ли секции панели свёрнуты **фактически**: запись из стора, а если её ещё
   * нет — `defaultOpen` секции (так же читает `Panel`). Кнопка хедера — триггер:
   * показывает следующее действие (свернуть, если есть раскрытые; развернуть,
   * когда всё свёрнуто).
   */
  const allCollapsed =
    navItems.length > 0 &&
    navItems.every((item) => collapsedPanels[item.key] ?? !item.defaultOpen)

  /*
   * Закрытая панель не рисует полоски-дублёра с кнопкой «Развернуть панель опций»
   * (правка владельца 26.09.2026): панель схлопывается совсем, контент занимает
   * всю ширину. Возврат — только кнопкой тулс-хендера «Показать панель опций ([)»
   * или хоткеем «[».
   */
  if (!open) return null

  return (
    <aside
      aria-label={`Панель опций раздела «${section.shortTitle}»`}
      className="flex w-96 shrink-0 flex-col border-l border-border bg-bg-1"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-sm font-semibold tracking-wide text-fg-2 uppercase">
          Опции раздела
        </span>
        {/*
          Дублёра тулс-хендера («Скрыть панель опций ([)») здесь больше нет: хедер
          панели управляет её секциями одной кнопкой-триггером «все секции». Сами
          панель закрывают кнопка тулс-хендера и хоткей «[»; свёрнутость секций —
          `collapsedPanels` (переживает перезаход).
          `gap-2` — зазор между кнопками: pointer успевает покинуть кнопку
          (сброс hover), тултип не «залипает» со старым текстом.
        */}
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            icon={allCollapsed ? <ChevronsUpDown className="size-5" /> : <ChevronsDownUp className="size-5" />}
            tooltip={allCollapsed ? 'Развернуть все секции панели' : 'Свернуть все секции панели'}
            label={allCollapsed ? 'Развернуть все секции' : 'Свернуть все секции'}
            active={allCollapsed}
            disabled={navItems.length === 0}
            onClick={() => setPanelsCollapsed(navItems.map((item) => item.key), !allCollapsed)}
          />
          <PanelNavMenu items={navItems} onPick={pickSection} />
        </div>
      </div>
      {/*
        Область секций: `Panel` внутри панели опций становится аккордеоном и хранит
        свёрнутость по разделу («edf:Пороги артефактов»), не путая её с «ЭЭГ».
        `PanelNavContext` собирает секции для меню быстрого перемещения хедера.
      */}
      <div className="scroll-y-always min-h-0 flex-1 space-y-3 p-3">
        <PanelScopeContext.Provider value={section.id}>
          <PanelNavContext.Provider value={navRegistry}>{children}</PanelNavContext.Provider>
        </PanelScopeContext.Provider>
      </div>
    </aside>
  )
}
