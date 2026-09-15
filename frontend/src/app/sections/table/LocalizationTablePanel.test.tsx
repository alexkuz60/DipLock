/**
 * Тесты панели опций раздела «Таблица локализации» (срез 4).
 *
 * Панель — настройки **просмотра** уже полученного результата: порядок строк и
 * видимые колонки. Она ничего не запускает и ничего не запрашивает (проверяем
 * `fetch`), а справкой показывает, что за результат в ней читается.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultColumnVisibility } from '@/shared/lib/tableRows'
import { CALC_PARAM_DEFAULTS, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { TABLE_PARAM_DEFAULTS, useTableParams } from '@/shared/state/tableParams'
import { dipoleScanResultFixture, recordingFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { LocalizationTablePanel } from './LocalizationTablePanel'

describe('панель раздела «Таблица локализации»', () => {
  beforeEach(() => {
    localStorage.clear()
    useTableParams.setState({
      params: { ...TABLE_PARAM_DEFAULTS, columnVisibility: defaultColumnVisibility() },
    })
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS },
      result: null,
      error: null,
    })
    useEdfRecording.setState({ recording: null })
    vi.stubGlobal('fetch', mockApiFetch())
  })

  it('переключает порядок строк и ничего не запрашивает', async () => {
    const user = userEvent.setup()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    renderWithProviders(<LocalizationTablePanel />)

    expect(screen.getByText('Сейчас: по номеру эпохи (возрастание)')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Эпоха ↓' }))

    expect(useTableParams.getState().params.sortDirection).toBe('desc')
    expect(screen.getByText('Сейчас: по номеру эпохи (убывание)')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('скрывает колонку через состояние раздела', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LocalizationTablePanel />)

    const checkbox = screen.getByLabelText('MNI z, мм')
    expect(checkbox).toBeChecked()

    await user.click(checkbox)

    expect(useTableParams.getState().params.columnVisibility.z).toBe(false)
    expect(screen.getByText(/Скрыто колонок: 1/)).toBeInTheDocument()
    expect(screen.getByLabelText('Эпоха')).toBeChecked()
  })

  it('«Показать все» доступно только при скрытых колонках', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LocalizationTablePanel />)

    const button = screen.getByRole('button', { name: 'Показать все' })
    expect(button).toBeDisabled()

    await user.click(screen.getByLabelText('Поле Бродмана'))
    expect(screen.getByText(/Скрыто колонок: 1/)).toBeInTheDocument()
    expect(screen.getByLabelText('Поле Бродмана')).not.toBeChecked()

    await user.click(button)

    expect(useTableParams.getState().params.columnVisibility.area).toBe(true)
    expect(screen.getByLabelText('Поле Бродмана')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Показать все' })).toBeDisabled()
  })

  it('показывает справку по результату: запись, число строк и параметры расчёта', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<LocalizationTablePanel />)

    expect(screen.getByText(`Запись: ${recordingFixture.filename}`)).toBeInTheDocument()
    expect(screen.getByText('Строк: 4')).toBeInTheDocument()
    expect(screen.getByText('Метод: fast_grid, сетка 7 мм')).toBeInTheDocument()
    expect(screen.getByText('Эпох в расчёте: 4 из 4')).toBeInTheDocument()
    expect(screen.getByText('Порог reject: 150 мкВ')).toBeInTheDocument()
    expect(screen.getByText('Полоса: 1–40 Гц')).toBeInTheDocument()
    expect(screen.queryByText('Результата нет')).not.toBeInTheDocument()
  })

  it('без результата говорит прямо, что таблица не запускает задачи сама', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    renderWithProviders(<LocalizationTablePanel />)

    expect(screen.getByText('Результата нет')).toBeInTheDocument()
    expect(
      screen.getByText(/Результат появится после расчёта в разделе «Диполи»/),
    ).toBeInTheDocument()
  })

  it('предупреждает, что параметры расчёта изменили после расчёта', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      params: { ...CALC_PARAM_DEFAULTS, rejectThresholdUv: 300 },
    })
    renderWithProviders(<LocalizationTablePanel />)

    expect(screen.getByText('Параметры расчёта изменены — нужен пересчёт')).toBeInTheDocument()
  })
})