/**
 * Левый рейл: иконки разделов (сверху основные, снизу служебные) + счётчик задач.
 *
 * Активность раздела считается здесь, а класс — **строка** (срез 5, поправка):
 * `NavLink` умеет `className`-функцию, но ссылка живёт внутри Radix `Slot`
 * (`Tooltip asChild`), а тот склеивает className'ы в строку — от функции в `class`
 * попадал её текст, и стили рейла (рамка, фон, подсветка активного) не применялись
 * вовсе. Поэтому активный раздел вычисляем сами и помечаем `aria-current`.
 */
import { NavLink, useLocation } from 'react-router-dom'
import { MAIN_SECTIONS, UTILITY_SECTIONS, type SectionConfig } from '@/app/sections/registry'
import { useUiStore } from '@/shared/state/uiStore'
import { cx } from '@/shared/ui/cx'
import { Tooltip } from '@/shared/ui/Tooltip'

/** Активен ли раздел: `/` — точное совпадение, остальные маршруты — с вложенными путями. */
function isSectionActive(pathname: string, route: string): boolean {
  if (route === '/') return pathname === '/'
  return pathname === route || pathname.startsWith(`${route}/`)
}

export function RailLink({ section, badge }: { section: SectionConfig; badge?: number }) {
  const Icon = section.icon
  const { pathname } = useLocation()
  const active = isSectionActive(pathname, section.route)
  const tooltip = section.hotkey ? `${section.hint} · клавиша ${section.hotkey}` : section.hint

  return (
    <Tooltip label={tooltip}>
      <NavLink
        to={section.route}
        end={section.route === '/'}
        aria-label={section.title}
        aria-current={active ? 'page' : undefined}
        className={cx(
          'relative flex h-12 w-12 items-center justify-center rounded-xl border transition-colors',
          active
            ? 'border-accent/60 bg-accent-soft text-fg-0'
            : 'border-transparent text-fg-1 hover:bg-bg-3 hover:text-fg-0',
        )}
      >
        <Icon className="size-6" aria-hidden />
        {badge && badge > 0 ? (
          <span className="tnum absolute -top-1 -right-1 min-w-5 rounded-full bg-accent px-1 text-center text-xs font-semibold text-bg-0">
            {badge}
          </span>
        ) : null}
      </NavLink>
    </Tooltip>
  )
}

export function IconRail() {
  const activeJobs = useUiStore((state) => state.activeJobs)

  return (
    <nav
      aria-label="Разделы приложения"
      className="flex shrink-0 flex-col items-center gap-2 border-r border-border bg-bg-1 py-3"
    >
      <div className="mb-1 text-2xl select-none" title="DipLock" aria-hidden>
        🧠
      </div>

      {MAIN_SECTIONS.map((section) => (
        <RailLink key={section.id} section={section} />
      ))}

      <div className="mt-auto flex flex-col items-center gap-2 border-t border-border pt-3">
        {activeJobs > 0 ? (
          <Tooltip label={`Активных задач: ${activeJobs}`}>
            <div
              aria-label={`Активных задач: ${activeJobs}`}
              className="tnum flex h-8 min-w-8 items-center justify-center rounded-full bg-accent/20 px-2 text-sm font-semibold text-accent"
            >
              {activeJobs}
            </div>
          </Tooltip>
        ) : null}

        {UTILITY_SECTIONS.map((section) => (
          <RailLink key={section.id} section={section} />
        ))}
      </div>
    </nav>
  )
}
