/**
 * Панель «Опции» Консилиума (срез 0014): разовые настройки в правом сайдбаре.
 *
 * Главная проверка — «правило кнопки» (`docs/rules/frontend-state.md`): правка
 * опции меняет срез настроек и **не** отправляет ни одного запроса.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsiliumOptionsPanel } from './ConsiliumOptionsPanel'
import { useConsiliumOptions } from '@/shared/state/consiliumOptions'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('ConsiliumOptionsPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    useConsiliumOptions.getState().reset()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('показывает роли, фильтр и отображение в секциях панели', () => {
    renderWithProviders(<ConsiliumOptionsPanel />)

    expect(screen.getByText('Советники')).toBeInTheDocument()
    expect(screen.getByText('Отображение')).toBeInTheDocument()
    expect(screen.getByText('О разделе')).toBeInTheDocument()
    expect(screen.getByText('Роли для запуска раунда')).toBeInTheDocument()
    expect(screen.getByText('Показывать в обсуждении')).toBeInTheDocument()
  })

  it('правка опции меняет настройки и не запускает запросов', () => {
    renderWithProviders(<ConsiliumOptionsPanel />)

    // Два чекбокса одной роли: «Роли для запуска» и «Показывать»
    const roleBoxes = screen.getAllByRole('checkbox', { name: 'Методологический советник' })
    expect(roleBoxes).toHaveLength(2)
    fireEvent.click(roleBoxes[0])

    expect(useConsiliumOptions.getState().options.roles).toEqual([
      'psychological',
      'neurophysiological',
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('опция раскрытий ответов переключается без запросов', () => {
    renderWithProviders(<ConsiliumOptionsPanel />)

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Раскрывать разделы ответов сразу' }),
    )

    expect(useConsiliumOptions.getState().options.openAnswerSections).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
})