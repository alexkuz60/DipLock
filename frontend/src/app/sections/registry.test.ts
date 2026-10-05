/** Тесты реестра разделов: состав навигации, хоткеи, уникальность маршрутов. */
import { describe, expect, it } from 'vitest'
import { MAIN_SECTIONS, SECTIONS, UTILITY_SECTIONS, getSection } from './registry'

describe('реестр разделов', () => {
  it('содержит 10 рабочих и 3 служебных раздела', () => {
    expect(SECTIONS).toHaveLength(13)
    expect(MAIN_SECTIONS).toHaveLength(10)
    expect(UTILITY_SECTIONS).toHaveLength(3)
    expect(UTILITY_SECTIONS.map((section) => section.id)).toEqual(['wiki', 'settings', 'server'])
    expect(MAIN_SECTIONS.map((section) => section.id)).toEqual([
      'home', 'edf', 'eeg', 'dipoles', 'table', 'group', 'summary', 'emolab', 'neuroaudio',
      'neuromusic',
    ])
  })

  it('идентификаторы и маршруты уникальны', () => {
    expect(new Set(SECTIONS.map((section) => section.id)).size).toBe(SECTIONS.length)
    expect(new Set(SECTIONS.map((section) => section.route)).size).toBe(SECTIONS.length)
  })

  it('у рабочих разделов хоткеи 1…9 и 0, у служебных — нет', () => {
    expect(MAIN_SECTIONS.map((section) => section.hotkey)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
    ])
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
