/**
 * Тесты панели опций раздела «ЭЭГ» (срез 5, N18).
 *
 * Панель только правит параметры: ни один контрол не делает запросов и не
 * запускает расчёт. Здесь проверяются новые параметры просмотра этапа 2.4:
 * шкала частот (линейная/логарифмическая), режим значений (дБ/ERD/ERS %),
 * baseline-интервал и окно палитры %.
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { EEG_PARAM_DEFAULTS, normalizeEegParams, useEegParams } from '@/shared/state/eegParams'
import { EegPanel } from './EegPanel'

describe('панель раздела «ЭЭГ» (2.4)', () => {
  beforeEach(() => {
    localStorage.clear()
    useEegParams.setState({ params: normalizeEegParams({ ...EEG_PARAM_DEFAULTS }) })
  })

  it('шкала частот и режим значений правятся без запросов и без пересчёта (N18)', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<EegPanel />)

    await user.click(screen.getByRole('button', { name: 'Логарифмическая' }))
    expect(useEegParams.getState().params.freqScale).toBe('log')

    await user.click(screen.getByRole('button', { name: 'ERD/ERS %' }))
    expect(useEegParams.getState().params.valueMode).toBe('erd')

    // Ни одного запроса, кроме разрешённых статических метаданных (/meta):
    // параметры просмотра не трогают ни задачу, ни кэши
    const urls = fetchSpy.mock.calls.map(([input]) => String(input))
    expect(urls.filter((url) => !url.includes('/meta'))).toEqual([])
  })

  it('в режиме ERD/ERS показывает baseline и окно %, в режиме дБ — окно дБ', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<EegPanel />)

    // Режим дБ: окно палитры в дБ, baseline не показывается
    expect(screen.getByLabelText('Окно дБ: низ')).toBeInTheDocument()
    expect(screen.queryByLabelText('Baseline от')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'ERD/ERS %' }))

    expect(await screen.findByLabelText('Baseline от')).toBeInTheDocument()
    expect(screen.getByLabelText('Baseline до')).toBeInTheDocument()
    expect(screen.getByLabelText('Окно палитры от')).toBeInTheDocument()
    expect(screen.queryByLabelText('Окно дБ: низ')).toBeNull()

    await user.type(screen.getByLabelText('Baseline до'), '2')
    await waitFor(() =>
      expect(useEegParams.getState().params.baselineSec[1]).toBeGreaterThan(0),
    )
  })
})