/**
 * Клиентские замеры отрисовки: кольцевой буфер меток и счётчики событий.
 *
 * Серверный журнал шагов (`services/journal.py`, формат — `docs/data_map.md` §9)
 * делает измеримыми **расчёты**; про клиент он не знает ничего. Правило проекта
 * (`docs/rules/frontend-perf.md`): оптимизация рендера принимается по измерению,
 * а не по «кажется, стало быстрее». Здесь два инструмента:
 *
 * * `perfSpan(name, body)` — время синхронного блока (сборка растра, кадр панорамы);
 * * `perfCount(name)` — сколько раз случилось событие (пересобрался растр,
 *   пересчиталась огибающая, создался чарт). Счётчики показывают главное: что
 *   работа **не** делается там, где её делали раньше (движение курсора не
 *   пересобирает картинку).
 *
 * Модуль ничего не рисует и не логирует: он только копит числа. Сводка доступна
 * из консоли браузера как `__diplockPerf.stats()` — панели в UI намеренно нет
 * (замеры не должны влиять на вёрстку и на бюджет кадра). На сервер не уходит
 * ничего: это замер просмотра, а не результат расчёта.
 */

/** Метка монотонных часов: `performance.now()`, с запасным `Date.now()`. */
export function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** Один замер: имя блока и его длительность, мс. */
export type PerfEntry = { name: string; ms: number }

/** Сводка по имени: сколько раз, суммарно и максимум, мс. */
export type PerfStat = {
  name: string
  count: number
  totalMs: number
  maxMs: number
}

/**
 * Сколько последних замеров держим. Кольцо, а не журнал: сессия просмотра может
 * идти часами, и накопительный список замеров стал бы утечкой.
 */
export const PERF_RING_CAPACITY = 240

const ring: PerfEntry[] = []
const stats = new Map<string, { count: number; totalMs: number; maxMs: number }>()

function accumulate(name: string, ms: number, times = 1): void {
  const current = stats.get(name)
  if (current) {
    current.count += times
    current.totalMs += ms
    if (ms > current.maxMs) current.maxMs = ms
    return
  }
  stats.set(name, { count: times, totalMs: ms, maxMs: ms })
}

/**
 * Измеряет синхронный блок и возвращает его результат.
 *
 * Вызывается на горячих путях (сборка растра спектрограммы), поэтому внутри —
 * только две метки часов и запись в кольцо: на фоне самого блока это шум.
 */
export function perfSpan<T>(name: string, body: () => T): T {
  const started = perfNow()
  try {
    return body()
  } finally {
    const ms = perfNow() - started
    accumulate(name, ms)
    if (ring.length >= PERF_RING_CAPACITY) ring.shift()
    ring.push({ name, ms })
  }
}

/**
 * Считает событие без замера времени (`times` — пачкой).
 *
 * Время события измерять не нужно: у «пересобрался растр» и «пересчиталась
 * огибающая» смысл в **частоте**, а не в длительности, — а стоимость счётчика
 * должна быть нулевой, иначе он сам станет узким местом.
 */
export function perfCount(name: string, times = 1): void {
  accumulate(name, 0, times)
}

/** Последние замеры (старые вытесняются кольцом), в порядке появления. */
export function perfEntries(): readonly PerfEntry[] {
  return ring
}

/**
 * Сводка по именам: сначала те, где суммарное время больше, затем — по частоте.
 *
 * Порядок нужен, чтобы первая строка отчёта была ответом на вопрос «что же
 * съедает кадр», а не «что случилось раньше».
 */
export function perfStats(): PerfStat[] {
  return [...stats.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count || a.name.localeCompare(b.name))
}

/** Пустая сводка: между сценариями ручной проверки (тесты зовут это в `beforeEach`). */
export function perfReset(): void {
  ring.length = 0
  stats.clear()
}

/** Сводка для консоли браузера; в продакшене это маленький объект без работы. */
export type PerfApi = {
  stats: typeof perfStats
  entries: typeof perfEntries
  reset: typeof perfReset
  count: typeof perfCount
}

const globalScope = globalThis as unknown as { __diplockPerf?: PerfApi }
globalScope.__diplockPerf = {
  stats: perfStats,
  entries: perfEntries,
  reset: perfReset,
  count: perfCount,
}
