/**
 * Тесты единого поллинга задач (A10) — то, что раньше было скопировано в трёх
 * сторах: опрос до `succeeded` с отдачей прогресса, пауза между опросами, текст
 * ошибки от сервера и отмена устаревшего запуска (токен).
 *
 * Правило раздела (`docs/rules/frontend-state.md`): устаревший запуск — не ошибка
 * пользователя, но и не право писать в состояние: он обязан бросить отмену и
 * прекратить опрос, а не «догнать» новый расчёт своим ответом.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api/client'
import {
  JOB_POLL_MS,
  JobCancelledError,
  JobFailedError,
  createRunToken,
  isCancelled,
  waitForJob,
} from '@/shared/lib/jobPolling'
import { preprocessJobFixture } from '@/test/fixtures'
import type { JobStatus } from '@/shared/api/types'

/** Статус задачи с подменой полей: поллингу важны только статус, прогресс и текст. */
function jobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return { ...preprocessJobFixture, ...overrides }
}

/** Пауза «без ожидания»: тесты не должны спать реальные `JOB_POLL_MS`. */
const NO_PAUSE = 1

describe('поллинг задачи', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('опрашивает до succeeded и отдаёт каждый опрос в onTick', async () => {
    const statuses = [
      jobStatus({ status: 'running', progress: 0.2, message: 'Фильтр' }),
      jobStatus({ status: 'running', progress: 0.7, message: 'Артефакты' }),
      jobStatus({ status: 'succeeded', progress: 1, stage: 'done', message: 'Готово' }),
    ]
    const jobSpy = vi
      .spyOn(api, 'job')
      .mockImplementation(async () => statuses.shift() ?? jobStatus())
    const ticks: string[] = []

    const final = await waitForJob(
      'job-1',
      () => true,
      (status) => ticks.push(status.message),
      NO_PAUSE,
    )

    expect(jobSpy).toHaveBeenCalledTimes(3)
    expect(ticks).toEqual(['Фильтр', 'Артефакты', 'Готово'])
    expect(final.status).toBe('succeeded')
  })

  it('пауза между опросами — JOB_POLL_MS: задачу не дёргают «в цикле»', async () => {
    vi.useFakeTimers()
    const jobSpy = vi.spyOn(api, 'job').mockResolvedValue(jobStatus({ status: 'running' }))
    const token = createRunToken()
    const attempt = token.next()

    const waiting = waitForJob(
      'job-1',
      () => token.isCurrent(attempt),
      () => {},
    )

    // Первый опрос уходит сразу, второй — только после паузы
    await vi.advanceTimersByTimeAsync(1)
    expect(jobSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS)
    expect(jobSpy).toHaveBeenCalledTimes(2)

    token.cancel()
    // Обработчик отмены ставим до прокрутки паузы: иначе отклонение «не поймано»
    const failure = waiting.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS)

    expect(await failure).toBeInstanceOf(JobCancelledError)
    // Отменённый поллинг закрывает цикл, а не продолжает спрашивать сервер
    expect(jobSpy).toHaveBeenCalledTimes(2)
  })

  it('ошибка задачи приходит текстом сервера и не выглядит отменой', async () => {
    vi.spyOn(api, 'job').mockResolvedValue(
      jobStatus({
        status: 'failed',
        error: 'Ни одной эпохи не удалось локализовать',
        error_traceback: 'Traceback (most recent call last): ... ValueError',
      }),
    )

    const failure = await waitForJob(
      'job-1',
      () => true,
      () => {},
      NO_PAUSE,
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(JobFailedError)
    expect((failure as Error).message).toBe('Ни одной эпохи не удалось локализовать')
    // N31: traceback с сервера доезжает до ошибки — UI показывает его разворотом
    expect((failure as JobFailedError).traceback).toContain('ValueError')
    expect(isCancelled(failure)).toBe(false)
  })

  it('без текста от сервера у ошибки задачи есть понятная подстановка', async () => {
    vi.spyOn(api, 'job').mockResolvedValue(jobStatus({ status: 'failed', error: null }))

    const failure = await waitForJob(
      'job-1',
      () => true,
      () => {},
      NO_PAUSE,
    ).catch((error: unknown) => error as Error)

    expect(failure.message).toBe('Задача завершилась ошибкой')
    expect((failure as JobFailedError).traceback).toBeNull()
  })

  it('устаревший запуск бросает отмену и не делает лишних запросов', async () => {
    const jobSpy = vi.spyOn(api, 'job').mockResolvedValue(jobStatus({ status: 'running' }))
    const token = createRunToken()
    const attempt = token.next()

    const waiting = waitForJob(
      'job-1',
      () => token.isCurrent(attempt),
      () => {},
      NO_PAUSE,
    )
    // Отмена (сброс раздела, закрытие записи) до первого ответа сервера
    token.cancel()

    const failure = await waiting.catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(JobCancelledError)
    expect(isCancelled(failure)).toBe(true)
    expect(jobSpy).toHaveBeenCalledTimes(1)
  })

  it('токен запуска: новая попытка и cancel делают прежний токен неактуальным', () => {
    const token = createRunToken()

    const first = token.next()
    expect(token.isCurrent(first)).toBe(true)

    const second = token.next()
    expect(token.isCurrent(first)).toBe(false)
    expect(token.isCurrent(second)).toBe(true)

    token.cancel()
    expect(token.isCurrent(second)).toBe(false)
  })
})
