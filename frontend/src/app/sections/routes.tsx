/**
 * Связка «раздел реестра → компонент рабочей области и панель опций».
 *
 * Реестр (`registry.ts`) хранит только метаданные, здесь — React-компоненты.
 * Такой разрез позволяет тестировать реестр без рендера тяжёлых разделов.
 * Маршруты берутся из `SECTION_ROUTES` (там же, где реестр).
 *
 * Модули разделов грузятся **лениво** (`sectionModules.ts`): до 16.11.2026 все
 * 15 разделов попадали в один чанк (1,8 МБ / 519 КБ gzip), и первая отрисовка
 * любого маршрута тянула вьюер EDF, uPlot, Tone.js и глоссарий Wiki.
 */
import { Suspense } from 'react'
import { AppShell } from '@/app/layout/AppShell'
import { getSection, type SectionId } from './registry'
import { loadSection, loadedSection } from './sectionModules'

function useSectionModule(id: SectionId) {
  const module = loadedSection(id)
  if (module) return module
  // Классический Suspense-контракт: бросаем промис, React повторит рендер.
  throw loadSection(id)
}

/** Каркас без содержимого: рейл и шапка не мигают при первой загрузке раздела. */
function SectionSkeleton({ id }: { id: SectionId }) {
  return (
    <AppShell section={getSection(id)}>
      <p className="p-4 text-sm text-fg-2">Загрузка раздела…</p>
    </AppShell>
  )
}

function SectionContent({ id }: { id: SectionId }) {
  const { Component, Panel, TitleBefore, TitleAfter, ToolActions, HeaderExtra, HeaderStrip, Drawer } =
    useSectionModule(id)

  return (
    <AppShell
      section={getSection(id)}
      titleBefore={TitleBefore ? <TitleBefore /> : undefined}
      titleAfter={TitleAfter ? <TitleAfter /> : undefined}
      actions={ToolActions ? <ToolActions /> : undefined}
      headerExtra={HeaderExtra ? <HeaderExtra /> : undefined}
      headerStrip={HeaderStrip ? <HeaderStrip /> : undefined}
      drawer={Drawer ? <Drawer /> : undefined}
      panel={Panel ? <Panel /> : undefined}
    >
      <Component />
    </AppShell>
  )
}

/** Раздел внутри каркаса: тулс-хедер + рабочая область + панель опций. */
export function SectionRoute({ id }: { id: SectionId }) {
  return (
    <Suspense fallback={<SectionSkeleton id={id} />}>
      <SectionContent id={id} />
    </Suspense>
  )
}
