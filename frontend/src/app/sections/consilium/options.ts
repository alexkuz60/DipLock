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
