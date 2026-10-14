/**
 * Разовые настройки Консилиума (срез 0014): роли раунда, фильтр советников
 * и раскрытия ответов. Правка опций — только состояние просмотра: ничего не
 * запускает и не хранит серверные данные (дела/раунды живут в react-query).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CONSILIUM_OPTIONS_DEFAULTS,
  useConsiliumOptions,
} from '@/shared/state/consiliumOptions'

describe('настройки Консилиума', () => {
  beforeEach(() => {
    localStorage.clear()
    useConsiliumOptions.getState().reset()
  })

  it('по умолчанию включены все советники, раскрытия свёрнуты', () => {
    const { options } = useConsiliumOptions.getState()

    expect(options.roles).toEqual(['psychological', 'neurophysiological', 'methodological'])
    expect(options.roleFilter).toEqual(['psychological', 'neurophysiological', 'methodological'])
    expect(options.openAnswerSections).toBe(false)
  })

  it('переключает роль раунда и фильтр независимо', () => {
    const store = useConsiliumOptions.getState()

    store.toggleRole('methodological')
    expect(useConsiliumOptions.getState().options.roles).toEqual([
      'psychological',
      'neurophysiological',
    ])
    // Фильтр при правке ролей не трогается
    expect(useConsiliumOptions.getState().options.roleFilter).toHaveLength(3)

    store.toggleRoleFilter('psychological')
    expect(useConsiliumOptions.getState().options.roleFilter).toEqual([
      'neurophysiological',
      'methodological',
    ])
  })

  it('подсказка Jev заменяет выбор ролей целиком', () => {
    useConsiliumOptions.getState().setRoles(['neurophysiological'])

    expect(useConsiliumOptions.getState().options.roles).toEqual(['neurophysiological'])
  })

  it('включает раскрытие разделов ответов сразу', () => {
    useConsiliumOptions.getState().setOpenAnswerSections(true)
    expect(useConsiliumOptions.getState().options.openAnswerSections).toBe(true)
  })

  it('возвращает настройки к умолчанию', () => {
    useConsiliumOptions.getState().setRoles([])
    useConsiliumOptions.getState().setOpenAnswerSections(true)

    useConsiliumOptions.getState().reset()
    expect(useConsiliumOptions.getState().options).toEqual(CONSILIUM_OPTIONS_DEFAULTS)
  })

  it('сохраняет настройки в localStorage без серверных данных', () => {
    useConsiliumOptions.getState().setRoles(['psychological'])

    const raw = localStorage.getItem('diplock.consilium') ?? ''
    expect(raw).toContain('psychological')
    expect(raw).not.toContain('case_id')
  })
})