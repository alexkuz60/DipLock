/**
 * Разовые настройки Консилиума (срез 0014): панель «Опции» правого сайдбара.
 *
 * Живут в zustand-срезе, потому что правятся в панели опций, а читаются в
 * рабочей области (обсуждение, карточки раундов). Правка любой опции, как и в
 * остальных разделах (`docs/rules/frontend-state.md`), **ничего не запускает**:
 * запуск раундов и запросы к внешним моделям — только кнопками рабочей области.
 *
 * Персист — только настройки (ключ `diplock.consilium`): роли/фильтр/раскрытия
 * переживают перезаход, серверные данные (дела, раунды) живут в react-query.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ConsiliumOptions = {
  /** Роли для запуска следующего раунда (кнопка «Ответы советников») */
  roles: string[]
  /** Фильтр советников в карточках раундов (пусто — никого не показывать) */
  roleFilter: string[]
  /** Раскрывать разделы ответов и «На чём основано?» сразу */
  openAnswerSections: boolean
}

/** Вкладка выдвижного левого сайдбара рабочей области (срез 0015). */
export type ConsiliumSidebarTab = 'chat' | 'tree'

export type ConsiliumSidebar = {
  /** Левый сайдбар рабочей области развёрнут */
  open: boolean
  /** Ширина сайдбара, px (clamp 240–640) */
  width: number
  /** Активная вкладка: чат с одним советником или дерево навигации по раундам */
  tab: ConsiliumSidebarTab
  /** Советник боковой консультации (вкладка «Чат») */
  chatRole: string
}

export const SIDEBAR_WIDTH_MIN = 240
export const SIDEBAR_WIDTH_MAX = 640

export const CONSILIUM_SIDEBAR_DEFAULTS: ConsiliumSidebar = {
  open: true,
  width: 320,
  tab: 'chat',
  chatRole: 'psychological',
}

/** Ширина сайдбара в допустимых границах (px, целое). */
export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
}

export const CONSILIUM_OPTIONS_DEFAULTS: ConsiliumOptions = {
  roles: ['psychological', 'neurophysiological', 'methodological'],
  roleFilter: ['psychological', 'neurophysiological', 'methodological'],
  openAnswerSections: false,
}

export type ConsiliumOptionsState = {
  options: ConsiliumOptions
  /** Выдвижной левый сайдбар рабочей области (ширина, вкладка, советник чата) */
  sidebar: ConsiliumSidebar
  /** Выбор ролей целиком (подсказка Jev «Применить к выбору ролей») */
  setRoles: (roles: string[]) => void
  toggleRole: (role: string) => void
  setRoleFilter: (roles: string[]) => void
  toggleRoleFilter: (role: string) => void
  setOpenAnswerSections: (open: boolean) => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  setSidebarTab: (tab: ConsiliumSidebarTab) => void
  setChatRole: (role: string) => void
  /** Вернуть разовые настройки к значениям по умолчанию */
  reset: () => void
}

export const useConsiliumOptions = create<ConsiliumOptionsState>()(
  persist(
    (set) => ({
      options: { ...CONSILIUM_OPTIONS_DEFAULTS },
      sidebar: { ...CONSILIUM_SIDEBAR_DEFAULTS },

      setRoles: (roles) => set((state) => ({ options: { ...state.options, roles } })),

      toggleRole: (role) =>
        set((state) => ({
          options: {
            ...state.options,
            roles: state.options.roles.includes(role)
              ? state.options.roles.filter((item) => item !== role)
              : [...state.options.roles, role],
          },
        })),

      setRoleFilter: (roles) =>
        set((state) => ({ options: { ...state.options, roleFilter: roles } })),

      toggleRoleFilter: (role) =>
        set((state) => ({
          options: {
            ...state.options,
            roleFilter: state.options.roleFilter.includes(role)
              ? state.options.roleFilter.filter((item) => item !== role)
              : [...state.options.roleFilter, role],
          },
        })),

      setOpenAnswerSections: (open) =>
        set((state) => ({ options: { ...state.options, openAnswerSections: open } })),

      setSidebarOpen: (open) =>
        set((state) => ({ sidebar: { ...state.sidebar, open } })),

      setSidebarWidth: (width) =>
        set((state) => ({ sidebar: { ...state.sidebar, width: clampSidebarWidth(width) } })),

      setSidebarTab: (tab) => set((state) => ({ sidebar: { ...state.sidebar, tab } })),

      setChatRole: (role) => set((state) => ({ sidebar: { ...state.sidebar, chatRole: role } })),

      reset: () =>
        set({
          options: { ...CONSILIUM_OPTIONS_DEFAULTS },
          sidebar: { ...CONSILIUM_SIDEBAR_DEFAULTS },
        }),
    }),
    {
      name: 'diplock.consilium',
      partialize: (state) => ({ options: state.options, sidebar: state.sidebar }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as {
          options?: Partial<ConsiliumOptions>
          sidebar?: Partial<ConsiliumSidebar>
        }
        const storedOptions = stored.options ?? {}
        const storedSidebar = stored.sidebar ?? {}
        return {
          ...current,
          sidebar: {
            ...current.sidebar,
            ...storedSidebar,
            // Ширина из localStorage всегда в границах, вкладка — только известная
            width: clampSidebarWidth(storedSidebar.width ?? current.sidebar.width),
            tab:
              storedSidebar.tab === 'chat' || storedSidebar.tab === 'tree'
                ? storedSidebar.tab
                : current.sidebar.tab,
            chatRole:
              typeof storedSidebar.chatRole === 'string' && storedSidebar.chatRole
                ? storedSidebar.chatRole
                : current.sidebar.chatRole,
          },
          options: {
            ...current.options,
            ...storedOptions,
            // Списки из localStorage сохраняются как есть (включая пустой выбор —
            // это явное решение пользователя), а не вытесняются дефолтом.
            roles: Array.isArray(storedOptions.roles)
              ? storedOptions.roles
              : current.options.roles,
            roleFilter: Array.isArray(storedOptions.roleFilter)
              ? storedOptions.roleFilter
              : current.options.roleFilter,
          },
        }
      },
    },
  ),
)