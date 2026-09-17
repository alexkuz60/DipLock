/**
 * Тесты рабочей области раздела «Диполи» (срез 3.1, срез МРТ — 3.2).
 *
 * Проверяют главное правило раздела: UI показывает геометрию и **ничего не
 * запускает** (расчёт — отдельная задача; из запросов допустимы только
 * метаданные), а клик по проекции наводит все три среза на выбранную точку.
 */
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PROJECTION_PLANES,
  applyPointToSlices,
  defaultSlices,
  mniToNormalized,
  normalizedToPx,
  projectionBox,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'
import { CALC_PARAM_DEFAULTS, PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { FRAME_DIM_OPACITY } from '@/shared/lib/dipolePoints'
import {
  DIPOLE_PARAM_DEFAULTS,
  EMPTY_SELECTION,
  useDipoleParams,
} from '@/shared/state/dipoleParams'
import { dipoleScanResultFixture, contourSliceFixture } from '@/test/fixtures'
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

/**
 * Запросы раздела — только статика: метаданные, срезы МРТ и контуры атласа.
 * Ни одного запуска обработки (`/jobs`, `/analyze`, `/recordings`) быть не должно.
 */
function staticAsset(path: string): boolean {
  return path.startsWith('/api/v1/meta') || path.startsWith('/api/v1/surface')
}

describe('рабочая область раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleParams.setState({
      params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
      selection: EMPTY_SELECTION,
    })
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS },
      amplitudeThresholdNam: 0,
      fftRangeHz: null,
      selectedPointId: null,
      playback: { ...PLAYBACK_DEFAULTS },
      job: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      error: null,
      spectrumError: null,
      view: 'none',
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

  it('просит только статические ассеты и никогда не запускает обработку', async () => {
    const fetchMock = mockApiFetch()
    vi.stubGlobal('fetch', fetchMock)
    renderWithProviders(<DipolesSection />)
    const svg = stubFigure('coronal')

    fireEvent.click(svg, { clientX: 140, clientY: 180 })

    // Контуры атласа (срез 3.9) — статические ассеты: дожидаемся, что запросы
    // действительно ушли, иначе проверка «только статика» была бы о времени.
    expect(await screen.findByText('Контуры атласа недоступны')).toBeInTheDocument()

    const paths = fetchMock.mock.calls.map(([path]) => String(path))
    expect(paths.every((path) => staticAsset(path))).toBe(true)
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

  it('рисует точки из результата расчёта и подчиняется порогу «КД» (срез 3.4)', () => {
    // Фикстура: четыре точки, одна без MNI, амплитуды 60 / 25 / 90 нАм.
    // Порог 60 пропускает на проекции две точки — слой фильтруется, но результат
    // задачи остаётся нетронутым (порог — параметр отображения).
    useDipoleCalc.setState({ result: dipoleScanResultFixture(), amplitudeThresholdNam: 60 })
    renderWithProviders(<DipolesSection />)

    for (const plane of ['axial', 'sagittal', 'coronal'] as const) {
      expect(screen.getAllByTestId(new RegExp(`^dipole-dot-${plane}-`))).toHaveLength(2)
    }
    expect(screen.getByText('Точек диполей: 2')).toBeInTheDocument()
    expect(screen.getByText('Скрыто порогом «КД ≥ 60 нАм»: 1')).toBeInTheDocument()
    expect(screen.getByText(/Быстрый режим, сетка 7 мм · эпох 4 из 4/)).toBeInTheDocument()
    expect(
      screen.getByText('Часть точек без MNI (fsaverage недоступен) — на проекции не попадают'),
    ).toBeInTheDocument()
  })

  it('считает порог по слою, а не по задаче, и снимается нулём', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture(), amplitudeThresholdNam: 200 })
    renderWithProviders(<DipolesSection />)

    // Порог выше всех амплитуд: ни одной точки, но расчёт на месте
    expect(screen.queryAllByTestId(/^dipole-dot-axial-/)).toHaveLength(0)
    expect(screen.getByText('Скрыто порогом «КД ≥ 200 нАм»: 3')).toBeInTheDocument()
    expect(screen.getByText(/Быстрый режим, сетка 7 мм/)).toBeInTheDocument()
  })

  /**
   * Выделение диполя (срез 3.5, поправка ручной проверки): выбор в одной проекции
   * синхронизируется во всех трёх **и** наводит срезы на позицию диполя — срезы
   * обязаны меняться при любом клике по фигуре.
   */
  it('выделяет диполь во всех проекциях и наводит срезы на его позицию', () => {
    const fetchSpy = mockApiFetch()
    vi.stubGlobal('fetch', fetchSpy)
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<DipolesSection />)

    fireEvent.click(screen.getByTestId('dipole-hit-sagittal-0-120'))

    for (const plane of ['axial', 'sagittal', 'coronal'] as const) {
      expect(screen.getByTestId(`dipole-${plane}-0-120`)).toHaveAttribute('data-selected', 'true')
      expect(screen.getByTestId(`dipole-${plane}-1-140`)).toHaveAttribute('data-selected', 'false')
    }
    expect(useDipoleCalc.getState().selectedPointId).toBe('0-120')
    // Подпись выбора: у подсветки на фигуре есть читаемый текст
    expect(screen.getByText(/Выделен диполь: Эпоха 1, 0.120 с/)).toBeInTheDocument()
    // Выделенный диполь залит оранжево-жёлтым, остальные — белые кольца без заливки
    expect(screen.getByTestId('dipole-dot-sagittal-0-120')).toHaveAttribute(
      'fill',
      'var(--color-mri-dipole)',
    )
    expect(screen.getByTestId('dipole-dot-sagittal-1-140')).toHaveAttribute('fill', 'none')

    // Срезы навелись на позицию диполя (первая точка фикстуры: MNI 12 / -34.5 / 18)
    const position = { x: 12, y: -34.5, z: 18 }
    expect(useDipoleParams.getState().selection.point).toEqual(position)
    expect(useDipoleParams.getState().params.slices).toEqual(applyPointToSlices(position).slices)
    // Выделение — чистая перерисовка: новых запросов нет
    const paths = fetchSpy.mock.calls.map(([path]) => String(path))
    expect(paths.every((path) => path.startsWith('/api/v1/meta'))).toBe(true)
  })

  it('снимает выделение повторным кликом и кнопкой «Снять выделение»', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<DipolesSection />)

    fireEvent.click(screen.getByTestId('dipole-hit-axial-1-140'))
    expect(screen.getByTestId('dipole-coronal-1-140')).toHaveAttribute('data-selected', 'true')

    await user.click(screen.getByRole('button', { name: 'Снять выделение' }))

    expect(useDipoleCalc.getState().selectedPointId).toBeNull()
    expect(screen.queryByText(/Выделен диполь:/)).not.toBeInTheDocument()
    for (const plane of ['axial', 'sagittal', 'coronal'] as const) {
      expect(screen.getByTestId(`dipole-${plane}-1-140`)).toHaveAttribute('data-selected', 'false')
    }
  })

  it('подсвечивает выделенный диполь и после подъёма порога «КД»', () => {
    // Порог скрывает точку из отрисовки, но выделение не должно «теряться» в
    // подписи: выбор сделан раньше, а порог — параметр отображения
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      amplitudeThresholdNam: 500,
      selectedPointId: '0-120',
    })
    renderWithProviders(<DipolesSection />)

    expect(screen.getByText(/Выделен диполь: Эпоха 1, 0.120 с/)).toBeInTheDocument()
  })

  /**
   * Кадр воспроизведения (срез 3.7): раздел отдаёт проекциям **признак** кадра
   * (`dimmed`), а сам кадр раздают часы. Интерполяция — отображение, поэтому кадр
   * синхронен во всех трёх проекциях и не делает ни одного запроса.
   */
  it('показывает кадр воспроизведения в трёх проекциях и приглушает облако', () => {
    const fetchSpy = mockApiFetch()
    vi.stubGlobal('fetch', fetchSpy)
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      // Эпоха 1 (в подписи — вторая): кадр стоит на измеренной точке, пауза
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 1 },
    })
    renderWithProviders(<DipolesSection />)

    for (const plane of ['axial', 'sagittal', 'coronal'] as const) {
      expect(screen.getByTestId(`layer-playback-${plane}`)).toBeInTheDocument()
      expect(screen.getByTestId(`dipole-dot-${plane}-0-120`)).toHaveAttribute(
        'stroke-opacity',
        String(FRAME_DIM_OPACITY),
      )
      // Шлейф идёт к кадру во всех трёх проекциях: к эпохе 1 ведёт один отрезок 0→1
      expect(screen.getAllByTestId(new RegExp(`^trail-segment-${plane}-`))).toHaveLength(1)
    }
    expect(screen.getByTestId('layer-playback-axial').querySelector('title')?.textContent).toContain(
      'Кадр воспроизведения: Эпоха 2',
    )
    // Кадр — чистая перерисовка: раздел по-прежнему просит только статику
    const paths = fetchSpy.mock.calls.map(([path]) => String(path))
    expect(paths.every((path) => staticAsset(path))).toBe(true)
    expect(paths.some((path) => /jobs|preprocess|analyze|recordings/.test(path))).toBe(false)
  })

  it('держит облако в обычном виде, пока кадр воспроизведения не задействован', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<DipolesSection />)

    expect(screen.queryByTestId('layer-playback-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('dipole-dot-axial-0-120')).toHaveAttribute('stroke-opacity', '1')
  })

  it('убирает анимацию выключенным слоем «Кадр воспроизведения», не трогая облако', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 1 },
    })
    useDipoleParams.setState({
      params: {
        ...DIPOLE_PARAM_DEFAULTS,
        layerVisibility: { ...DIPOLE_PARAM_DEFAULTS.layerVisibility, playback: false },
      },
    })
    renderWithProviders(<DipolesSection />)

    // Анимация — свой слой: выключили её, облако осталось в обычном виде
    expect(screen.queryByTestId('layer-playback-axial')).not.toBeInTheDocument()
    expect(screen.getByTestId('dipole-dot-axial-0-120')).toHaveAttribute('stroke-opacity', '1')
  })

  /**
   * Пояснения — в справке тулс-хедера (`DipolesHelpDialog`), а не абзацем под
   * фигурами: рабочая область показывает данные и полосу состояния с числами.
   */
  it('не объясняет фигуры абзацем в рабочей области', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<DipolesSection />)

    expect(screen.queryByText(/подсвечивает их во всех проекциях/)).not.toBeInTheDocument()
    expect(screen.queryByText(/быстрым режимом \(одна точка на эпоху/)).not.toBeInTheDocument()
    // Полоса состояния при этом на месте: текст ушёл, числа остались
    expect(screen.getByTestId('projection-axial')).toBeInTheDocument()
  })

  /**
   * Контуры атласа (срез 3.9): статический ассет по срезу каждой плоскости.
   * Проверяем и отрисовку, и то, что это **не** обработка: уходят GET-запросы на
   * `/surface/contours`, срез квантуется к сетке атласа, версия — в `?v=`.
   */
  it('рисует контуры атласа из статического ассета и называет структуру под кликом', async () => {
    const fetchMock = mockApiFetch({ contours: contourSliceFixture() })
    vi.stubGlobal('fetch', fetchMock)
    renderWithProviders(<DipolesSection />)

    expect(await screen.findByTestId('anatomy-axial-Left-Thalamus-Proper')).toBeInTheDocument()
    expect(screen.getByTestId('area-axial-BA17-lh')).toBeInTheDocument()
    // Мок отдаёт метки только для той плоскости, что в фикстуре (axial)
    expect(screen.getByText('Атлас: структур 2, полей 1')).toBeInTheDocument()

    const paths = fetchMock.mock.calls.map(([path]) => String(path))
    expect(paths).toContain('/api/v1/surface/contours/axial/0?v=cont12345678')
    expect(paths.every((path) => staticAsset(path))).toBe(true)

    const svg = stubFigure('axial')
    const at = normalizedToPx(mniToNormalized('axial', { x: -25, y: -25, z: 0 }), 'axial')
    fireEvent.click(svg, { clientX: at.x, clientY: at.y })

    expect(await screen.findByText('Структура под точкой: таламус (слева)')).toBeInTheDocument()
  })
})
