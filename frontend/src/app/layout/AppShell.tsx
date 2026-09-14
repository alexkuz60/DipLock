/**
 * Каркас приложения: рейл разделов слева, рабочая область с тулс-хедером
 * в центре, схлопываемая панель опций справа.
 *
 * Горячие клавиши: 1…5 — разделы, «[» — панель опций. Обработчик игнорирует
 * ввод в полях, чтобы хоткеи не мешали набору параметров.
 */
import { useEffect, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconRail } from './IconRail'
import { RightPanel } from './RightPanel'
import { StatusBar } from './StatusBar'
import { ToolHeader } from './ToolHeader'
import { MAIN_SECTIONS, type SectionConfig } from '@/app/sections/registry'
import { useUiStore } from '@/shared/state/uiStore'

const HOTKEY_ROUTES: Record<string, string> = Object.fromEntries(
  MAIN_SECTIONS.filter((section) => section.hotkey).map((section) => [section.hotkey, section.route]),
)

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export type AppShellProps = {
  section: SectionConfig
  children: ReactNode
  /** Действия в тулс-хедере (сразу после заголовка раздела) */
  actions?: ReactNode
  /** Вторичные действия тулс-хедера (у правого края) */
  headerExtra?: ReactNode
  /** Содержимое правого сайдбара */
  panel?: ReactNode
}

export function AppShell({ section, children, actions, headerExtra, panel }: AppShellProps) {
  const navigate = useNavigate()
  const toggleRightPanel = useUiStore((state) => state.toggleRightPanel)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || TYPING_TAGS.has(target.tagName))) return

      if (event.key === '[') {
        if (!section.hasRightPanel) return
        event.preventDefault()
        toggleRightPanel(section.id)
        return
      }

      const route = HOTKEY_ROUTES[event.key]
      if (route) {
        event.preventDefault()
        navigate(route)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate, section.hasRightPanel, section.id, toggleRightPanel])

  return (
    /*
      Явная строка `minmax(0,1fr)` (а не авто-высота): без неё единственная
      неявная строка растягивалась под содержимое (тысячи пикселей треков),
      каркас вылезал за экран и резался `overflow-hidden` — внутренние скроллы
      рабочих областей при этом не появлялись. Строка с минимумом 0 держит
      колонки ровно в высоту окна, и скроллятся уже сами области.
    */
    <div className="grid h-screen grid-cols-[4.5rem_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)] overflow-hidden bg-bg-0">
      <IconRail />

      <div className="flex min-h-0 min-w-0 flex-col">
        {section.hasToolHeader ? (
          <ToolHeader section={section} actions={actions} secondary={headerExtra} />
        ) : null}
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        <StatusBar section={section} />
      </div>

      <RightPanel section={section}>{panel}</RightPanel>
    </div>
  )
}
