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

/** Глубина обсуждения в подсказке Jev (§5.3): от первых ответов до итога. */
export const roundDepths = [
  { value: 'initial_only', label: 'только первые ответы' },
  { value: 'with_remarks', label: 'ответы и замечания коллег' },
  { value: 'with_summary', label: 'ответы, замечания и итог' },
] as const

/** Виды шага предложения (§7): четыре вида и «предложения нет». */
export const proposalStepKinds = [
  { value: 'ask_volunteer', label: 'спросить добровольца' },
  { value: 'clarify_observation', label: 'уточнить условия или наблюдение' },
  { value: 'run_probe', label: 'провести пробу' },
  { value: 'run_calculation', label: 'выполнить расчёт' },
  { value: 'no_proposal', label: 'конкретного предложения нет' },
] as const

/** Поля карточки предложения (§7): основание, риски, способ проверки. */
export const proposalFields = [
  { value: 'has_proposal', label: 'предложение шага' },
  { value: 'has_basis', label: 'основание' },
  { value: 'has_risks', label: 'риски и ограничения' },
  { value: 'has_verification', label: 'способ проверки' },
] as const

/** Три источника утверждений (стратегия §2): не смешиваются, только подсказка. */
export const claimSources = [
  { value: 'uses_measurements', label: 'измерения и расчёты' },
  { value: 'uses_volunteer_report', label: 'рассказ добровольца' },
  { value: 'uses_observations', label: 'наблюдения исследователя' },
] as const

export const roundStatuses = [
  { value: 'running', label: 'Выполняется', tone: 'accent' },
  { value: 'done', label: 'Готов', tone: 'ok' },
  { value: 'partial', label: 'Неполный', tone: 'warn' },
  { value: 'failed', label: 'Ошибка', tone: 'danger' },
  { value: 'cancelled', label: 'Отменён', tone: 'neutral' },
  { value: 'interrupted', label: 'Прерван', tone: 'warn' },
] as const
