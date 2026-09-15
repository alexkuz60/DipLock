/**
 * Связка «раздел реестра → компонент рабочей области и панель опций».
 *
 * Реестр (`registry.ts`) хранит только метаданные, здесь — React-компоненты.
 * Такой разрез позволяет тестировать реестр без рендера тяжёлых разделов.
 * Маршруты берутся из `SECTION_ROUTES` (там же, где реестр).
 */
import type { ComponentType } from 'react'
import { AppShell } from '@/app/layout/AppShell'
import { EdfPanel } from './EdfPanel'
import { EdfSection } from './EdfSection'
import { EdfToolHeaderActions } from './EdfToolActions'
import { EdfZoomSelect } from './EdfZoomSelect'
import { DipolesDrawer } from './dipoles/DipolesDrawer'
import { DipolesPanel } from './dipoles/DipolesPanel'
import { DipolesSection } from './dipoles/DipolesSection'
import { DipolesToolHeaderActions } from './dipoles/DipolesToolActions'
import { HomeSection } from './HomeSection'
import { ServerStatusSection } from './ServerStatusSection'
import { SettingsSection } from './SettingsSection'
import {
  GroupAnalysisPanel,
  GroupAnalysisSection,
  LocalizationTablePanel,
  LocalizationTableSection,
} from './Stubs'
import { getSection, type SectionId } from './registry'

type SectionModule = {
  Component: ComponentType
  /** Содержимое правого сайдбара раздела (если у него есть панель) */
  Panel?: ComponentType
  /** Кнопки-действия тулс-хедера (после заголовка раздела) */
  ToolActions?: ComponentType
  /** Вторичные контролы тулс-хедера (правый край, перед кнопкой панели) */
  HeaderExtra?: ComponentType
  /** Выдвижная панель раздела (полоса между шапкой и рабочей областью) */
  Drawer?: ComponentType
}

const SECTION_MODULES: Record<SectionId, SectionModule> = {
  home: { Component: HomeSection },
  edf: {
    Component: EdfSection,
    Panel: EdfPanel,
    ToolActions: EdfToolHeaderActions,
    HeaderExtra: EdfZoomSelect,
  },
  dipoles: {
    Component: DipolesSection,
    Panel: DipolesPanel,
    ToolActions: DipolesToolHeaderActions,
    Drawer: DipolesDrawer,
  },
  table: { Component: LocalizationTableSection, Panel: LocalizationTablePanel },
  group: { Component: GroupAnalysisSection, Panel: GroupAnalysisPanel },
  settings: { Component: SettingsSection },
  server: { Component: ServerStatusSection },
}

/** Раздел внутри каркаса: тулс-хедер + рабочая область + панель опций. */
export function SectionRoute({ id }: { id: SectionId }) {
  const section = getSection(id)
  const { Component, Panel, ToolActions, HeaderExtra, Drawer } = SECTION_MODULES[id]

  return (
    <AppShell
      section={section}
      actions={ToolActions ? <ToolActions /> : undefined}
      headerExtra={HeaderExtra ? <HeaderExtra /> : undefined}
      drawer={Drawer ? <Drawer /> : undefined}
      panel={Panel ? <Panel /> : undefined}
    >
      <Component />
    </AppShell>
  )
}
