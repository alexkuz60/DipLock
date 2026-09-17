/**
 * UI-настройки приложения (zustand + localStorage).
 *
 * Здесь только состояние интерфейса: раскрытие правого сайдбара по разделам,
 * масштаб шрифта, плотность списков, счётчик активных задач. Серверные данные
 * живут в react-query, а не здесь.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type FontScale = 'normal' | 'large' | 'xlarge'
export type Density = 'compact' | 'normal'

type UiState = {
  /** Раскрыт ли правый сайдбар для каждого раздела */
  rightPanelOpen: Record<string, boolean>
  fontScale: FontScale
  density: Density
  /** Число активных (queued/running) задач — показывается бейджем в рейле */
  activeJobs: number
  toggleRightPanel: (sectionId: string) => void
  setRightPanel: (sectionId: string, open: boolean) => void
  setFontScale: (scale: FontScale) => void
  setDensity: (density: Density) => void
  setActiveJobs: (count: number) => void
  resetUiState: () => void
}

const DEFAULTS = {
  rightPanelOpen: { edf: true, eeg: true, dipoles: true, table: true, group: true } as Record<string, boolean>,
  fontScale: 'normal' as FontScale,
  density: 'normal' as Density,
  activeJobs: 0,
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      toggleRightPanel: (sectionId) =>
        set((state) => ({
          rightPanelOpen: {
            ...state.rightPanelOpen,
            [sectionId]: !(state.rightPanelOpen[sectionId] ?? false),
          },
        })),
      setRightPanel: (sectionId, open) =>
        set((state) => ({
          rightPanelOpen: { ...state.rightPanelOpen, [sectionId]: open },
        })),
      setFontScale: (fontScale) => set({ fontScale }),
      setDensity: (density) => set({ density }),
      setActiveJobs: (activeJobs) => set({ activeJobs }),
      resetUiState: () => set({ ...DEFAULTS }),
    }),
    {
      name: 'diplock.ui',
      // activeJobs — состояние сессии, в localStorage не нужно
      partialize: (state) => ({
        rightPanelOpen: state.rightPanelOpen,
        fontScale: state.fontScale,
        density: state.density,
      }),
    },
  ),
)

/** Применяет настройки к <html> (data-атрибуты, которые читает CSS). */
export function applyUiPreferences(fontScale: FontScale, density: Density): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.fontScale = fontScale
  document.documentElement.dataset.density = density
}
