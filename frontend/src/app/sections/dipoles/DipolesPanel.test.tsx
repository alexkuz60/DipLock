/**
 * Тесты панели опций раздела «Диполи» (срез 3.1, расчёт — 3.4, форма фильтров — 3.6).
 *
 * Панель — единственное место, где пользователь настраивает просмотр и расчёт, и
 * она **ничего не запускает**: проверяем, что контролы меняют только состояние, а
 * из запросов возможны лишь статические метаданные (`/meta` — длины эпох и
 * диапазоны ритмов).
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
import { CALC_PARAM_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
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
      fftRangeHz: null,
      selectedPointId: null,
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

  it('включает слой анатомических структур отдельно от среза и полей (срез 3.9)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    const checkbox = screen.getByLabelText('Анатомические структуры')
    expect(checkbox).toBeChecked()

    await user.click(checkbox)

    expect(useDipoleParams.getState().params.layerVisibility.anatomy).toBe(false)
    // Срез МРТ и поля Бродмана — другие слои: их правка не следует за структурами
    expect(useDipoleParams.getState().params.layerVisibility.mri).toBe(true)
    expect(useDipoleParams.getState().params.layerVisibility.brodmann).toBe(true)
  })

  it('включает позиции диполей и векторы моментов отдельными слоями (срез 3.5)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    const vectors = screen.getByLabelText('Векторы моментов')
    expect(vectors).toBeChecked()

    await user.click(vectors)

    expect(useDipoleParams.getState().params.layerVisibility.vectors).toBe(false)
    // Позиции — другой слой: скрыть лучи не значит скрыть точки
    expect(useDipoleParams.getState().params.layerVisibility.dipoles).toBe(true)
    expect(screen.getByLabelText('Точки диполей')).toBeChecked()
  })

  it('включает слой анимации отдельно от облака (поправка 3.9)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    const playback = screen.getByLabelText('Кадр воспроизведения')
    expect(playback).toBeChecked()

    await user.click(playback)

    expect(useDipoleParams.getState().params.layerVisibility.playback).toBe(false)
    // Анимация — своя сущность: облако и его лучи не тронуты
    expect(useDipoleParams.getState().params.layerVisibility.dipoles).toBe(true)
    expect(useDipoleParams.getState().params.layerVisibility.vectors).toBe(true)
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

  it('выбирает полосу пресетами: диапазоны ритмов приходят из /meta (срез 3.6)', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesPanel />)

    const select = await screen.findByLabelText('Фильтр расчёта')
    // Подпись несёт границы с сервера — UI их не выдумывает
    expect(await screen.findByRole('option', { name: 'α — альфа 8–13 Гц' })).toBeInTheDocument()

    await user.selectOptions(select, 'alpha')

    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([8, 13])
    // Выбор пресета — не запуск: из запросов только метаданные
    const urls = fetchSpy.mock.calls.map(([input]) => String(input))
    expect(urls.every((url) => url.includes('/meta'))).toBe(true)
  })

  it('считает одиночную частоту полосой f ± bw/2 (срез 3.6)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    await user.selectOptions(await screen.findByLabelText('Фильтр расчёта'), 'single')

    // По умолчанию 7.83 Гц и ширина 0.5 Гц — полоса 7.6–8.1 Гц, и об этом сказано в итоге
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([7.6, 8.1])
    expect(
      screen.getByText(
        'В расчёт уйдёт: одиночная частота 7.83 Гц (полоса 7.6–8.1 Гц, ширина 0.5 Гц) · без сетевого фильтра',
      ),
    ).toBeInTheDocument()

    const freq = screen.getByLabelText('Одиночная частота')
    await user.clear(freq)
    await user.type(freq, '10')
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([9.8, 10.3])

    const width = screen.getByLabelText('Ширина полосы')
    await user.clear(width)
    await user.type(width, '1')
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([9.5, 10.5])
  })

  it('правит свой диапазон и сам ставит границы по возрастанию (срез 3.6)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    await user.selectOptions(await screen.findByLabelText('Фильтр расчёта'), 'custom')

    const from = screen.getByLabelText('Полоса от')
    const to = screen.getByLabelText('Полоса до')
    await user.clear(from)
    await user.type(from, '15')
    await user.clear(to)
    await user.type(to, '5')

    // Поля можно заполнять в любом порядке: полоса всё равно 5–15 Гц
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([5, 15])
  })

  it('держит «свой диапазон» открытым, даже если числа совпали с пресетом (срез 3.6)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    const select = await screen.findByLabelText('Фильтр расчёта')
    await user.selectOptions(select, 'custom')

    // Полоса по умолчанию (1–40 Гц) совпадает с «широким» пресетом: список не
    // должен «отскакивать» назад и прятать поля, иначе свою полосу не ввести
    expect(useDipoleCalc.getState().params.filterPreset).toBe('custom')
    expect(select).toHaveValue('custom')
    expect(screen.getByLabelText('Полоса от')).toHaveValue(1)
    expect(screen.getByLabelText('Полоса до')).toHaveValue(40)

    // Правка поля переводит полосу и остаётся «своим диапазоном»
    const to = screen.getByLabelText('Полоса до')
    await user.clear(to)
    await user.type(to, '35')
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([1, 35])
    expect(useDipoleCalc.getState().params.filterPreset).toBe('custom')
  })

  it('показывает выбор пользователя, а не догадку по числам (срез 3.6)', async () => {
    // Выбран «свой диапазон» с границами альфа-ритма: список показывает выбор,
    // а поля — те же числа (иначе непонятно, почему поля исчезли)
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS, filterPreset: 'custom', filterBandHz: [8, 13] },
    })
    renderWithProviders(<DipolesPanel />)

    expect(await screen.findByLabelText('Фильтр расчёта')).toHaveValue('custom')
    expect(screen.getByLabelText('Полоса от')).toHaveValue(8)
    expect(screen.getByLabelText('Полоса до')).toHaveValue(13)
  })

  it('выключает полосовой фильтр и ставит сетевой отдельно (срез 3.6)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    await user.selectOptions(await screen.findByLabelText('Фильтр расчёта'), 'none')
    expect(useDipoleCalc.getState().params.filterBandHz).toBeNull()

    await user.selectOptions(screen.getByLabelText('Сетевой фильтр'), '50')
    expect(useDipoleCalc.getState().params.notchHz).toBe(50)

    expect(
      screen.getByText('В расчёт уйдёт: без полосового фильтра · сетевой фильтр 50 Гц'),
    ).toBeInTheDocument()
  })

  it('помечает результат устаревшим, если полоса изменилась после расчёта (срез 3.6)', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      params: { ...CALC_PARAM_DEFAULTS, filterBandHz: [8, 13] },
    })
    renderWithProviders(<DipolesPanel />)

    expect(
      screen.getByText('Параметры расчёта изменены — результат не пересчитан'),
    ).toBeInTheDocument()
  })

  it('не пугает рассинхроном, когда результат посчитан на текущих параметрах (срез 3.6)', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<DipolesPanel />)

    expect(
      screen.queryByText('Параметры расчёта изменены — результат не пересчитан'),
    ).not.toBeInTheDocument()
  })

  it('окно уточнения выбирается списком, время оценивается по числам /meta (шаг 1.5)', async () => {
    mockApiFetch()
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    const select = screen.getByLabelText('Окно уточнения')
    // Дефолт — только пик GFP: окно ±10 мс стоило ≈80 с счёта, а не «точнее»
    expect(select).toHaveValue('0')
    // До расчёта частота записи неизвестна: число отсчётов окна не выдумывается
    await screen.findByText(/частота записи станет известна/)

    await user.selectOptions(select, '5')
    expect(useDipoleCalc.getState().refineHalfwinMs).toBe(5)

    // С результатом расчёта появляется ожидаемое время — по числам сервера
    useDipoleCalc.setState({ result: dipoleScanResultFixture({ sfreq: 500 }) })
    await screen.findByText(/Ожидаемое время ≈/)
    expect(screen.getByText(/свободный фит 5 отсч\./)).toBeInTheDocument()
  })
})
