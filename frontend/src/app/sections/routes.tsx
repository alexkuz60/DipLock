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
import { HomeSection } from './HomeSection'
import { ServerStatusSection } from './ServerStatusSection'
import { SettingsSection } from './SettingsSection'
import {
  DipolesPanel,
  DipolesSection,
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
}

const SECTION_MODULES: Record<SectionId, SectionModule> = {
  home: { Component: HomeSection },
  edf: { Component: EdfSection, Panel: EdfPanel },
  dipoles: { Component: DipolesSection, Panel: DipolesPanel },
  table: { Component: LocalizationTableSection, Panel: LocalizationTablePanel },
  group: { Component: GroupAnalysisSection, Panel: GroupAnalysisPanel },
  settings: { Component: SettingsSection },
  server: { Component: ServerStatusSection },
}

/** Раздел внутри каркаса: тулс-хедер + рабочая область + панель опций. */
export function SectionRoute({ id }: { id: SectionId }) {
  const section = getSection(id)
  const { Component, Panel } = SECTION_MODULES[id]

  return (
    <AppShell section={section} panel={Panel ? <Panel /> : undefined}>
      <Component />
    </AppShell>
  )
}
