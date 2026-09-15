/**
 * Тесты панели опций раздела «Диполи» (срез 3.1, расчёт — 3.4): слои, линейки
 * срезов, сбросы, параметры расчёта и порог «КД ≥ X нАм».
 *
 * Панель — единственное место, где пользователь настраивает просмотр и расчёт, и
 * она **ничего не запускает**: проверяем, что контролы меняют только состояние, а
 * из запросов возможны лишь статические метаданные (`/meta` — длины эпох).
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSlices } from '@/shared/lib/mriProjections'
import {
  DIPOLE_PARAM_DEFAULTS,
  EMPTY_SELECTION,
  useDipoleParams,
} from '@/shared/state/dipoleParams'
import { CALC_PARAM_DEFAULTS, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { dipoleScanResultFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DipolesPanel } from './DipolesPanel'

describe('панель раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleParams.setState({
      params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
      selection: EMPTY_SELECTION,
    })
    // Расчёт — сессионное состояние: каждый тест начинает с чистых параметров
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS },
      amplitudeThresholdNam: 0,
      job: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      error: null,
      spectrumError: null,
      view: 'none',
    })
  })

  it('переключает фоновые слои через состояние раздела', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    const checkbox = screen.getByLabelText('Поля Бродмана')
    expect(checkbox).toBeChecked()

    await user.click(checkbox)

    expect(useDipoleParams.getState().params.layerVisibility.brodmann).toBe(false)
    expect(screen.getByLabelText('Силуэт головы')).toBeChecked()
  })

  it('включает слой реального среза МРТ отдельно от схемы среза', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    const checkbox = screen.getByLabelText('Срез МРТ (T1)')
    expect(checkbox).toBeChecked()

    await user.click(checkbox)

    expect(useDipoleParams.getState().params.layerVisibility.mri).toBe(false)
    // Схема среза MNI — другой слой: её правка не следует за срезом МРТ
    expect(useDipoleParams.getState().params.layerVisibility.mni).toBe(true)
  })

  it('показывает линейку каждого среза с маркером именованной ориентации', () => {
    renderWithProviders(<DipolesPanel />)

    expect(screen.getByLabelText('Срез z, аксиальная')).toBeInTheDocument()
    expect(screen.getByLabelText('Срез x, сагиттальная')).toBeInTheDocument()
    expect(screen.getByLabelText('Срез y, коронарная')).toBeInTheDocument()
    expect(screen.getByTestId('slice-mark-z = 0')).toBeInTheDocument()
    expect(screen.getByTestId('slice-mark-x = 0')).toBeInTheDocument()
    expect(screen.getByTestId('slice-mark-y = 0')).toBeInTheDocument()
  })

  it('наводит срез линейкой и сбрасывает его к именованному', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    fireEvent.change(screen.getByLabelText('Срез x, сагиттальная'), { target: { value: '24' } })
    expect(useDipoleParams.getState().params.slices.sagittal).toBe(24)

    await user.click(screen.getByRole('button', { name: 'К именованным срезам' }))
    expect(useDipoleParams.getState().params.slices).toEqual(defaultSlices())
  })

  it('показывает координаты выбранной точки и подсвеченное поле', () => {
    useDipoleParams.getState().selectPoint({ x: 12, y: -34.5, z: 18 }, 'BA17', {
      sagittal: 'midline',
    })
    renderWithProviders(<DipolesPanel />)

    expect(screen.getByText('MNI 12.0 / -34.5 / 18.0')).toBeInTheDocument()
    expect(screen.getByText('BA17')).toBeInTheDocument()
    expect(screen.getByText('Сагиттальная: срединная сагитталь')).toBeInTheDocument()
  })

  it('кнопка «Всё по умолчанию» возвращает и слои, и срезы', async () => {
    const user = userEvent.setup()
    useDipoleParams.getState().setLayerVisible('mni', false)
    useDipoleParams.getState().setSlice('axial', 30)
    renderWithProviders(<DipolesPanel />)

    await user.click(screen.getByRole('button', { name: 'Всё по умолчанию' }))

    const state = useDipoleParams.getState()
    expect(state.params.slices).toEqual(defaultSlices())
    expect(state.params.layerVisibility).toEqual(DIPOLE_PARAM_DEFAULTS.layerVisibility)
  })

  it('не запускает обработку: единственный запрос — статические метаданные', async () => {
    // Панель правда ничего не считает: ей нужен только `/meta` — список длин
    // эпох (тот же ключ react-query, что у раздела EDF). Ни одной задачи расчёта.
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesPanel />)

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const urls = fetchSpy.mock.calls.map(([input]) => String(input))
    expect(urls.every((url) => url.includes('/meta'))).toBe(true)
    expect(screen.getByText('Расчёт диполей не подключён — слой пуст')).toBeInTheDocument()
    expect(screen.getByText('Спектр не рассчитан')).toBeInTheDocument()
  })

  it('длины эпох приходят из конфигурации сервера, правка ничего не запускает', async () => {
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesPanel />)

    const select = await screen.findByLabelText('Длина эпохи')
    await waitFor(() => expect(select).not.toBeDisabled())
    expect(screen.getByRole('option', { name: '2000 мс' })).toBeInTheDocument()

    fireEvent.change(select, { target: { value: '500' } })
    expect(useDipoleCalc.getState().params.epochLengthMs).toBe(500)
    // Правка параметра — не запуск: ни одной задачи (все запросы только за метаданными)
    const urls = fetchSpy.mock.calls.map(([input]) => String(input))
    expect(urls.every((url) => url.includes('/meta'))).toBe(true)
  })

  it('порог «КД ≥» скрывает слабые диполи и сообщает, сколько скрыто', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture(), amplitudeThresholdNam: 50 })
    renderWithProviders(<DipolesPanel />)

    // В фикстуре три точки с MNI (60, 25, 90 нАм): порог 50 скрывает одну
    expect(screen.getByText('Скрыто порогом «КД ≥ 50 нАм»: 1 из 3')).toBeInTheDocument()
    expect(screen.getByText('Точек диполей: 2')).toBeInTheDocument()
    expect(screen.getByText('Эпох в расчёте: 4 из 4')).toBeInTheDocument()
  })

  it('кнопка «Сбросить расчёт» убирает результат, но не параметры', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<DipolesPanel />)

    await user.click(screen.getByRole('button', { name: 'Сбросить расчёт' }))

    expect(useDipoleCalc.getState().result).toBeNull()
    expect(useDipoleCalc.getState().params.epochLengthMs).toBe(1000)
  })
})
