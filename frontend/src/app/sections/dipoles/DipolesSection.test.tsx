/**
 * Тесты рабочей области раздела «Диполи» (срез 3.1).
 *
 * Проверяют главное правило раздела: UI показывает геометрию и **ничего не
 * запускает** (расчёт — отдельная задача), а клик по проекции наводит все три
 * среза на выбранную точку.
 */
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSlices } from '@/shared/lib/mriProjections'
import {
  DIPOLE_PARAM_DEFAULTS,
  EMPTY_SELECTION,
  useDipoleParams,
} from '@/shared/state/dipoleParams'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DipolesSection } from './DipolesSection'

/** Подмена размеров фигуры: клики считаются в координатах viewBox. */
function stubFigure(plane: string, size = 320) {
  const svg = screen.getByTestId(`projection-svg-${plane}`)
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: size, height: size, right: size, bottom: size }) as DOMRect
  return svg
}

describe('рабочая область раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleParams.setState({
      params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
      selection: EMPTY_SELECTION,
    })
  })

  it('показывает три проекции и честный статус пустого слоя диполей', () => {
    renderWithProviders(<DipolesSection />)

    expect(screen.getByTestId('projection-axial')).toBeInTheDocument()
    expect(screen.getByTestId('projection-sagittal')).toBeInTheDocument()
    expect(screen.getByTestId('projection-coronal')).toBeInTheDocument()
    expect(screen.getByText('Расчёт диполей не подключён — слой пуст')).toBeInTheDocument()
    expect(screen.getByText(/Срезы: z = 0\.0 мм · x = 0\.0 мм · y = 0\.0 мм/)).toBeInTheDocument()
  })

  it('клик по проекции наводит срезы на точку и ставит перекрестие', () => {
    renderWithProviders(<DipolesSection />)
    const svg = stubFigure('sagittal')

    fireEvent.click(svg, { clientX: 160, clientY: 160 })

    const state = useDipoleParams.getState()
    expect(state.selection.point).not.toBeNull()
    // Центр сагиттальной фигуры — срединная сагитталь (x = 0), срез «прилип»
    expect(state.params.slices.sagittal).toBe(0)
    expect(state.selection.orientations.sagittal).toBe('midline')

    // Все три проекции показывают перекрестие в выбранной точке
    for (const plane of ['axial', 'sagittal', 'coronal']) {
      expect(screen.getByTestId(`reference-${plane}`)).toBeInTheDocument()
    }
  })

  it('попадание в поле Бродмана подписывается в полосе состояния', () => {
    renderWithProviders(<DipolesSection />)
    const svg = stubFigure('axial')
    // BA17 (затылочное поле) лежит в аксиальном срезе ниже центра фигуры
    fireEvent.click(svg, { clientX: 160, clientY: 250 })

    const area = useDipoleParams.getState().selection.area
    if (area) {
      expect(screen.getByText(`Поле под точкой: ${area}`)).toBeInTheDocument()
    } else {
      expect(screen.queryByText(/Поле под точкой:/)).not.toBeInTheDocument()
    }
  })

  it('ничего не запрашивает у сервера: раздел не запускает обработку', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderWithProviders(<DipolesSection />)
    const svg = stubFigure('coronal')

    fireEvent.click(svg, { clientX: 140, clientY: 180 })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
