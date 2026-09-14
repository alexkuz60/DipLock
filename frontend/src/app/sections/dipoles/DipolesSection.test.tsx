/**
 * Тесты рабочей области раздела «Диполи» (срез 3.1, срез МРТ — 3.2).
 *
 * Проверяют главное правило раздела: UI показывает геометрию и **ничего не
 * запускает** (расчёт — отдельная задача; из запросов допустимы только
 * метаданные), а клик по проекции наводит все три среза на выбранную точку.
 */
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECTION_PLANES,
  defaultSlices,
  projectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import {
  DIPOLE_PARAM_DEFAULTS,
  EMPTY_SELECTION,
  useDipoleParams,
} from '@/shared/state/dipoleParams'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DipolesSection } from './DipolesSection'

/** Метка среза МРТ по умолчанию: аксиальный через AC–PC. */
const MRI_HREF = '/api/v1/surface/mri/slice/axial/0.png?v=mri12345678'

/** Подмена размеров фигуры: клики считаются в координатах viewBox. */
function stubFigure(plane: ProjectionPlane) {
  const svg = screen.getByTestId(`projection-svg-${plane}`)
  // Фигура прямоугольная (единый масштаб мм/пиксель): подменяем её же размеры
  const { width, height } = projectionBox(plane)
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height }) as DOMRect
  return svg
}

describe('рабочая область раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleParams.setState({
      params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
      selection: EMPTY_SELECTION,
    })
    vi.stubGlobal('fetch', mockApiFetch())
  })

  it('показывает три проекции и честный статус пустого слоя диполей', () => {
    renderWithProviders(<DipolesSection />)

    expect(screen.getByTestId('projection-axial')).toBeInTheDocument()
    expect(screen.getByTestId('projection-sagittal')).toBeInTheDocument()
    expect(screen.getByTestId('projection-coronal')).toBeInTheDocument()
    expect(screen.getByText('Расчёт диполей не подключён — слой пуст')).toBeInTheDocument()
    expect(screen.getByText(/Срезы: z = 0\.0 мм · x = 0\.0 мм · y = 0\.0 мм/)).toBeInTheDocument()
  })

  it('держит общий экранный масштаб: колонки пропорциональны ширинам фигур', () => {
    renderWithProviders(<DipolesSection />)

    // Фигуры прямоугольные (единый мм/пиксель внутри `projectionBox`), поэтому
    // колонки заданы пропорционально их ширине: коэффициент растяжения SVG
    // (`колонка / ширина фигуры`) у всех трёх одинаков, и 1 мм на экране — это
    // одна и та же длина во всех проекциях.
    const grow = PROJECTION_PLANES.map((plane) =>
      Number(screen.getByTestId(`projection-${plane}`).style.flexGrow),
    )

    expect(grow).toEqual(PROJECTION_PLANES.map((plane) => projectionBox(plane).width))
    // Аксиальная вытянута по y (196 мм), сагиттальная — по y тоже, но выше:
    // самая широкая колонка именно у сагиттальной проекции
    expect(grow[1]).toBeGreaterThan(grow[0])
    expect(grow[1]).toBeGreaterThan(grow[2])
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

  it('запрашивает только метаданные и никогда не запускает обработку', () => {
    const fetchMock = mockApiFetch()
    vi.stubGlobal('fetch', fetchMock)
    renderWithProviders(<DipolesSection />)
    const svg = stubFigure('coronal')

    fireEvent.click(svg, { clientX: 140, clientY: 180 })

    const paths = fetchMock.mock.calls.map(([path]) => String(path))
    expect(paths.every((path) => path.startsWith('/api/v1/meta'))).toBe(true)
    expect(paths.some((path) => /jobs|preprocess|analyze|recordings/.test(path))).toBe(false)
  })

  it('рисует реальный срез МРТ картинкой с версией ассета', async () => {
    renderWithProviders(<DipolesSection />)

    const image = await screen.findByTestId('layer-mri-axial')
    expect(image).toHaveAttribute('href', MRI_HREF)
    // Сагиттальная проекция наводится по оси x — своя картинка того же тома
    expect(screen.getByTestId('layer-mri-sagittal')).toHaveAttribute(
      'href',
      '/api/v1/surface/mri/slice/sagittal/0.png?v=mri12345678',
    )
    expect(screen.getByText('МРТ: срез T1, сетка 1 мм')).toBeInTheDocument()
  })

  it('без метаданных слой МРТ не рисуется и статус честный', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('сервер недоступен')
      }),
    )
    renderWithProviders(<DipolesSection />)

    expect(screen.queryByTestId('layer-mri-axial')).not.toBeInTheDocument()
    expect(await screen.findByText('МРТ: метаданные недоступны')).toBeInTheDocument()
  })
})
