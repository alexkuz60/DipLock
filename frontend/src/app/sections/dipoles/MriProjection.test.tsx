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
  PROJECTION_SCALE,
  defaultSlices,
  mniToNormalized,
  normalizedToPx,
  planeEdgeLabels,
  projectPoint,
  projectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import { demoBrodmannAreas } from '@/shared/lib/mriDemoShapes'
import { MRI_SLICE_UNAVAILABLE } from '@/shared/lib/mriSlices'
import type { MriSliceRef } from '@/shared/api/types'
import {
  ARROW_LENGTH_MAX_PX,
  DIPOLE_DOT_GROWTH_PX,
  DIPOLE_DOT_RADIUS_PX,
  DIPOLE_DOT_STROKE_PX,
  DIPOLE_FRAME_HALO_RADIUS_PX,
  DIPOLE_RAY_STROKE_PX,
  FRAME_DIM_OPACITY,
  OVERLAP_FILL_MIN_OPACITY,
  TRAIL_STROKE_PX,
  demoDipoleLayer,
  dipoleLayerFromScan,
  dipoleRayVisual,
  type DipoleLayer,
} from '@/shared/lib/dipolePoints'
import { TRAIL_ALPHA_HEAD } from '@/shared/lib/playback'
import { PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { DIPOLE_PARAM_DEFAULTS, type DipoleLayerId } from '@/shared/state/dipoleParams'
import { dipoleScanResultFixture, contourSliceFixture } from '@/test/fixtures'
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
    // Тултип — курсорная строка под фигурой (поправка 19.09.2026): наведение
    // на центр кольца называет его эпоху, `<title>` у точек больше нет
    const dot = screen.getByTestId('dipole-dot-coronal-0-0')
    fireEvent.mouseMove(screen.getByTestId('projection-svg-coronal'), {
      clientX: Number(dot.getAttribute('cx')),
      clientY: Number(dot.getAttribute('cy')),
    })
    expect(screen.getByTestId('projection-readout-coronal').textContent).toContain('Эпоха 1')
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

  it('рисует наконечник залитым треугольником в уменьшенном габарите, а не фигурой на всю проекцию', () => {
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
    // Наконечник залит цветом вектора (заливка возвращена: комок убрал уменьшенный габарит)
    expect(arrow).toHaveAttribute('fill', 'var(--color-mri-dipole-vector)')
    // Порядок точек — вершина, левое крыло, правое крыло
    const tip = { x: vertices[0][0], y: vertices[0][1] }
    const left = { x: vertices[1][0], y: vertices[1][1] }
    const right = { x: vertices[2][0], y: vertices[2][1] }
    // Наконечник продолжает луч: вершина дальше от точки, чем штрих
    expect(dist(tip, at)).toBeGreaterThan(dist(shaftEnd, at))
    // Длина наконечника — от длины луча и зажата, а не «на всю проекцию»
    expect(dist(tip, shaftEnd)).toBeGreaterThan(0)
    expect(dist(tip, shaftEnd)).toBeLessThanOrEqual(ARROW_LENGTH_MAX_PX + 1e-9)
    // Крылья симметричны: треугольник, а не «клин» в одну сторону
    expect(dist(tip, left)).toBeCloseTo(dist(tip, right), 6)
  })

  it('рисует позиции белыми кольцами: размер не зависит от силы диполя', () => {
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

  /**
   * Кратность узла (поправка ручной проверки, 18.09.2026): в быстром режиме несколько
   * эпох могут выбрать один узел сетки, поэтому размер кольца читает их число
   * (Ø 6 px + 2 px за диполь), а когда диаметр упирается в предел `2 · grid_mm`
   * (центр соседнего узла) — кратность показывает заливка от 25 %.
   */
  it('растит кольцо по кратности узла и включает заливку за пределом сетки', () => {
    const layer = demoDipoleLayer(13, 3)
    const single = { ...layer.points[0], id: 'single', overlapCount: 1 }
    const pair = { ...layer.points[1], id: 'pair', overlapCount: 2 }
    const crowded = { ...layer.points[2], id: 'crowded', overlapCount: 6 }

    const onSelectPoint = vi.fn()
    renderProjection('axial', {
      gridMm: 5,
      points: { points: [single, pair, crowded], source: 'demo' },
      onSelectPoint,
    })

    // В jsdom раскладки нет: масштаб 1, атрибуты — экранные пиксели
    expect(screen.getByTestId('dipole-dot-axial-single')).toHaveAttribute(
      'r',
      String(DIPOLE_DOT_RADIUS_PX),
    )
    expect(screen.getByTestId('dipole-dot-axial-pair')).toHaveAttribute(
      'r',
      String(DIPOLE_DOT_RADIUS_PX + DIPOLE_DOT_GROWTH_PX / 2),
    )

    // Предел 2 · grid_mm в единицах фигуры: дальше растёт только заливка
    const capped = screen.getByTestId('dipole-dot-axial-crowded')
    expect(capped).toHaveAttribute('r', String((2 * 5 * PROJECTION_SCALE) / 2))
    expect(capped).not.toHaveAttribute('fill', 'none')
    expect(Number(capped.getAttribute('fill-opacity'))).toBeGreaterThanOrEqual(
      OVERLAP_FILL_MIN_OPACITY,
    )
    // Хит-радиус растёт вместе с кольцом (курсорная модель, 19.09.2026): клик
    // у самого края крупного кольца — дальше базовых 9 px от центра — выбирает
    // именно его, а не молчит и не попадает в соседа
    const crowdedDot = screen.getByTestId('dipole-dot-axial-crowded')
    fireEvent.click(screen.getByTestId('projection-svg-axial'), {
      clientX: Number(crowdedDot.getAttribute('cx')) + 9.2,
      clientY: Number(crowdedDot.getAttribute('cy')),
    })
    expect(onSelectPoint).toHaveBeenCalledWith('crowded')
  })

  /**
   * Цвет векторов (поправка ручной проверки): луч и наконечник приглушены
   * (`--color-mri-dipole-vector`) относительно белых колец позиций — «куда» не
   * спорит с «где». Выделение остаётся акцентным. Вектор кадра анимации — слой
   * `playback`, его цвет проверяется в тестах воспроизведения и здесь не трогается.
   */
  it('приглушает векторы моментов, оставляя выделение акцентным', () => {
    const layer = demoDipoleLayer(7, 2)
    const selected = layer.points[0]
    const other = layer.points[1]

    renderProjection('axial', { points: layer, selectedPointId: selected.id })

    // Обычный вектор — приглушённый красный, а не оранжевый диполя; залитый наконечник — тем же цветом
    expect(screen.getByTestId(`dipole-vector-axial-${other.id}`)).toHaveAttribute(
      'stroke',
      'var(--color-mri-dipole-vector)',
    )
    expect(screen.getByTestId(`dipole-arrow-axial-${other.id}`)).toHaveAttribute(
      'fill',
      'var(--color-mri-dipole-vector)',
    )
    // Выделенный диполь подсвечен акцентом — и лучом, и наконечником; кольцо остаётся белым
    expect(screen.getByTestId(`dipole-vector-axial-${selected.id}`)).toHaveAttribute(
      'stroke',
      'var(--color-accent)',
    )
    expect(screen.getByTestId(`dipole-arrow-axial-${selected.id}`)).toHaveAttribute(
      'fill',
      'var(--color-accent)',
    )
    expect(screen.getByTestId(`dipole-dot-axial-${selected.id}`)).toHaveAttribute(
      'stroke',
      'var(--color-mri-dipole-point)',
    )
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

    const dot = screen.getByTestId('dipole-dot-coronal-0-1')
    fireEvent.click(screen.getByTestId('projection-svg-coronal'), {
      clientX: Number(dot.getAttribute('cx')),
      clientY: Number(dot.getAttribute('cy')),
    })

    expect(onSelectPoint).toHaveBeenCalledWith('0-1')
    // Срезы меняются при любом клике (поправка ручной проверки): по диполю —
    // на его точную позицию MNI, а не на «сырую» точку клика у края хит-зоны
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(point.position, point.brodmannArea, null)
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
    const dot = screen.getByTestId(`dipole-dot-coronal-${point.id}`)
    fireEvent.click(screen.getByTestId('projection-svg-coronal'), {
      clientX: Number(dot.getAttribute('cx')),
      clientY: Number(dot.getAttribute('cy')),
    })
    expect(onSelectPoint).toHaveBeenCalledWith(null)
  })

  /**
   * Курсорная модель попадания (находка ручной проверки, 19.09.2026): при мелкой
   * сетке хит-зоны соседних узлов перекрываются (2 мм — это 3 px проекции, зона —
   * 9 px), и «верхний» элемент DOM мог принадлежать соседнему узлу: у крупного
   * кольца с N=2 всплывал тултип «диполей в узле: 1». Теперь тултип и клик берут
   * **ближайший к курсору центр**, а подпись перечисляет все эпохи узла.
   */
  it('тултип узла перечисляет эпохи, клик выбирает ближайший центр', () => {
    const base = demoDipoleLayer(5, 1).points[0]
    const first = {
      ...base,
      id: 'a1',
      epochIndex: 2,
      position: { x: 0, y: 0, z: 0 },
      overlapCount: 2,
    }
    const second = { ...first, id: 'a2', epochIndex: 4 }
    // Сосед в 2 мм (3 px) от узла, нарисован позже — в DOM-стэке он «верхний»
    const neighbor = {
      ...first,
      id: 'b',
      epochIndex: 6,
      position: { x: 2, y: 0, z: 0 },
      overlapCount: 1,
    }
    const onSelectPoint = vi.fn()
    renderProjection('coronal', {
      points: { points: [first, second, neighbor], source: 'demo' },
      onSelectPoint,
    })

    const dot = screen.getByTestId('dipole-dot-coronal-a1')
    const cx = Number(dot.getAttribute('cx'))
    const cy = Number(dot.getAttribute('cy'))
    const svg = screen.getByTestId('projection-svg-coronal')

    fireEvent.mouseMove(svg, { clientX: cx, clientY: cy })
    const readout = screen.getByTestId('projection-readout-coronal').textContent
    expect(readout).toContain('Эпоха 3')
    expect(readout).toContain('диполей в узле: 2')
    expect(readout).toContain('эпохи узла: 3, 5')
    expect(readout).not.toContain('Эпоха 7')

    // Клик по центру узла выбирает его точку, хотя сосед нарисован позже
    fireEvent.click(svg, { clientX: cx, clientY: cy })
    expect(onSelectPoint).toHaveBeenCalledWith('a1')
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

  /**
   * Перекрестие точки клика (поправка ручной проверки): клик наводит **все три**
   * среза, и на каждой проекции рисуются XY-линии плоскостей этих срезов в точке
   * клика — видно, где плоскости проходят, а не только «где точка».
   */
  it('рисует XY-линии плоскостей срезов в точке клика на каждой проекции', () => {
    const reference = { x: 12, y: -34.5, z: 18 }

    for (const plane of PROJECTION_PLANES) {
      const view = renderProjection(plane, { reference })
      const at = projectPoint(plane, reference)
      const box = projectionBox(plane)
      const vertical = screen.getByTestId(`reference-plane-${plane}-vertical`)
      const horizontal = screen.getByTestId(`reference-plane-${plane}-horizontal`)

      // Линии проходят через точку клика: вертикаль — по её x, горизонталь — по её y
      expect(Number(vertical.getAttribute('x1'))).toBeCloseTo(at.x, 6)
      expect(Number(vertical.getAttribute('x2'))).toBeCloseTo(at.x, 6)
      expect(Number(horizontal.getAttribute('y1'))).toBeCloseTo(at.y, 6)
      expect(Number(horizontal.getAttribute('y2'))).toBeCloseTo(at.y, 6)
      // И тянутся по всей плоскости фигуры (внутри полей подписей), а не «штрихом»
      expect(Number(vertical.getAttribute('y1'))).toBeCloseTo(PROJECTION_PADDING, 6)
      expect(Number(vertical.getAttribute('y2'))).toBeCloseTo(box.height - PROJECTION_PADDING, 6)
      expect(Number(horizontal.getAttribute('x1'))).toBeCloseTo(PROJECTION_PADDING, 6)
      expect(Number(horizontal.getAttribute('x2'))).toBeCloseTo(box.width - PROJECTION_PADDING, 6)

      view.unmount()
    }
  })

  it('без точки клика перекрестия нет', () => {
    renderProjection('axial')

    expect(screen.queryByTestId('reference-axial')).not.toBeInTheDocument()
    expect(screen.queryByTestId('reference-plane-axial-vertical')).not.toBeInTheDocument()
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
    expect(screen.getByTestId('layer-playback-axial').querySelector('title')?.textContent).toContain(
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

  /**
   * Шлейф траектории (срез 3.7, поправка): затухающий «хвост» из измеренных
   * отрезков под маркером кадра — видно, каким путём диполь пришёл в кадр.
   */
  it('рисует затухающий шлейф к кадру по измеренным отрезкам', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 2 },
    })

    renderProjectionWithFrame('axial', { points: resultLayer(), dimmed: true })

    // Нарезка 1000 мс, окно шлейфа 10 с: к кадру эпохи 2 идут отрезки 0→1 и 1→2
    const older = screen.getByTestId('trail-segment-axial-0-1')
    const head = screen.getByTestId('trail-segment-axial-1-2')
    for (const segment of [older, head]) {
      expect(segment).toHaveAttribute('stroke', 'var(--color-mri-dipole)')
      expect(segment).toHaveAttribute('stroke-width', String(TRAIL_STROKE_PX))
    }
    // Шлейф гаснет с возрастом: у кадра плотнее, у хвоста прозрачнее
    expect(head).toHaveAttribute('stroke-opacity', String(TRAIL_ALPHA_HEAD))
    expect(Number(older.getAttribute('stroke-opacity'))).toBeLessThan(TRAIL_ALPHA_HEAD)
    // Шлейф лежит **под** маркером кадра, а не поверх него
    expect(screen.getByTestId('frame-trail-axial').nextElementSibling).toBe(
      screen.getByTestId('frame-halo-axial'),
    )
  })

  it('не рисует шлейф без кадра: шлейф принадлежит анимации, а не облаку', () => {
    // Кадр не задействован — шлейфа нет вовсе
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const idle = renderProjectionWithFrame('axial', { points: resultLayer() })
    expect(screen.queryByTestId('frame-trail-axial')).not.toBeInTheDocument()
    idle.unmount()

    // Кадр есть, а позиции выключены: шлейф остаётся — это свой слой анимации
    // (путь **кадра**), а не часть облака точек
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 2 },
    })
    renderProjectionWithFrame('axial', {
      points: resultLayer(),
      dimmed: true,
      visibility: visible({ dipoles: false }),
    })
    expect(screen.getByTestId('frame-trail-axial')).toBeInTheDocument()
    expect(screen.queryByTestId('layer-dipoles-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('frame-vector-axial')).toBeInTheDocument()
  })

  it('не рисует маркер кадра без кадра и слушается своего слоя, а не слоёв облака', () => {
    // Результат есть, но кадр не задействован: облако в обычном виде (приглушение —
    // решение раздела, а не часов: `dimmed` приходит пропсом)
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const idle = renderProjectionWithFrame('axial', { points: resultLayer() })
    expect(screen.queryByTestId('layer-playback-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('dipole-dot-axial-1-140')).toHaveAttribute('stroke-opacity', '1')
    idle.unmount()

    // Кадр задействован: эпоха выбрана, отсчёт времени не нужен — маркер стоит на
    // измеренной точке (доля нулевая, воспроизведение на паузе)
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 0 },
    })

    // Анимация — отдельный слой: при выключенных позициях и векторах кадр со своим
    // лучом остаётся (кадр — не облако), а вот выключенный слой анимации убирает всё
    const withoutCloudLayers = renderProjectionWithFrame('axial', {
      points: resultLayer(),
      dimmed: true,
      visibility: visible({ dipoles: false, vectors: false }),
    })
    expect(screen.getByTestId('frame-dot-axial')).toBeInTheDocument()
    expect(screen.getByTestId('frame-vector-axial')).toBeInTheDocument()
    withoutCloudLayers.unmount()

    renderProjectionWithFrame('axial', {
      points: resultLayer(),
      dimmed: true,
      visibility: visible({ playback: false }),
    })
    expect(screen.queryByTestId('layer-playback-axial')).not.toBeInTheDocument()
    expect(screen.queryByTestId('frame-dot-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('layer-dipoles-axial')).toBeInTheDocument()
  })
})

/** Пиксели фигуры для точки MNI аксиального среза (z = 0) — как считает компонент. */
function axialPx(x: number, y: number) {
  return normalizedToPx(mniToNormalized('axial', { x, y, z: 0 }), 'axial')
}

/**
 * Контуры атласа (срез 3.9): структуры и поля приходят полигонами в мм MNI.
 * Проверяется, что слой рисуется **из них**, хит-тест считает по тем же
 * полигонам (а не по «второму, невидимому» слою), а без ассета раздел остаётся
 * на условных эллипсах фикстуры.
 */
describe('контуры атласа в проекции', () => {
  it('рисует структуры и поля полигонами вместо условных эллипсов', () => {
    renderProjection('axial', { contours: contourSliceFixture() })

    expect(screen.getByTestId('layer-anatomy-axial')).toBeInTheDocument()
    const thalamus = screen.getByTestId('anatomy-axial-Left-Thalamus-Proper')
    expect(thalamus.getAttribute('d')).toMatch(/^M /)
    // Дырки приходят отдельными полигонами: заливка обязана быть even-odd
    expect(thalamus).toHaveAttribute('fill-rule', 'evenodd')
    expect(thalamus.querySelector('title')?.textContent).toContain('таламус (слева)')

    expect(screen.getByTestId('area-axial-BA17-lh')).toBeInTheDocument()
    // Фикстурных эллипсов при живом ассете нет вовсе — «двух анатомий» быть не должно
    expect(screen.queryByTestId(/^brodmann-axial-/)).not.toBeInTheDocument()
  })

  it('без ассета контуров остаётся на условных эллипсах фикстуры', () => {
    renderProjection('axial')

    expect(screen.queryByTestId('layer-anatomy-axial')).not.toBeInTheDocument()
    expect(screen.queryByTestId('area-axial-BA17-lh')).not.toBeInTheDocument()
    // Ассета нет — раздел не молчит, а рисует условную схему полей
    expect(screen.getAllByTestId(/^brodmann-axial-/).length).toBeGreaterThan(0)
  })

  it('клик по полигону отдаёт структуру и поле, считая по нарисованной геометрии', () => {
    const onPick = vi.fn()
    renderProjection('axial', { contours: contourSliceFixture(), onPick })
    const svg = stubFigure('axial')

    // Центр таламуса: квадрат x −30…−20, y −30…−20 мм (лежит внутри белого вещества)
    const thalamus = axialPx(-25, -25)
    fireEvent.click(svg, { clientX: thalamus.x, clientY: thalamus.y })
    // Мелкая метка важнее крупной: клик по таламусу не должен называть белое вещество
    expect(onPick).toHaveBeenLastCalledWith(expect.anything(), null, 'Left-Thalamus-Proper')

    // Центр BA17: отдельный квадрат x 10…30, y −55…−45 мм
    const area = axialPx(20, -50)
    fireEvent.click(svg, { clientX: area.x, clientY: area.y })
    expect(onPick).toHaveBeenLastCalledWith(expect.anything(), 'BA17-lh', null)
  })

  it('подписывает структуру под курсором', () => {
    renderProjection('axial', { contours: contourSliceFixture() })
    const svg = stubFigure('axial')
    const at = axialPx(-25, -25)

    fireEvent.mouseMove(svg, { clientX: at.x, clientY: at.y })

    // Подпись под фигурой: координаты и метка атласа (в `<title>` пути — своя строка)
    expect(screen.getByText(/^MNI .* · таламус \(слева\)$/)).toBeInTheDocument()
  })

  it('выключенный слой структур не рисуется, поля остаются', () => {
    renderProjection('axial', {
      contours: contourSliceFixture(),
      visibility: visible({ anatomy: false }),
    })

    expect(screen.queryByTestId('layer-anatomy-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('area-axial-BA17-lh')).toBeInTheDocument()
  })
})
