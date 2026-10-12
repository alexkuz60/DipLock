/** Русские подписи исследовательских направлений и источников контекста. */
export const directions = [
  { value: 'music', label: 'Реакция на музыку' },
  { value: 'meditation', label: 'Медитация' },
  { value: 'creativity', label: 'Творческая проба' },
  { value: 'emotional', label: 'Психоэмоциональное состояние' },
  { value: 'other', label: 'Другой вопрос' },
] as const

export const contextKinds = [
  { value: 'volunteer_report', label: 'Рассказ добровольца' },
  { value: 'observation', label: 'Наблюдение исследователя' },
  { value: 'conditions', label: 'Условия сессии' },
  { value: 'answer', label: 'Ответ на вопрос' },
] as const

/** Консилиум Т3: роли советников, виды и статусы раундов. */
export const advisorRoles = [
  { value: 'psychological', label: 'Психологический советник' },
  { value: 'neurophysiological', label: 'Нейрофизиологический советник' },
  { value: 'methodological', label: 'Методологический советник' },
  { value: 'summary', label: 'Итог консилиума' },
] as const

export const roundKinds = [
  { value: 'initial', label: 'Раунд ответов' },
  { value: 'remarks', label: 'Замечания коллег' },
  { value: 'summary', label: 'Итог консилиума' },
] as const

export const roundStatuses = [
  { value: 'running', label: 'Выполняется', tone: 'accent' },
  { value: 'done', label: 'Готов', tone: 'ok' },
  { value: 'partial', label: 'Неполный', tone: 'warn' },
  { value: 'failed', label: 'Ошибка', tone: 'danger' },
  { value: 'cancelled', label: 'Отменён', tone: 'neutral' },
  { value: 'interrupted', label: 'Прерван', tone: 'warn' },
] as const
