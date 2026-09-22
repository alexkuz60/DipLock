/** Правый сайдбар: расширенная информация и опции раздела (схлопывается в полоску). */
import { PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SectionConfig } from '@/app/sections/registry'
import { useUiStore } from '@/shared/state/uiStore'
import { IconButton } from '@/shared/ui/IconButton'
import { PanelScopeContext } from '@/shared/ui/panelScope'

export type RightPanelProps = {
  section: SectionConfig
  children?: ReactNode
}

export function RightPanel({ section, children }: RightPanelProps) {
  const open = useUiStore((state) => state.rightPanelOpen[section.id] ?? false)
  const setRightPanel = useUiStore((state) => state.setRightPanel)

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
        <IconButton
          className="ml-auto"
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
      */}
      <div className="scroll-y-always min-h-0 flex-1 space-y-3 p-3">
        <PanelScopeContext.Provider value={section.id}>{children}</PanelScopeContext.Provider>
      </div>
    </aside>
  )
}
