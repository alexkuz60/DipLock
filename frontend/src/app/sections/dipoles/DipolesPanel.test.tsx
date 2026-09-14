/**
 * Тесты панели опций раздела «Диполи» (срез 3.1): слои, линейки срезов, сбросы.
 *
 * Панель — единственное место, где пользователь настраивает просмотр, и она
 * ничего не запускает: проверяем, что контролы меняют только состояние среза.
 */
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSlices } from '@/shared/lib/mriProjections'
import {
  DIPOLE_PARAM_DEFAULTS,
  EMPTY_SELECTION,
  useDipoleParams,
} from '@/shared/state/dipoleParams'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DipolesPanel } from './DipolesPanel'

describe('панель раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleParams.setState({
      params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
      selection: EMPTY_SELECTION,
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

  it('объясняет, что расчёт диполей ещё не подключён, и не зовёт сервер', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    renderWithProviders(<DipolesPanel />)

    expect(screen.getByText('Расчёт диполей не подключён — слой пуст')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
