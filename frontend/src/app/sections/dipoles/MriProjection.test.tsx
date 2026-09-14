/**
 * Тесты проекции мозга (срез 3.1): слои, подписи краёв, сетка MNI, клик и наведение.
 *
 * Проверяется то, что видно пользователю: выключенный слой исчезает из разметки,
 * подписи краёв выводятся из знаков осей, клик отдаёт точку MNI в плоскости
 * текущего среза и попадает в поле Бродмана, а курсор показывает координаты.
 */
import type { ComponentProps } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  PROJECTION_HINTS,
  PROJECTION_PADDING,
  PROJECTION_PLANES,
  defaultSlices,
  demoBrodmannAreas,
  normalizedToPx,
  planeEdgeLabels,
  projectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import { MRI_SLICE_UNAVAILABLE } from '@/shared/lib/mriSlices'
import type { MriSliceRef } from '@/shared/api/types'
import { demoDipoleLayer } from '@/shared/lib/dipolePoints'
import { DIPOLE_PARAM_DEFAULTS, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { renderWithProviders } from '@/test/renderWithProviders'
import { MriProjection } from './MriProjection'

/** Видимость слоёв с точечными правками: по умолчанию включены все. */
function visible(overrides: Partial<Record<DipoleLayerId, boolean>> = {}) {
  return { ...DIPOLE_PARAM_DEFAULTS.layerVisibility, ...overrides }
}

/** Ссылка на срезы МРТ: в тестах версия фиксирована — URL читается глазами. */
const MRI_REF: MriSliceRef = {
  version: 'v1',
  slice_url: '/api/v1/surface/mri/slice',
  spacing_mm: 1,
}

function renderProjection(
  plane: ProjectionPlane,
  overrides: Partial<ComponentProps<typeof MriProjection>> = {},
) {
  return renderWithProviders(
    <MriProjection plane={plane} slices={defaultSlices()} visibility={visible()} {...overrides} />,
  )
}

/** Подмена размеров фигуры: клики в тестах считаются в координатах viewBox. */
function stubFigure(plane: ProjectionPlane) {
  const svg = screen.getByTestId(`projection-svg-${plane}`)
  // Фигура прямоугольная: подменяем ровно её размеры, чтобы масштаб был 1:1
  const { width, height } = projectionBox(plane)
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height }) as DOMRect
  return svg
}

/**
 * Ожидаемые буквы краёв: выводятся из знаков осей плоскости. Горизонталь
 * аксиальной и коронарной проекций развёрнута (радиологическая раскладка):
 * слева на экране правое полушарие (R, x > 0), справа — левое (L, x < 0).
 */
const EXPECTED_EDGES: Record<
  ProjectionPlane,
  { left: string; right: string; top: string; bottom: string }
> = {
  sagittal: { left: 'P', right: 'A', top: 'S', bottom: 'I' },
  axial: { left: 'R', right: 'L', top: 'A', bottom: 'P' },
  coronal: { left: 'R', right: 'L', top: 'S', bottom: 'I' },
}

