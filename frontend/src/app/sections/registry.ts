/**
 * Реестр разделов приложения — единственное место, где описан состав навигации.
 *
 * Новый раздел = одна запись здесь + компонент рабочей области в
 * `src/app/sections/`. Каркас (`AppShell`) сам построит рейл, тулс-хедер,
 * правый сайдбар и хоткей; маршруты берутся из `SECTION_ROUTES`.
 */
import {
  Activity,
  House,
  Layers,
  Radar,
  ServerCog,
  Settings,
  Table2,
  Waves,
  type LucideIcon,
} from 'lucide-react'

export type SectionId = 'home' | 'edf' | 'eeg' | 'dipoles' | 'table' | 'group' | 'settings' | 'server'

export type SectionConfig = {
  id: SectionId
  /** Заголовок в тулс-хедере */
  title: string
  /** Короткая подпись (рейл, статусбар) */
  shortTitle: string
  /** Подсказка при наведении на иконку рейла */
  hint: string
  /** Горячая клавиша перехода ('' — нет) */
  hotkey: string
  icon: LucideIcon
  route: string
  /** Есть ли у раздела собственный тулс-хедер */
  hasToolHeader: boolean
  /** Нужна ли разворачиваемая панель справа */
  hasRightPanel: boolean
  group: 'main' | 'utility'
}

export const SECTIONS: SectionConfig[] = [
  {
    id: 'home',
    title: 'Главная',
    shortTitle: 'Главная',
    hint: 'Главная',
    hotkey: '1',
    icon: House,
    route: '/',
    hasToolHeader: false,
    hasRightPanel: false,
    group: 'main',
  },
  {
    id: 'edf',
    title: 'EDF — просмотр записи',
    shortTitle: 'EDF',
    hint: 'EDF: запись, эпохи, артефакты',
    hotkey: '2',
    icon: Waves,
    route: '/edf',
    hasToolHeader: true,
    hasRightPanel: true,
    group: 'main',
  },
  {
    id: 'eeg',
    title: 'ЭЭГ: трек и спектрограмма',
    shortTitle: 'ЭЭГ',
    hint: 'ЭЭГ: один канал, трек и спектрограмма STFT',
    hotkey: '3',
    icon: Activity,
    route: '/eeg',
    hasToolHeader: true,
    hasRightPanel: true,
    group: 'main',
  },
  {
    id: 'dipoles',
    title: 'Расчёт диполей и локализация',
    shortTitle: 'Диполи',
    hint: 'Диполи: фильтры, 3 проекции, анимация',
    hotkey: '4',
    icon: Radar,
    route: '/dipoles',
    hasToolHeader: true,
    hasRightPanel: true,
    group: 'main',
  },
  {
    id: 'table',
    title: 'Таблица локализации',
    shortTitle: 'Таблица',
    hint: 'Таблица результатов локализации',
    hotkey: '5',
    icon: Table2,
    route: '/table',
    hasToolHeader: true,
    hasRightPanel: true,
    group: 'main',
  },
  {
    id: 'group',
    title: 'Групповой анализ',
    shortTitle: 'Групповой',
    hint: 'Групповой анализ записей БД',
    hotkey: '6',
    icon: Layers,
    route: '/group',
    hasToolHeader: true,
    hasRightPanel: true,
    group: 'main',
  },
  {
    id: 'settings',
    title: 'Настройки приложения',
    shortTitle: 'Настройки',
    hint: 'Настройки',
    hotkey: '',
    icon: Settings,
    route: '/settings',
    hasToolHeader: true,
    hasRightPanel: false,
    group: 'utility',
  },
  {
    id: 'server',
    title: 'Состояние сервера',
    shortTitle: 'Сервер',
    hint: 'Состояние сервера: MNE, БД, fsaverage, BEM',
    hotkey: '',
    icon: ServerCog,
    route: '/server',
    hasToolHeader: true,
    hasRightPanel: false,
    group: 'utility',
  },
]

export const MAIN_SECTIONS: SectionConfig[] = SECTIONS.filter((s) => s.group === 'main')
export const UTILITY_SECTIONS: SectionConfig[] = SECTIONS.filter((s) => s.group === 'utility')

/** Маршруты разделов: источник — тот же реестр (реестр и роутер не разъезжаются). */
export const SECTION_ROUTES: { path: string; id: SectionId }[] = SECTIONS.map((section) => ({
  path: section.route,
  id: section.id,
}))

/** Конфиг раздела по id (бросает, если раздел не зарегистрирован). */
export function getSection(id: SectionId): SectionConfig {
  const section = SECTIONS.find((item) => item.id === id)
  if (!section) throw new Error(`Неизвестный раздел: ${id}`)
  return section
}
