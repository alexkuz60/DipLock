/**
 * Тесты кнопки отмены спектрограммы (3.2): пока задача идёт, рядом с прогрессом
 * есть «Отменить»; клик шлёт `DELETE /jobs/{id}` (`api.jobCancel`) и переводит
 * задачу в `cancelled` — полоса прогресса скрывается.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api/client'
import { EEG_PARAM_DEFAULTS, useEegParams } from '@/shared/state/eegParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { recordingFixture, spectrogramJobFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { EegCalcProgress, EegToolHeaderActions } from './EegToolActions'

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

describe('тулс-хедер ЭЭГ: два селектора канала и кнопка-иконка расчёта (30.09.2026)', () => {
  beforeEach(() => {
    localStorage.clear()
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, filter: { ...EEG_PARAM_DEFAULTS.filter } },
      job: null,
      result: null,
      grid: null,
      error: null,
      gridError: null,
    })
    useEdfRecording.setState({ recording: recordingFixture, demo: null })
  })
  afterEach(() => vi.restoreAllMocks())

  it('миксы вынесены в отдельное комбо и не числятся среди электродов', () => {
    renderWithProviders(<EegToolHeaderActions />)

    const electrodes = screen.getByLabelText('Канал спектрограммы') as HTMLSelectElement
    const electrodeValues = Array.from(electrodes.options).map((option) => option.value)
    expect(electrodeValues).toContain('C3')
    // Пункты миксов в списке электродов не живут — только в своём комбо
    expect(electrodeValues.some((value) => value.startsWith('mix:'))).toBe(false)
    expect(electrodes.value).toBe('Fp1')

    const mixes = screen.getByLabelText('Виртуальный канал (микс)') as HTMLSelectElement
    const mixValues = Array.from(mixes.options).map((option) => option.value)
    expect(mixValues).toContain('mix:frontal')
    // Микс не выбран: в неактивном селекторе стоит «—»
    expect(mixes.value).toBe('')
  })

  it('выбор микса переключает канал, выбор электрода — возвращает обратно', async () => {
    const user = userEvent.setup()
    renderWithProviders(<EegToolHeaderActions />)

    await user.selectOptions(screen.getByLabelText('Виртуальный канал (микс)'), 'mix:frontal')
    expect(useEegParams.getState().params.channel).toBe('mix:frontal')
    // Активен микс: селектор электродов показывает «—», а не чужое значение
    expect((screen.getByLabelText('Канал спектрограммы') as HTMLSelectElement).value).toBe('')

    await user.selectOptions(screen.getByLabelText('Канал спектрограммы'), 'C3')
    expect(useEegParams.getState().params.channel).toBe('C3')
  })

  it('расчёт — кнопка-иконка: имя остаётся текстом для a11y, без записи выключена', () => {
    useEdfRecording.setState({ recording: null })
    renderWithProviders(<EegToolHeaderActions />)

    const button = screen.getByRole('button', { name: 'Рассчитать спектрограмму' })
    expect(button).toBeDisabled()
    // Тултип-объяснение на месте (раньше было title у текстовой кнопки)
    expect(button.title).toContain('загрузите EDF')
    // Селекторов канала без записи нет
    expect(screen.queryByLabelText('Канал спектрограммы')).toBeNull()
    expect(screen.queryByLabelText('Виртуальный канал (микс)')).toBeNull()
  })
})