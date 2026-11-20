/**
 * Ленивая загрузка модулей разделов: `import()` на раздел вместо одного чанка.
 *
 * До 16.11.2026 все 15 разделов попадали в общий бандл (1,8 МБ / 519 КБ gzip), и
 * первая отрисовка любого маршрута тянула вьюер EDF, uPlot, Tone.js и глоссарий
 * Wiki. Здесь — только загрузчик и кэш; компоненты рендерит `routes.tsx`.
 */
import type { ComponentType } from 'react'
import type { SectionId } from './registry'

export type SectionModule = {
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
  /** Второй ряд тулс-хедера (полоса на всю ширину основной области) */
  HeaderStrip?: ComponentType
  /** Выдвижная панель раздела (полоса между шапкой и рабочей областью) */
  Drawer?: ComponentType
}

const LOADERS: Record<SectionId, () => Promise<SectionModule>> = {
  home: async () => ({ Component: (await import('./HomeSection')).HomeSection }),
  db: async () => {
    const [section, panel, actions] = await Promise.all([
      import('./db/DbSection'),
      import('./db/DbPanel'),
      import('./db/DbToolActions'),
    ])
    return { Component: section.DbSection, Panel: panel.DbPanel, ToolActions: actions.DbToolActions }
  },
  edf: async () => {
    const [section, panel, actions, zoom] = await Promise.all([
      import('./EdfSection'),
      import('./EdfPanel'),
      import('./EdfToolActions'),
      import('./EdfZoomSelect'),
    ])
    return {
      Component: section.EdfSection,
      Panel: panel.EdfPanel,
      ToolActions: actions.EdfToolHeaderActions,
      HeaderExtra: zoom.EdfZoomSelect,
    }
  },
  eeg: async () => {
    const [section, panel, actions, controls] = await Promise.all([
      import('./eeg/EegSection'),
      import('./eeg/EegPanel'),
      import('./eeg/EegToolActions'),
      import('./eeg/EegWindowControls'),
    ])
    return {
      Component: section.EegSection,
      Panel: panel.EegPanel,
      ToolActions: actions.EegToolHeaderActions,
      HeaderExtra: controls.EegWindowControls,
    }
  },
  dipoles: async () => {
    const [section, panel, actions, strip, drawer] = await Promise.all([
      import('./dipoles/DipolesSection'),
      import('./dipoles/DipolesPanel'),
      import('./dipoles/DipolesToolActions'),
      import('./dipoles/EpochDipoleStrip'),
      import('./dipoles/DipolesDrawer'),
    ])
    return {
      Component: section.DipolesSection,
      Panel: panel.DipolesPanel,
      ToolActions: actions.DipolesToolHeaderActions,
      HeaderStrip: strip.EpochDipoleStrip,
      Drawer: drawer.DipolesDrawer,
    }
  },
  table: async () => {
    const [section, panel] = await Promise.all([
      import('./table/LocalizationTableSection'),
      import('./table/LocalizationTablePanel'),
    ])
    return { Component: section.LocalizationTableSection, Panel: panel.LocalizationTablePanel }
  },
  group: async () => {
    const [section, panel, actions] = await Promise.all([
      import('./group/GroupSection'),
      import('./group/GroupPanel'),
      import('./group/GroupToolActions'),
    ])
    return {
      Component: section.GroupSection,
      Panel: panel.GroupPanel,
      ToolActions: actions.GroupToolActions,
    }
  },
  summary: async () => {
    const [section, panel, actions] = await Promise.all([
      import('./summary/SummarySection'),
      import('./summary/SummaryPanel'),
      import('./summary/SummaryToolActions'),
    ])
    return {
      Component: section.SummarySection,
      Panel: panel.SummaryPanel,
      ToolActions: actions.SummaryToolActions,
    }
  },
  emolab: async () => {
    const [section, panel, actions] = await Promise.all([
      import('./emolab/EmoLabSection'),
      import('./emolab/EmoLabPanel'),
      import('./emolab/EmoLabToolActions'),
    ])
    return {
      Component: section.EmoLabSection,
      Panel: panel.EmoLabPanel,
      TitleAfter: actions.EmoLabTitleFile,
      ToolActions: actions.EmoLabToolActions,
    }
  },
  consilium: async () => {
    const [section, panel] = await Promise.all([
      import('./consilium/ConsiliumSection'),
      import('./consilium/ConsiliumPanel'),
    ])
    return { Component: section.ConsiliumSection, Panel: panel.ConsiliumPanel }
  },
  neuroaudio: async () => {
    const stubs = await import('./Stubs')
    return { Component: stubs.NeuroAudioSection, Panel: stubs.NeuroAudioPanel }
  },
  neuromusic: async () => {
    const [section, panel, actions] = await Promise.all([
      import('./neuromusic/NeuromusicSection'),
      import('./neuromusic/NeuromusicPanel'),
      import('./neuromusic/NeuromusicToolActions'),
    ])
    return {
      Component: section.NeuromusicSection,
      Panel: panel.NeuromusicPanel,
      TitleBefore: actions.NeuromusicTitleIcon,
      TitleAfter: actions.NeuromusicTitleFile,
      ToolActions: actions.NeuromusicToolActions,
    }
  },
  wiki: async () => ({ Component: (await import('./wiki/WikiSection')).WikiSection }),
  settings: async () => ({ Component: (await import('./SettingsSection')).SettingsSection }),
  server: async () => ({
    Component: (await import('./ServerStatusSection')).ServerStatusSection,
  }),
}

/** Загруженные модули разделов: повторный переход не ждёт Suspense. */
const loaded = new Map<SectionId, SectionModule>()
/** Незавершённые загрузки: параллельные переходы не дублируют `import()`. */
const pending = new Map<SectionId, Promise<SectionModule>>()

export function loadSection(id: SectionId): Promise<SectionModule> {
  const done = loaded.get(id)
  if (done) return Promise.resolve(done)
  const running = pending.get(id)
  if (running) return running
  const promise = LOADERS[id]()
    .then((module) => {
      loaded.set(id, module)
      pending.delete(id)
      return module
    })
    .catch((error: unknown) => {
      pending.delete(id)
      throw error
    })
  pending.set(id, promise)
  return promise
}

/** Уже загруженный модуль (без Suspense) либо `undefined`. */
export function loadedSection(id: SectionId): SectionModule | undefined {
  return loaded.get(id)
}

/**
 * Прогревает кэш модулей разделов. Нужен тестам: `renderWithProviders`
 * синхронный, и Suspense-фолбэк иначе ломает `getBy*` в существующих сценариях.
 */
export async function preloadSections(): Promise<void> {
  await Promise.all(Object.keys(LOADERS).map((id) => loadSection(id as SectionId)))
}
