/**
 * Тесты проекции мозга (срез 3.1): слои, подписи краёв, сетка MNI, клик и наведение.
 *
 * Проверяется то, что видно пользователю: выключенный слой исчезает из разметки,
 * подписи краёв выводятся из знаков осей, клик отдаёт точку MNI в плоскости
 * текущего среза и попадает в поле Бродмана, а курсор показывает координаты.
 */
import type { ComponentProps } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import {
  ARROW_LENGTH_MAX_PX,
  DIPOLE_DOT_RADIUS_PX,
  DIPOLE_DOT_STROKE_PX,
  DIPOLE_FRAME_HALO_RADIUS_PX,
  DIPOLE_RAY_STROKE_PX,
  FRAME_DIM_OPACITY,
  demoDipoleLayer,
  dipoleLayerFromScan,
  dipoleRayVisual,
  type DipoleLayer,
} from '@/shared/lib/dipolePoints'
import { PLAYBACK_DEFAULTS, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { DIPOLE_PARAM_DEFAULTS, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { dipoleScanResultFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { MriProjection } from './MriProjection'
import { PlaybackFrameProvider } from './PlaybackFrame'

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

/**
 * Проекция с часами воспроизведения: кадр приходит контекстом, поэтому без
 * провайдера маркера кадра не бывает вовсе (`usePlaybackFrame` → `null`).
 */
function renderProjectionWithFrame(
  plane: ProjectionPlane,
  overrides: Partial<ComponentProps<typeof MriProjection>> = {},
) {
  return renderWithProviders(
    <PlaybackFrameProvider>
      <MriProjection plane={plane} slices={defaultSlices()} visibility={visible()} {...overrides} />
    </PlaybackFrameProvider>,
  )
}

/** Слой точек из результата задачи: те же данные, что рисует раздел (без порога «КД»). */
function resultLayer(): DipoleLayer {
  return dipoleLayerFromScan(dipoleScanResultFixture())
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
  beforeEach(() => {
    // Кадр воспроизведения — состояние сессии: тесты не должны влиять друг на друга
    useDipoleCalc.setState({ result: null, playback: { ...PLAYBACK_DEFAULTS } })
  })

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

    expect(screen.getAllByTestId(/^dipole-dot-coronal-/)).toHaveLength(3)
    const marker = screen.getByTestId('dipole-coronal-0-0')
    expect(marker.querySelector('title')?.textContent).toContain('Эпоха 1')
  })

  /**
   * Слои позиций и векторов — раздельные (срез 3.5): «где» и «куда» отвечают на
   * разные вопросы, и выключать их хочется по отдельности.
   */
  it('включает и выключает позиции и векторы диполей порознь', () => {
    const layer = demoDipoleLayer(3, 2)

    const vectorsOff = renderProjection('coronal', {
      points: layer,
      visibility: visible({ vectors: false }),
    })
    expect(screen.queryByTestId('layer-dipole-vectors-coronal')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/^dipole-dot-coronal-/)).toHaveLength(2)
    vectorsOff.unmount()

    const dotsOff = renderProjection('coronal', {
      points: layer,
      visibility: visible({ dipoles: false }),
    })
    // Луч идёт от позиции диполя, поэтому остаётся: карта направлений без точек
    // — осмысленный вид, а не «сломанный» слой
    expect(screen.queryByTestId('layer-dipoles-coronal')).not.toBeInTheDocument()
    expect(screen.getAllByTestId(/^dipole-vector-coronal-/).length).toBeGreaterThan(0)
    expect(screen.getAllByTestId(/^dipole-arrow-coronal-/).length).toBeGreaterThan(0)
    dotsOff.unmount()

    renderProjection('coronal', {
      points: layer,
      visibility: visible({ vectors: false, dipoles: false }),
    })
    expect(screen.queryByTestId('layer-dipoles-coronal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('layer-dipole-vectors-coronal')).not.toBeInTheDocument()
  })

  it('рисует наконечник полигоном от длины луча, а не одним размером на проекцию', () => {
    renderProjection('axial', { points: demoDipoleLayer(5, 2) })

    const arrow = screen.getByTestId('dipole-arrow-axial-0-0')
    const vertices = (arrow.getAttribute('points') ?? '')
      .split(' ')
      .map((pair) => pair.split(',').map(Number))
    const line = screen.getByTestId('dipole-vector-axial-0-0')
    // Толщина штриха луча фиксирована (поправка ручной проверки): 2 px по экрану
    expect(line).toHaveAttribute('stroke-width', String(DIPOLE_RAY_STROKE_PX))
    const at = { x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1')) }
    const shaftEnd = { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) }
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y)

    expect(vertices).toHaveLength(3)
    const tip = { x: vertices[0][0], y: vertices[0][1] }
    // Наконечник продолжает луч: вершина дальше от точки, чем штрих
    expect(dist(tip, at)).toBeGreaterThan(dist(shaftEnd, at))
    // Длина наконечника — от длины луча и зажата, а не «на всю проекцию»
    expect(dist(tip, shaftEnd)).toBeGreaterThan(0)
    expect(dist(tip, shaftEnd)).toBeLessThanOrEqual(ARROW_LENGTH_MAX_PX)
    // Крылья симметричны: треугольник, а не «клин» в одну сторону
    const left = { x: vertices[1][0], y: vertices[1][1] }
    const right = { x: vertices[2][0], y: vertices[2][1] }
    expect(dist(tip, left)).toBeCloseTo(dist(tip, right), 6)
  })

  it('рисует позиции белыми кольцами фиксированного размера при любой силе диполя', () => {
    const layer = demoDipoleLayer(11, 4)
    const weak = { ...layer.points[0], id: 'weak', amplitudeNaM: 1 }
    const strong = { ...layer.points[1], id: 'strong', amplitudeNaM: 1000 }

    renderProjection('axial', { points: { points: [weak, strong], source: 'demo' } })

    // Поправка ручной проверки: размер кольца не зависит от силы диполя. В jsdom
    // раскладки нет, масштаб фигуры 1 — атрибуты равны экранным пикселям.
    for (const id of ['weak', 'strong']) {
      const dot = screen.getByTestId(`dipole-dot-axial-${id}`)
      expect(dot).toHaveAttribute('r', String(DIPOLE_DOT_RADIUS_PX))
      expect(dot).toHaveAttribute('stroke-width', String(DIPOLE_DOT_STROKE_PX))
      expect(dot).toHaveAttribute('stroke', 'var(--color-mri-dipole-point)')
      expect(dot).toHaveAttribute('fill', 'none')
    }
    // Лучи моментов — тоже фиксированной толщины: у слабого и сильного одинаково
    for (const ray of screen.queryAllByTestId(/^dipole-vector-axial-/)) {
      expect(ray).toHaveAttribute('stroke-width', String(DIPOLE_RAY_STROKE_PX))
    }
  })

  it('клик по точке выделяет диполь и наводит срезы на его позицию', () => {
    const onSelectPoint = vi.fn()
    const onPick = vi.fn()
    renderProjection('coronal', {
      points: demoDipoleLayer(7, 2),
      onSelectPoint,
      onPick,
    })
    const point = demoDipoleLayer(7, 2).points[1]

    fireEvent.click(screen.getByTestId('dipole-hit-coronal-0-1'))

    expect(onSelectPoint).toHaveBeenCalledWith('0-1')
    // Срезы меняются при любом клике (поправка ручной проверки): по диполю —
    // на его точную позицию MNI, а не на «сырую» точку клика у края хит-зоны
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(point.position, point.brodmannArea)
  })

  it('подсвечивает выделенный диполь и снимает выделение повторным кликом', () => {
    const onSelectPoint = vi.fn()
    const point = demoDipoleLayer(7, 2).points[0]
    const view = renderProjection('coronal', {
      points: demoDipoleLayer(7, 2),
      selectedPointId: point.id,
      onSelectPoint,
    })

    expect(screen.getByTestId(`dipole-coronal-${point.id}`)).toHaveAttribute(
      'data-selected',
      'true',
    )
    // Выделенный диполь залит оранжево-жёлтым, кольцо остаётся белым
    expect(screen.getByTestId(`dipole-dot-coronal-${point.id}`)).toHaveAttribute(
      'fill',
      'var(--color-mri-dipole)',
    )
    expect(screen.getByTestId(`dipole-dot-coronal-${point.id}`)).toHaveAttribute(
      'stroke',
      'var(--color-mri-dipole-point)',
    )
    view.unmount()

    // Повторный клик по выделенной точке отдаёт `null` — «снять выделение»
    renderProjection('coronal', {
      points: demoDipoleLayer(7, 2),
      selectedPointId: point.id,
      onSelectPoint,
    })
    fireEvent.click(screen.getByTestId(`dipole-hit-coronal-${point.id}`))
    expect(onSelectPoint).toHaveBeenCalledWith(null)
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

  it('под курсором показывает координаты текстом, без маркера на фигуре', () => {
    renderProjection('axial')
    const svg = stubFigure('axial')

    fireEvent.mouseMove(svg, { clientX: 120, clientY: 200 })

    // Маркера, бегающего за мышью, нет: его путали с кольцами диполей (ручная проверка)
    expect(screen.queryByTestId('hover-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('projection-readout-axial').textContent).toMatch(/MNI .* \/ .* \//)

    fireEvent.mouseLeave(svg)

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

  /**
   * Кадр воспроизведения (срез 3.7) приходит **контекстом**: маркер обновляется сам
   * (60 раз в секунду), а статичные слои проекции не перерисовываются. Поэтому без
   * провайдера маркера кадра нет вовсе, а в режиме кадра облако приглушается —
   * размер кольца позиции при этом не меняется (правило раздела).
   */
  it('рисует маркер кадра воспроизведения поверх приглушённого облака', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 0 },
    })

    renderProjectionWithFrame('axial', { points: resultLayer(), dimmed: true })

    // Маркер кадра: гало (отличие от кликового выделения) + кольцо того же размера
    expect(screen.getByTestId('frame-halo-axial')).toHaveAttribute(
      'r',
      String(DIPOLE_FRAME_HALO_RADIUS_PX),
    )
    expect(screen.getByTestId('frame-halo-axial')).toHaveAttribute('stroke', 'var(--color-accent)')
    const dot = screen.getByTestId('frame-dot-axial')
    expect(dot).toHaveAttribute('r', String(DIPOLE_DOT_RADIUS_PX))
    expect(dot).toHaveAttribute('fill', 'var(--color-mri-dipole)')
    expect(screen.getByTestId('frame-vector-axial')).toHaveAttribute(
      'stroke',
      'var(--color-accent)',
    )
    expect(screen.getByTestId('frame-axial').querySelector('title')?.textContent).toContain(
      'Кадр воспроизведения: Эпоха 1',
    )

    // Облако приглушено, но не исчезло: видно и движение, и общий рисунок точек
    const cloudDot = screen.getByTestId('dipole-dot-axial-1-140')
    expect(cloudDot).toHaveAttribute('stroke-opacity', String(FRAME_DIM_OPACITY))
    // Луч приглушается вместе с точкой: сила момента умножается на приглушение
    const cloudRayOpacity = dipoleRayVisual(25).opacity * FRAME_DIM_OPACITY
    expect(screen.getByTestId('dipole-vector-axial-1-140')).toHaveAttribute(
      'stroke-opacity',
      String(cloudRayOpacity),
    )
  })

  it('не рисует маркер кадра без кадра и уважает выключенные слои', () => {
    // Результат есть, но кадр не задействован: облако в обычном виде (приглушение —
    // решение раздела, а не часов: `dimmed` приходит пропсом)
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const idle = renderProjectionWithFrame('axial', { points: resultLayer() })
    expect(screen.queryByTestId('frame-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('dipole-dot-axial-1-140')).toHaveAttribute('stroke-opacity', '1')
    idle.unmount()

    // Кадр задействован: эпоха выбрана, отсчёт времени не нужен — маркер стоит на
    // измеренной точке (доля нулевая, воспроизведение на паузе)
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 0 },
    })

    // Позиции выключены — у кадра остаётся луч; векторы выключены — остаётся кольцо
    const raysOnly = renderProjectionWithFrame('axial', {
      points: resultLayer(),
      dimmed: true,
      visibility: visible({ dipoles: false }),
    })
    expect(screen.queryByTestId('frame-dot-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('frame-vector-axial')).toBeInTheDocument()
    raysOnly.unmount()

    renderProjectionWithFrame('axial', {
      points: resultLayer(),
      dimmed: true,
      visibility: visible({ vectors: false }),
    })
    expect(screen.getByTestId('frame-dot-axial')).toBeInTheDocument()
    expect(screen.queryByTestId('frame-vector-axial')).not.toBeInTheDocument()
  })
})
