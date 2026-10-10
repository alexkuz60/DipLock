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
import { EegPanel } from './eeg/EegPanel'
import { EegSection } from './eeg/EegSection'
import { EegToolHeaderActions } from './eeg/EegToolActions'
import { EegWindowControls } from './eeg/EegWindowControls'
import { DipolesDrawer } from './dipoles/DipolesDrawer'
import { DipolesPanel } from './dipoles/DipolesPanel'
import { DipolesSection } from './dipoles/DipolesSection'
import { DipolesToolHeaderActions } from './dipoles/DipolesToolActions'
import { HomeSection } from './HomeSection'
import { ServerStatusSection } from './ServerStatusSection'
import { SettingsSection } from './SettingsSection'
import { WikiSection } from './wiki/WikiSection'
import { LocalizationTablePanel } from './table/LocalizationTablePanel'
import { LocalizationTableSection } from './table/LocalizationTableSection'
import { SummaryPanel } from './summary/SummaryPanel'
import { SummarySection } from './summary/SummarySection'
import { SummaryToolActions } from './summary/SummaryToolActions'
import { GroupPanel } from './group/GroupPanel'
import { GroupSection } from './group/GroupSection'
import { GroupToolActions } from './group/GroupToolActions'
import { NeuromusicPanel } from './neuromusic/NeuromusicPanel'
import { NeuromusicSection } from './neuromusic/NeuromusicSection'
import {
  NeuromusicTitleFile,
  NeuromusicTitleIcon,
  NeuromusicToolActions,
} from './neuromusic/NeuromusicToolActions'
import {
  EmoLabPanel,
  EmoLabSection,
  NeuroAudioPanel,
  NeuroAudioSection,
} from './Stubs'
import { getSection, type SectionId } from './registry'
import { ConsiliumSection } from './consilium/ConsiliumSection'
import { ConsiliumPanel } from './consilium/common'

type SectionModule = {
  Component: ComponentType
  /** Содержимое правого сайдбара раздела (если у него есть панель) */
  Panel?: ComponentType
  /** Дополнение тулс-хедера перед названием раздела (иконка и т.п.) */
  TitleBefore?: ComponentType
  /** Дополнение тулс-хедера после названия раздела (имя файла и т.п.) */
  TitleAfter?: ComponentType
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
  eeg: {
    Component: EegSection,
    Panel: EegPanel,
    ToolActions: EegToolHeaderActions,
    HeaderExtra: EegWindowControls,
  },
  dipoles: {
    Component: DipolesSection,
    Panel: DipolesPanel,
    ToolActions: DipolesToolHeaderActions,
    Drawer: DipolesDrawer,
  },
  table: { Component: LocalizationTableSection, Panel: LocalizationTablePanel },
  group: {
    Component: GroupSection,
    Panel: GroupPanel,
    ToolActions: GroupToolActions,
  },
  summary: {
    Component: SummarySection,
    Panel: SummaryPanel,
    ToolActions: SummaryToolActions,
  },
  emolab: { Component: EmoLabSection, Panel: EmoLabPanel },
  consilium: { Component: ConsiliumSection, Panel: ConsiliumPanel },
  neuroaudio: { Component: NeuroAudioSection, Panel: NeuroAudioPanel },
  neuromusic: {
    Component: NeuromusicSection,
    Panel: NeuromusicPanel,
    TitleBefore: NeuromusicTitleIcon,
    TitleAfter: NeuromusicTitleFile,
    ToolActions: NeuromusicToolActions,
  },
  wiki: { Component: WikiSection },
  settings: { Component: SettingsSection },
  server: { Component: ServerStatusSection },
}

/** Раздел внутри каркаса: тулс-хедер + рабочая область + панель опций. */
export function SectionRoute({ id }: { id: SectionId }) {
  const section = getSection(id)
  const { Component, Panel, TitleBefore, TitleAfter, ToolActions, HeaderExtra, Drawer } =
    SECTION_MODULES[id]

  return (
    <AppShell
      section={section}
      titleBefore={TitleBefore ? <TitleBefore /> : undefined}
      titleAfter={TitleAfter ? <TitleAfter /> : undefined}
      actions={ToolActions ? <ToolActions /> : undefined}
      headerExtra={HeaderExtra ? <HeaderExtra /> : undefined}
      drawer={Drawer ? <Drawer /> : undefined}
      panel={Panel ? <Panel /> : undefined}
    >
      <Component />
    </AppShell>
  )
}
