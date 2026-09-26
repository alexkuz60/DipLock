/**
 * Меню быстрого перемещения по секциям панели опций (кнопка-иконка в её хедере).
 *
 * Пункты — секции-аккордеоны сайдбара (реестр `panelNav.ts`); выбор пункта
 * отдаёт секцию наружу (`onPick`): `RightPanel` раскрывает её и прокручивает
 * к ней панель. Меню открывается под кнопкой слоем выше содержимого панели и
 * закрывается Escape или кликом мимо (тот же паттерн, что у меню пиуль легенды
 * в `viewer/TrackLayers.tsx`).
 */
import { ListTree } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from './IconButton'
import { cx } from './cx'
import type { PanelNavItem } from './panelNav'

export type PanelNavMenuProps = {
  /** Секции панели в порядке следования */
  items: PanelNavItem[]
  /** Выбор секции из меню (раскрыть + прокрутить) */
  onPick: (item: PanelNavItem) => void
  className?: string
}

export function PanelNavMenu({ items, onPick, className }: PanelNavMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={menuRef} className={cx('relative', className)}>
      <IconButton
        icon={<ListTree className="size-5" />}
        tooltip="Быстрое перемещение по секциям панели"
        label="Меню быстрого перемещения по секциям"
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        disabled={items.length === 0}
        onClick={() => setOpen((prev) => !prev)}
      />
      {open ? (
        <div
          role="menu"
          aria-label="Секции панели опций"
          data-testid="panel-nav-menu"
          // Под кнопкой хедера и слоем выше содержимого панели (у него z-index нет)
          className="absolute right-0 top-full z-30 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-border bg-bg-2 p-1 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              title="Перейти к секции и раскрыть её"
              onClick={() => {
                onPick(item)
                setOpen(false)
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-fg-1 hover:bg-bg-3"
            >
              {item.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}