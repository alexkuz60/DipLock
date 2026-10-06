/** Тесты UI-настроек: переключение панелей, масштаб, персистентность. */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyUiPreferences, useUiStore } from './uiStore'

describe('uiStore', () => {
  beforeEach(() => {
    useUiStore.getState().resetUiState()
    localStorage.clear()
  })

  it('переключает правую панель раздела', () => {
    expect(useUiStore.getState().rightPanelOpen.edf).toBe(true)

    useUiStore.getState().toggleRightPanel('edf')
    expect(useUiStore.getState().rightPanelOpen.edf).toBe(false)

    useUiStore.getState().setRightPanel('edf', true)
    expect(useUiStore.getState().rightPanelOpen.edf).toBe(true)
  })

  it('по умолчанию открывает панели рабочих разделов и закрывает новые', () => {
    // neuromusic — с панелью опций (параметры рендера живут там, 06.10.2026)
    expect(useUiStore.getState().rightPanelOpen).toEqual({
      edf: true,
      eeg: true,
      dipoles: true,
      table: true,
      group: true,
      neuromusic: true,
    })
    expect(useUiStore.getState().rightPanelOpen.server).toBeUndefined()
  })

  it('считает активные задачи и не сохраняет их в localStorage', () => {
    useUiStore.getState().setActiveJobs(3)
    useUiStore.getState().setFontScale('large')

    const raw = localStorage.getItem('diplock.ui') ?? ''
    expect(raw).toContain('large')
    expect(raw).not.toContain('activeJobs')
    expect(useUiStore.getState().activeJobs).toBe(3)
  })

  it('сбрасывает раскладку разделов', () => {
    useUiStore.getState().setRightPanel('edf', false)
    useUiStore.getState().resetUiState()
    expect(useUiStore.getState().rightPanelOpen.edf).toBe(true)
  })

  it('сворачивает и разворачивает секции панели опций с сохранением в localStorage', () => {
    useUiStore.getState().setPanelCollapsed('edf:Пороги артефактов', true)
    expect(useUiStore.getState().collapsedPanels).toEqual({ 'edf:Пороги артефактов': true })
    expect(localStorage.getItem('diplock.ui') ?? '').toContain('collapsedPanels')

    useUiStore.getState().togglePanelCollapsed('edf:Пороги артефактов')
    expect(useUiStore.getState().collapsedPanels['edf:Пороги артефактов']).toBe(false)

    useUiStore.getState().resetUiState()
    expect(useUiStore.getState().collapsedPanels).toEqual({})
  })

  it('setPanelsCollapsed меняет несколько секций одним изменением', () => {
    useUiStore.getState().setPanelCollapsed('edf:Пороги артефактов', true)
    useUiStore.getState().setPanelsCollapsed(['edf:Фильтры и референс', 'edf:Эпохи'], true)
    expect(useUiStore.getState().collapsedPanels).toEqual({
      'edf:Пороги артефактов': true,
      'edf:Фильтры и референс': true,
      'edf:Эпохи': true,
    })

    // «Развернуть все» снимает свёрнутость и с секций, тронутых ранее поодиночке
    useUiStore.getState().setPanelsCollapsed(['edf:Пороги артефактов', 'edf:Эпохи'], false)
    expect(useUiStore.getState().collapsedPanels).toEqual({
      'edf:Пороги артефактов': false,
      'edf:Фильтры и референс': true,
      'edf:Эпохи': false,
    })

    // Пустой список — no-op (секции ещё не зарегистрированы)
    useUiStore.getState().setPanelsCollapsed([], false)
    expect(useUiStore.getState().collapsedPanels['edf:Фильтры и референс']).toBe(true)
  })

  it('applyUiPreferences пишет data-атрибуты на <html>', () => {
    applyUiPreferences('xlarge', 'compact')
    expect(document.documentElement.dataset.fontScale).toBe('xlarge')
    expect(document.documentElement.dataset.density).toBe('compact')
  })
})
