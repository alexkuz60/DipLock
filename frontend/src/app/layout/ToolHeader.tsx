/** Тулс-хедер рабочей области: заголовок раздела, действия, кнопка панели опций. */
import { PanelRight, PanelRightClose } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SectionConfig } from '@/app/sections/registry'
import { useUiStore } from '@/shared/state/uiStore'
import { IconButton } from '@/shared/ui/IconButton'

export type ToolHeaderProps = {
  section: SectionConfig
  /** Действия раздела (запуск задачи, экспорт и т.п.) — сразу после заголовка */
  actions?: ReactNode
  /** Вторичные действия — прижаты к правому краю, перед кнопкой панели опций */
  secondary?: ReactNode
}

export function ToolHeader({ section, actions, secondary }: ToolHeaderProps) {
  const open = useUiStore((state) => state.rightPanelOpen[section.id] ?? false)
  const setRightPanel = useUiStore((state) => state.setRightPanel)

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-bg-1 px-4">
      <h1 className="truncate text-lg font-semibold text-fg-0">{section.title}</h1>

      {actions ? (
        <>
          <span aria-hidden className="h-6 w-px shrink-0 bg-border" />
          <div className="flex min-w-0 items-center gap-1.5" aria-label="Действия раздела">
            {actions}
          </div>
        </>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {secondary}
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
