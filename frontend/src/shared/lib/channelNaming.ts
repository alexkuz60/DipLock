/**
 * Схема подписей каналов: классическая система 10-20 и модифицированная
 * комбинаторная номенклатура (MCN, она же 10-10 / стандарт 1005).
 *
 * Канонические имена в приложении — современные (T7/T8, P7/P8): их приводит
 * `backend/app/services/edf_loader.py` (`_CHANNEL_ALIASES`) и с ними сверяет
 * монтаж. Переключатель «Имена» в блоке «Каналы» панели EDF меняет **только
 * подписи** — карту датчиков, треки и селекты каналов; запросы, расчёт, паспорт
 * и база данных продолжают работать с каноническими именами, поэтому смена
 * схемы не устаревает расчёт (параметр вне `STAGE_PARAM_KEYS`).
 *
 * Переименовано ровно четыре электрода — таблица ниже; остальные позиции
 * (Fp1/2, F3/4, C3/4, P3/4, O1/2, F7/8, Fz, Cz, Pz) обе схемы называют одинаково.
 */

/** Как подписывать отведения в UI: '10-10' — канонические, '10-20' — классические */
export type ChannelNaming = '10-10' | '10-20'

/** Варианты селекта «Имена» панели «Каналы»: два равнозначных варианта схемы */
export const CHANNEL_NAMING_OPTIONS: { value: ChannelNaming; label: string; title: string }[] = [
  {
    value: '10-10',
    label: '10-10',
    title: 'Современная номенклатура (MCN): T7/T8, P7/P8 — как в расчёте и паспорте записи',
  },
  {
    value: '10-20',
    label: '10-20',
    title: 'Классическая 10-20: те же четыре электрода под старыми именами T3/T4, T5/T6',
  },
]

/** 10-10 → классические 10-20: ровно четыре переименования MCN */
const CLASSIC_NAME: Record<string, string> = { T7: 'T3', T8: 'T4', P7: 'T5', P8: 'T6' }

/** классические 10-20 → 10-10: те же пары в обратную сторону */
const MODERN_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(CLASSIC_NAME).map(([modern, classic]) => [classic, modern]),
)

/**
 * Подпись канала по выбранной схеме: каноническое имя → то, что видит пользователь.
 *
 * Миксы («Микс: Лобные») и любые имена вне таблицы возвращаются как есть —
 * схема касается только четырёх переименованных электродов.
 */
export function channelDisplayName(name: string, naming: ChannelNaming): string {
  const table = naming === '10-20' ? CLASSIC_NAME : MODERN_NAME
  return table[name] ?? name
}

/** Список подписей (каналы микса, височные отведения ЧСС) по схеме имён */
export function channelDisplayNames(names: readonly string[], naming: ChannelNaming): string[] {
  return names.map((name) => channelDisplayName(name, naming))
}