describe('проекция мозга', () => {
  it('подписывает края буквами направлений MNI', () => {
    for (const plane of PROJECTION_PLANES) {
      const view = renderProjection(plane)
      const edges = planeEdgeLabels(plane)
      const expected = EXPECTED_EDGES[plane]

      expect(edges.left.text).toBe(expected.left)
      expect(screen.getByTestId(`edge-${plane}-left`)).toHaveTextContent(expected.left)
      expect(screen.getByTestId(`edge-${plane}-right`)).toHaveTextContent(expected.right)
      expect(screen.getByTestId(`edge-${plane}-top`)).toHaveTextContent(expected.top)
      expect(screen.getByTestId(`edge-${plane}-bottom`)).toHaveTextContent(expected.bottom)

      view.unmount()
    }
  })

  it('показывает подпись своего среза и пояснение плоскости', () => {
    renderProjection('sagittal', { slices: { axial: 0, sagittal: 24, coronal: 0 } })

    expect(screen.getByTestId('projection-sagittal')).toHaveTextContent('x = 24.0 мм')
    expect(screen.getByTestId('projection-readout-sagittal')).toHaveTextContent(
      PROJECTION_HINTS.sagittal,
    )
  })

  it('рисует включённые слои и убирает выключенные', () => {
    renderProjection('axial', { visibility: visible({ head: false, brodmann: false }) })

    expect(screen.queryByTestId('layer-head-axial')).not.toBeInTheDocument()
    expect(screen.queryByTestId('layer-brodmann-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('layer-mni-axial')).toBeInTheDocument()
    expect(screen.getByTestId('layer-dipoles-axial')).toBeInTheDocument()
  })

  it('строит сетку MNI и отмечает нулевые линии осей', () => {
    renderProjection('coronal')

    // Коронарная: горизонталь — x, вертикаль — z, обе оси проходят через 0
    expect(screen.getByTestId('grid-coronal-v-0')).toBeInTheDocument()
    expect(screen.getByTestId('grid-coronal-h-0')).toBeInTheDocument()
  })

  it('рисует следы соседних срезов только на именованных ориентациях', () => {
    const view = renderProjection('coronal')
    expect(screen.getByTestId('guide-coronal-midline')).toBeInTheDocument()
    expect(screen.getByTestId('guide-coronal-axial_zero')).toBeInTheDocument()
    view.unmount()

    renderProjection('coronal', { slices: { axial: 0, sagittal: 18, coronal: 0 } })
    expect(screen.queryByTestId('guide-coronal-midline')).not.toBeInTheDocument()
  })

  it('подсвечивает выбранное поле Бродмана', () => {
    const areas = demoBrodmannAreas('axial', 0)
    const other = areas[0].name
    const target = areas[areas.length - 1].name

    renderProjection('axial', { selectedArea: target })

    expect(screen.getByTestId(`brodmann-axial-${target}`)).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId(`brodmann-axial-${other}`)).toHaveAttribute('data-active', 'false')
  })

  it('по умолчанию слой диполей пуст: расчёт не подключён', () => {
    renderProjection('axial')

    expect(screen.getByTestId('layer-dipoles-axial').querySelectorAll('circle')).toHaveLength(0)
  })

  it('рисует точки диполей с векторами и подписью в тултипе', () => {
    renderProjection('coronal', { points: demoDipoleLayer(7, 3) })

    expect(screen.getByTestId('layer-dipoles-coronal').querySelectorAll('circle')).toHaveLength(3)
    const marker = screen.getByTestId('dipole-coronal-0-0')
    expect(marker.querySelector('title')?.textContent).toContain('Эпоха 1')
  })

  it('клик отдаёт точку MNI в плоскости текущего среза', () => {
    const onPick = vi.fn()
    renderProjection('sagittal', {
      slices: { axial: 0, sagittal: 24, coronal: 0 },
      onPick,
    })
    const svg = stubFigure('sagittal')
    const box = projectionBox('sagittal')

    // Центр фигуры: y = 0 и z = 0 плоскости x/y/z дают начало координат
    fireEvent.click(svg, { clientX: box.width / 2, clientY: box.height / 2 })

    expect(onPick).toHaveBeenCalledTimes(1)
    const [point] = onPick.mock.calls[0]
    // Нормаль сагиттального среза — ось x: координата берётся из самого среза
    expect(point.x).toBe(24)
  })

  it('клик по полю Бродмана отдаёт имя поля (попадание по нарисованной геометрии)', () => {
    const onPick = vi.fn()
    renderProjection('axial', { onPick })
    const svg = stubFigure('axial')
    const area = demoBrodmannAreas('axial', 0)[0]
    const px = normalizedToPx(area.center, 'axial')

    fireEvent.click(svg, { clientX: px.x, clientY: px.y })

    expect(onPick).toHaveBeenCalledTimes(1)
    const [point, name] = onPick.mock.calls[0]
    expect(name).toBe(area.name)
    expect(point.z).toBe(0)
  })

  it('под курсором показывает координаты, после ухода — пояснение плоскости', () => {
    renderProjection('axial')
    const svg = stubFigure('axial')

    fireEvent.mouseMove(svg, { clientX: 120, clientY: 200 })

    expect(screen.getByTestId('hover-axial')).toBeInTheDocument()
    expect(screen.getByTestId('projection-readout-axial').textContent).toMatch(/MNI .* \/ .* \//)

    fireEvent.mouseLeave(svg)

    expect(screen.queryByTestId('hover-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('projection-readout-axial')).toHaveTextContent(PROJECTION_HINTS.axial)
  })

  it('рисует реальный срез МРТ и убирает условную схему среза', () => {
    renderProjection('axial', { mri: MRI_REF })

    const image = screen.getByTestId('layer-mri-axial')
    expect(image).toHaveAttribute('href', '/api/v1/surface/mri/slice/axial/0.png?v=v1')
    expect(image).toHaveAttribute('preserveAspectRatio', 'none')
    // Картинка накрывает всю плоскость: прямоугольник фигуры без полей подписей.
    // Прямоугольник не квадратный — масштаб осей единый (см. PROJECTION_SCALE).
    const box = projectionBox('axial')
    expect(image).toHaveAttribute('x', String(PROJECTION_PADDING))
    expect(image).toHaveAttribute('y', String(PROJECTION_PADDING))
    expect(image).toHaveAttribute('width', String(box.innerWidth))
    expect(image).toHaveAttribute('height', String(box.innerHeight))
    // Фикстура анатомии больше не рисуется — на срезе настоящий том
    expect(screen.queryByTestId(/slice-structure-axial-/)).not.toBeInTheDocument()
  })

  it('без ссылки на срезы остаётся условная схема среза', () => {
    renderProjection('axial')

    expect(screen.queryByTestId('layer-mri-axial')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/slice-structure-axial-/).length).toBeGreaterThan(0)
  })

  it('выключенный слой МРТ возвращает схему среза', () => {
    renderProjection('axial', { mri: MRI_REF, visibility: visible({ mri: false }) })

    expect(screen.queryByTestId('layer-mri-axial')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/slice-structure-axial-/).length).toBeGreaterThan(0)
  })

  it('квантует срез картинки к сетке тома', () => {
    renderProjection('axial', { mri: MRI_REF, slices: { axial: -3.5, sagittal: 0, coronal: 0 } })

    // Сетка 1 мм и округление «половина вверх» — как в бэкенде
    expect(screen.getByTestId('layer-mri-axial')).toHaveAttribute(
      'href',
      '/api/v1/surface/mri/slice/axial/-3.png?v=v1',
    )
  })

  it('недоступная картинка среза сообщается текстом и возвращает схему', () => {
    renderProjection('axial', { mri: MRI_REF })

    fireEvent.error(screen.getByTestId('layer-mri-axial'))

    expect(screen.queryByTestId('layer-mri-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('projection-readout-axial')).toHaveTextContent(MRI_SLICE_UNAVAILABLE)
    expect(screen.getAllByTestId(/slice-structure-axial-/).length).toBeGreaterThan(0)
  })
})
