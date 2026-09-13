/** Тесты реестра разделов: состав навигации, хоткеи, уникальность маршрутов. */
import { describe, expect, it } from 'vitest'
import { MAIN_SECTIONS, SECTIONS, UTILITY_SECTIONS, getSection } from './registry'

describe('реестр разделов', () => {
  it('содержит 5 рабочих и 2 служебных раздела', () => {
    expect(SECTIONS).toHaveLength(7)
    expect(MAIN_SECTIONS).toHaveLength(5)
    expect(UTILITY_SECTIONS).toHaveLength(2)
    expect(UTILITY_SECTIONS.map((section) => section.id)).toEqual(['settings', 'server'])
  })

  it('идентификаторы и маршруты уникальны', () => {
    expect(new Set(SECTIONS.map((section) => section.id)).size).toBe(SECTIONS.length)
    expect(new Set(SECTIONS.map((section) => section.route)).size).toBe(SECTIONS.length)
  })

  it('у рабочих разделов хоткеи 1…5, у служебных — нет', () => {
    expect(MAIN_SECTIONS.map((section) => section.hotkey)).toEqual(['1', '2', '3', '4', '5'])
    expect(UTILITY_SECTIONS.every((section) => section.hotkey === '')).toBe(true)
  })

  it('Главная — без тулс-хедера и панели, остальные рабочие — с панелью', () => {
    const home = getSection('home')
    expect(home.hasToolHeader).toBe(false)
    expect(home.hasRightPanel).toBe(false)

    for (const section of MAIN_SECTIONS.filter((item) => item.id !== 'home')) {
      expect(section.hasToolHeader).toBe(true)
      expect(section.hasRightPanel).toBe(true)
    }
  })

  it('у каждого раздела есть иконка, заголовок, подсказка и маршрут', () => {
    for (const section of SECTIONS) {
      expect(section.icon).toBeTruthy()
      expect(section.title.length).toBeGreaterThan(0)
      expect(section.shortTitle.length).toBeGreaterThan(0)
      expect(section.hint.length).toBeGreaterThan(0)
      expect(section.route.startsWith('/')).toBe(true)
    }
  })

  it('getSection бросает на неизвестном идентификаторе', () => {
    // @ts-expect-error — проверяем рантайм-защиту от опечаток
    expect(() => getSection('unknown')).toThrow(/Неизвестный раздел/)
  })
})
