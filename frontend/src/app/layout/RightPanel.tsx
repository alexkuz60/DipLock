/** Правый сайдбар: расширенная информация и опции раздела (схлопывается в полоску). */
import { PanelRight } from 'lucide-react'
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
  const setRightPanel = useUiStore((state) => state.setRightPanel)
  const setPanelCollapsed = useUiStore((state) => state.setPanelCollapsed)
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

  if (!open) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center border-l border-border bg-bg-1 py-3">
        <IconButton
          icon={<PanelRight className="size-5" />}
          tooltip="Развернуть панель опций ([)"
          label="Развернуть панель опций"
          onClick={() => setRightPanel(section.id, true)}
        />
      </aside>
    )
  }

  return (
    <aside
      aria-label={`Панель опций раздела «${section.shortTitle}»`}
      className="flex w-96 shrink-0 flex-col border-l border-border bg-bg-1"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-sm font-semibold tracking-wide text-fg-2 uppercase">
          Опции раздела
        </span>
        <PanelNavMenu className="ml-auto" items={navItems} onPick={pickSection} />
        <IconButton
          size="md"
          icon={<PanelRight className="size-5" />}
          tooltip="Свернуть панель опций ([)"
          label="Свернуть панель опций"
          onClick={() => setRightPanel(section.id, false)}
        />
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
