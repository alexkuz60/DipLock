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
    expect(useUiStore.getState().rightPanelOpen).toEqual({
      edf: true,
      eeg: true,
      dipoles: true,
      table: true,
      group: true,
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

  it('applyUiPreferences пишет data-атрибуты на <html>', () => {
    applyUiPreferences('xlarge', 'compact')
    expect(document.documentElement.dataset.fontScale).toBe('xlarge')
    expect(document.documentElement.dataset.density).toBe('compact')
  })
})
