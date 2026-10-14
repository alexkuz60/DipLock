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

export const CONSILIUM_OPTIONS_DEFAULTS: ConsiliumOptions = {
  roles: ['psychological', 'neurophysiological', 'methodological'],
  roleFilter: ['psychological', 'neurophysiological', 'methodological'],
  openAnswerSections: false,
}

export type ConsiliumOptionsState = {
  options: ConsiliumOptions
  /** Выбор ролей целиком (подсказка Jev «Применить к выбору ролей») */
  setRoles: (roles: string[]) => void
  toggleRole: (role: string) => void
  setRoleFilter: (roles: string[]) => void
  toggleRoleFilter: (role: string) => void
  setOpenAnswerSections: (open: boolean) => void
  /** Вернуть разовые настройки к значениям по умолчанию */
  reset: () => void
}

export const useConsiliumOptions = create<ConsiliumOptionsState>()(
  persist(
    (set) => ({
      options: { ...CONSILIUM_OPTIONS_DEFAULTS },

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

      reset: () => set({ options: { ...CONSILIUM_OPTIONS_DEFAULTS } }),
    }),
    {
      name: 'diplock.consilium',
      partialize: (state) => ({ options: state.options }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as { options?: Partial<ConsiliumOptions> }
        const storedOptions = stored.options ?? {}
        return {
          ...current,
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