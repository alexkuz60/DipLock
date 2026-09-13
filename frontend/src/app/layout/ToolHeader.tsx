/** Тулс-хедер рабочей области: заголовок раздела, действия, кнопка панели опций. */
import { PanelRight, PanelRightClose } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SectionConfig } from '@/app/sections/registry'
import { useUiStore } from '@/shared/state/uiStore'
import { IconButton } from '@/shared/ui/IconButton'

export type ToolHeaderProps = {
  section: SectionConfig
  /** Действия раздела (запуск задачи, экспорт и т.п.) */
  actions?: ReactNode
}

export function ToolHeader({ section, actions }: ToolHeaderProps) {
  const open = useUiStore((state) => state.rightPanelOpen[section.id] ?? false)
  const setRightPanel = useUiStore((state) => state.setRightPanel)

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-bg-1 px-4">
      <h1 className="truncate text-lg font-semibold text-fg-0">{section.title}</h1>

      <div className="ml-auto flex items-center gap-2">
        {actions}
        {section.hasRightPanel ? (
          <IconButton
            icon={open ? <PanelRightClose className="size-5" /> : <PanelRight className="size-5" />}
            tooltip={open ? 'Скрыть панель опций ([)' : 'Показать панель опций ([)'}
            label={open ? 'Скрыть панель опций' : 'Показать панель опций'}
            active={open}
            onClick={() => setRightPanel(section.id, !open)}
          />
        ) : null}
      </div>
    </header>
  )
}
