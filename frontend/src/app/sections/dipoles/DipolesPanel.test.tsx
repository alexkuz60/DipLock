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
import { useEdfRecording } from '@/shared/state/edfRecording'
import { dipoleScanResultFixture, recordingFixture } from '@/test/fixtures'
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
      gofThresholdPercent: 0,
      amplitudeThresholdNam: 0,
      fftRangeHz: null,
      selectedPointId: null,
      batchJob: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      batchError: null,
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
    expect(screen.getByLabelText('Границы мозга')).toBeChecked()
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

  it('пороги отображения скрывают слабые диполи и сообщают, сколько скрыто', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture(), amplitudeThresholdNam: 50 })
    renderWithProviders(<DipolesPanel />)

    // В фикстуре три точки с MNI (60, 25, 90 нАм): порог 50 скрывает одну
    expect(screen.getByText('Скрыто порогами «момент ≥ 50 нАм»: 1 из 3')).toBeInTheDocument()
    expect(screen.getByText('Точек диполей: 2')).toBeInTheDocument()
    expect(screen.getByText('Эпох в расчёте: 4 из 4')).toBeInTheDocument()
  })

  it('порог GOF (основной) скрывает по GOF и подписывается в счётчике', () => {
    // gof всех точек фикстуры = 0.91 → 95% скрывает все три
    useDipoleCalc.setState({ result: dipoleScanResultFixture(), gofThresholdPercent: 95 })
    renderWithProviders(<DipolesPanel />)

    expect(screen.getByText('Скрыто порогами «GOF ≥ 95 %»: 3 из 3')).toBeInTheDocument()
  })

  it('кнопка «Сбросить расчёт» убирает результат, но не параметры', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<DipolesPanel />)

    await user.click(screen.getByRole('button', { name: 'Сбросить расчёт' }))

    expect(useDipoleCalc.getState().result).toBeNull()
    expect(useDipoleCalc.getState().params.epochLengthMs).toBe(1000)
  })

  it('формы полосы фильтра больше нет: пакет фильтруется своими полосами (срез 3.6 убран)', async () => {
    renderWithProviders(<DipolesPanel />)

    // Одиночный расчёт по всему спектру убран: пресеты δ…γ, «одиночная частота»
    // и «свой диапазон» жили только под него
    expect(screen.queryByLabelText('Фильтр расчёта')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Одиночная частота')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Полоса от')).not.toBeInTheDocument()
    expect(
      screen.getByText(/Пакет диполей считается по всем полосам каталога/),
    ).toBeInTheDocument()
  })

  it('ставит сетевой фильтр отдельно от полос пакета (срез 3.6)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesPanel />)

    await user.selectOptions(await screen.findByLabelText('Сетевой фильтр'), '50')
    expect(useDipoleCalc.getState().params.notchHz).toBe(50)

    expect(
      screen.getByText(/Пакет диполей считается по всем полосам каталога/),
    ).toBeInTheDocument()
  })

  it('помечает результат устаревшим, если параметры изменились после расчёта (срез 3.6)', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      params: { ...CALC_PARAM_DEFAULTS, notchHz: 50 },
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

  it('метод PSD переключается без запросов и не помечает дипольный результат устаревшим (N17)', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      params: { ...CALC_PARAM_DEFAULTS },
    })
    renderWithProviders(<DipolesPanel />)

    await user.click(screen.getByRole('button', { name: 'Multitaper' }))

    expect(useDipoleCalc.getState().params.psdMethod).toBe('multitaper')
    // Метод уходит только в задачу спектра: диполи от него не считаются,
    // и их результат не «устаревает»
    expect(screen.queryByText('Параметры расчёта изменены — результат не пересчитан')).toBeNull()
    const urls = fetchSpy.mock.calls.map(([input]) => String(input))
    expect(urls.filter((url) => !url.includes('/meta'))).toEqual([])
  })

  it('две половины правила (≥ 2 периодов и ≥ 3C) видны у длины эпохи (п.4)', async () => {
    // Запись: 10 каналов монтажа при 100 Гц → 3C = 30 отсчётов → минимум 300 мс
    useEdfRecording.setState({ recording: { ...recordingFixture, sfreq: 100 } })
    useDipoleCalc.setState({ params: { ...CALC_PARAM_DEFAULTS, epochLengthMs: 250 } })
    mockApiFetch()
    renderWithProviders(<DipolesPanel />)

    const warnings = await screen.findByTestId('epoch-rule-warnings')
    // 250 мс при 100 Гц = 25 отсчётов — меньше 3C (3 × 10 = 30 отсчётов)
    expect(warnings).toHaveTextContent('3 × 10 = 30 отсчётов')
    // Медленная полоса каталога (δ 0.5 Гц, нормировка на 1 Гц): 250 мс < 2 периодов
    // (минимум 2000 мс) — правило читается по самой медленной полосе пакета и
    // дожидается каталога из `/meta`
    await waitFor(() =>
      expect(warnings).toHaveTextContent('двух периодов нижней частоты полосы'),
    )
  })
})
