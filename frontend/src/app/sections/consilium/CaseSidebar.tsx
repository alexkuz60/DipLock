/**
 * Выдвижной левый сайдбар рабочей области Консилиума (срез 0015).
 *
 * Две переключаемые вкладки: боковая консультация с одним советником («Чат») и
 * дерево навигации по ленте раундов («Дерево»). Ширина меняется перетаскиванием
 * ручки (стрелки ←/→ с клавиатуры), сворачивание — кнопкой шапки; состояние
 * персистится в `consiliumOptions` (настройки UI, не серверные данные).
 */
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { ConsiliumCase } from '@/shared/api/types'
import {
  useConsiliumOptions,
  type ConsiliumSidebarTab,
} from '@/shared/state/consiliumOptions'
import { Button } from '@/shared/ui/Button'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { ConsultationChat } from './ConsultationChat'
import { RoundsTree } from './RoundsTree'

export function CaseSidebar({
  current,
  onJump,
}: {
  current: ConsiliumCase
  onJump: (target: string) => void
}) {
  const sidebar = useConsiliumOptions((state) => state.sidebar)
  const setSidebarWidth = useConsiliumOptions((state) => state.setSidebarWidth)
  const setSidebarTab = useConsiliumOptions((state) => state.setSidebarTab)
  const setSidebarOpen = useConsiliumOptions((state) => state.setSidebarOpen)

  /** Перетаскивание ручки: ширина = исходная + сдвиг курсора (clamp в сторе). */
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const startX = event.clientX
    const startWidth = sidebar.width
    const move = (moveEvent: PointerEvent) => {
      setSidebarWidth(startWidth + (moveEvent.clientX - startX))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  function onHandleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSidebarWidth(sidebar.width - 16)
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSidebarWidth(sidebar.width + 16)
    }
  }

  return (
    <aside
      aria-label="Левая панель исследования"
      className="flex shrink-0"
      style={{ width: `${sidebar.width}px` }}
    >
      <div className="min-w-0 flex-1 space-y-3 rounded-lg border border-border bg-bg-1 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Вкладка"
            layout="inline"
            value={sidebar.tab}
            onChange={(tab: ConsiliumSidebarTab) => setSidebarTab(tab)}
            options={[
              { value: 'chat', label: 'Чат' },
              { value: 'tree', label: 'Дерево' },
            ]}
          />
          <Button variant="ghost" onClick={() => setSidebarOpen(false)}>
            Свернуть панель
          </Button>
        </div>
        {sidebar.tab === 'chat' ? (
          <ConsultationChat current={current} />
        ) : (
          <RoundsTree caseId={current.id} onJump={onJump} />
        )}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Ширина левой панели"
        title="Потяните, чтобы изменить ширину (стрелки ←/→)"
        tabIndex={0}
        data-testid="sidebar-resize"
        onPointerDown={startResize}
        onKeyDown={onHandleKeyDown}
        className="w-1 shrink-0 cursor-col-resize rounded bg-border hover:bg-accent/60"
      />
    </aside>
  )
}