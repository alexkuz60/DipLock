/**
 * Поллинг фоновых задач бэкенда: один цикл ожидания на весь UI (A10).
 *
 * Контракт у всех задач расчёта одинаковый (`docs/rules/api-jobs.md`): запуск
 * отдаёт `202 + job_id`, состояние читается `GET /api/v1/jobs/{id}` (этап,
 * прогресс 0..1, ошибка), а результат — отдельным GET у своей задачи по записи.
 * Различаются только адреса, и адреса живут в клиенте (`shared/api/client.ts`:
 * пары «создать/получить»). Здесь — **только ожидание**, одно на все разделы.
 *
 * Три правила, которые этот модуль держит в одном месте:
 *
 * 1. **Опрос до `succeeded`** с паузой `JOB_POLL_MS`: каждый опрос уходит в
 *    `onTick`, поэтому полоса прогресса раздела живёт без задержки.
 * 2. **Устаревший запуск не трогает состояние.** У раздела есть токен запуска
 *    (`createRunToken`): новый расчёт, сброс раздела или закрытие записи его
 *    сдвигают, и старый поллинг обязан **бросить** `JobCancelledError`
 *    (`isCancelled`), а не записать свой ответ поверх чужого состояния.
 * 3. **Ошибку объясняет сервер** (`JobFailedError`): UI показывает текст FastAPI,
 *    а не «задача завершилась ошибкой».
 *
 * Отмена серверной задачи (3.2) — `cancelRemoteJob`: тот же токен (поллинг
 * перестаёт ждать) плюс `DELETE /jobs/{id}` — сервер останавливает воркер на
 * ближайшем тике прогресса, а статус `cancelled` читается как «отменено».
 */
import { api } from '@/shared/api/client'
import type { JobStatus } from '@/shared/api/types'

/** Пауза между опросами: задачи идут секунды и десятки секунд — прогресс виден сразу. */
export const JOB_POLL_MS = 400

/** Запуск устарел (новый расчёт/сброс раздела/закрытие записи): ответ задачи больше не нужен. */
export class JobCancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'JobCancelledError'
  }
}

/** Задача завершилась ошибкой: текст от сервера показывается пользователю. */
export class JobFailedError extends Error {
  /** Хвост traceback с сервера (N31): текст говорит «что», traceback — «где». */
  readonly traceback: string | null

  constructor(message: string, traceback: string | null = null) {
    super(message)
    this.name = 'JobFailedError'
    this.traceback = traceback
  }
}

/** Отменён ли запуск: устаревший ответ — не ошибка пользователя, его просто не показывают. */
export function isCancelled(error: unknown): boolean {
  return error instanceof JobCancelledError
}

/**
 * Токен запуска раздела: номер попытки и проверка «моя ли она ещё».
 *
 * Хранить объект, а не число, нужно ровно затем, чтобы правил отмены не было в
 * сторах: `next()` начинает новую попытку, `cancel()` отменяет текущую, а
 * `isCurrent(token)` отвечает на вопрос «актуален ли ещё мой запуск».
 */
export type RunToken = {
  /** Начать новую попытку: возвращает токен для проверок `isCurrent`. */
  next: () => number
  /** Отменить текущую попытку: её ответы уже неактуальны. */
  cancel: () => void
  /** Актуальна ли ещё попытка с этим токеном. */
  isCurrent: (token: number) => boolean
}

/** Создать токен запуска раздела (нумерация попыток начинается с 1). */
export function createRunToken(): RunToken {
  let current = 0
  const bump = () => {
    current += 1
  }
  return {
    next: () => {
      bump()
      return current
    },
    cancel: bump,
    isCurrent: (token) => token === current,
  }
}

/** Пауза между опросами (параметр — чтобы тесты шли без реальных задержек). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Ждёт завершения задачи, отдавая каждый опрос в `onTick`, и возвращает
 * успешный статус — по нему вызывающий читает результат своим методом клиента.
 *
 * `isCurrent()` вызывается до запроса, после него и после паузы: как только
 * запуск устарел, ожидание бросает `JobCancelledError` и лишних запросов не
 * делает. Ошибка задачи приходит как `JobFailedError` с текстом сервера.
 */
export async function waitForJob(
  jobId: string,
  isCurrent: () => boolean,
  onTick: (status: JobStatus) => void,
  pollMs: number = JOB_POLL_MS,
): Promise<JobStatus> {
  for (;;) {
    if (!isCurrent()) throw new JobCancelledError()
    const status = await api.job(jobId)
    if (!isCurrent()) throw new JobCancelledError()
    onTick(status)
    if (status.status === 'succeeded') return status
    // Отменена (3.2): ни «ждём дальше», ни ошибка — ожидание прекращается
    if (status.status === 'cancelled') throw new JobCancelledError()
    if (status.status === 'failed') {
      throw new JobFailedError(status.error ?? 'Задача завершилась ошибкой', status.error_traceback)
    }
    await delay(pollMs)
  }
}

/**
 * Отмена серверной задачи (3.2): сдвигает токен (поллинг перестаёт ждать) и
 * шлёт `DELETE /jobs/{id}`.
 *
 * Сетевая ошибка намеренно глушится: задача могла успеть завершиться (409) или
 * уже быть отменённой — для пользователя это не различимо. Локальное состояние
 * раздела (статус `cancelled`, чтобы полоса прогресса скрылась) обновляет
 * вызывающий стор — здесь только сервер и токен.
 */
export function cancelRemoteJob(jobId: string, token: RunToken): void {
  token.cancel()
  void api.jobCancel(jobId).catch(() => undefined)
}
