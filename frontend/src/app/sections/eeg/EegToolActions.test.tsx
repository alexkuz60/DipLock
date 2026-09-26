/**
 * Тесты кнопки отмены спектрограммы (3.2): пока задача идёт, рядом с прогрессом
 * есть «Отменить»; клик шлёт `DELETE /jobs/{id}` (`api.jobCancel`) и переводит
 * задачу в `cancelled` — полоса прогресса скрывается.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api/client'
import { useEegParams } from '@/shared/state/eegParams'
import { spectrogramJobFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { EegCalcProgress } from './EegToolActions'

describe('отмена спектрограммы из UI (3.2)', () => {
  beforeEach(() => {
    localStorage.clear()
    useEegParams.setState({
      job: {
        status: 'running',
        progress: 0.4,
        message: 'STFT по окнам',
        stage: 'spectrum',
        epochsDone: 4,
        epochsTotal: 10,
        error: null,
        jobId: 'job-77',
      },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('пока задача идёт, рядом с прогрессом есть кнопка «Отменить»', () => {
    renderWithProviders(<EegCalcProgress />)

    expect(
      screen.getByRole('progressbar', { name: 'Прогресс расчёта спектрограммы' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Отменить/ })).toBeInTheDocument()
  })

  it('клик «Отменить» шлёт DELETE и прячет прогресс', async () => {
    const user = userEvent.setup()
    const cancelSpy = vi
      .spyOn(api, 'jobCancel')
      .mockResolvedValue({ ...spectrogramJobFixture, status: 'cancelled' })
    renderWithProviders(<EegCalcProgress />)

    await user.click(screen.getByRole('button', { name: /Отменить/ }))

    expect(cancelSpy).toHaveBeenCalledWith('job-77')
    expect(useEegParams.getState().job?.status).toBe('cancelled')
    // Прогресс скрыт: компонент рендерится только пока задача running
    expect(
      screen.queryByRole('progressbar', { name: 'Прогресс расчёта спектрограммы' }),
    ).toBeNull()
  })
})