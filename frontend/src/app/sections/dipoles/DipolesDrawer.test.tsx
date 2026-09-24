/**
 * Тесты выдвижной панели раздела «Диполи» (срез 3.4): топокарты и FFT.
 *
 * Проверяется главное правило и контракт с сервером: панель ничего не считает
 * сама, спектр запускается **только кнопкой**, а URL картинок топокарт несёт
 * параметры того расчёта, чьи числа показаны (включая порог reject и версию
 * ассета) — иначе браузер показал бы картинку прошлого фильтра.
 */
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { calcJobFixture, recordingFixture, spectrumResultFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DipolesDrawer } from './DipolesDrawer'

describe('выдвижная панель раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      view: 'none',
      amplitudeThresholdNam: 0,
      fftRangeHz: null,
      selectedPointId: null,
      params: { ...CALC_PARAM_DEFAULTS },
      job: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      error: null,
      spectrumError: null,
    })
    useEdfRecording.setState({ recording: null })
  })

  it('закрыта — не рисует ничего', () => {
    renderWithProviders(<DipolesDrawer />)
    expect(screen.queryByTestId('dipoles-drawer')).not.toBeInTheDocument()
  })

  it('топокарты: картинки с параметрами именно этого расчёта и версией ассета', () => {
    useDipoleCalc.setState({ view: 'topomap', spectrum: spectrumResultFixture() })
    renderWithProviders(<DipolesDrawer />)

    const alpha = screen.getByAltText('Топокарта α — альфа (8–13 Гц)')
    expect(alpha.getAttribute('src')).toBe(
      '/api/v1/recordings/rec-1/spectrum/topomap/alpha.png?band_min=1&band_max=40&epoch_length_ms=1000&psd_method=welch&v=spec1234abcd',
    )
    // Мощность подписана рядом с картинкой; неизмеренная — «—», а не «0.00»
    expect(screen.getByText(/8–13 Гц · 12.50 мкВ² · 55 %/)).toBeInTheDocument()
    expect(screen.getByText(/30–40 Гц · — мкВ²/)).toBeInTheDocument()
    expect(screen.getAllByTestId(/^topomap-/)).toHaveLength(5)
  })

  it('без спектра объясняет и запускает расчёт только по кнопке', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({ view: 'topomap' })
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesDrawer />)

    // До нажатия — ни одного запроса: панель не считает по факту открытия
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText('Спектр не рассчитан')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Рассчитать спектр' }))

    const urls = fetchSpy.mock.calls.map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/spectrum')
    expect(await screen.findAllByAltText(/Топокарта/)).toHaveLength(5)
  })

  it('кнопка расчёта выключена без записи и объясняет причину', async () => {
    useDipoleCalc.setState({ view: 'fft' })
    renderWithProviders(<DipolesDrawer />)

    const button = screen.getByRole('button', { name: 'Рассчитать спектр' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('загрузите EDF'))
  })

  it('FFT: полосы по диапазонам и ломаная PSD', () => {
    useDipoleCalc.setState({ view: 'fft', spectrum: spectrumResultFixture() })
    renderWithProviders(<DipolesDrawer />)

    expect(screen.getByTestId('fft-histogram')).toBeInTheDocument()
    for (const band of ['delta', 'theta', 'alpha', 'beta', 'gamma']) {
      expect(screen.getByTestId(`fft-bar-${band}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('fft-psd-line')).toBeInTheDocument()
    // Подпись — параметры именно этого расчёта (полоса,эпоха, окно, эпохи)
    expect(
      screen.getByText('Спектр: 1–40 Гц · эпоха 1000 мс · Welch · окно 250 · эпох 4'),
    ).toBeInTheDocument()
  })

  it('FFT: фон 1/f пунктиром и маркеры пиков над ним (specparam)', () => {
    useDipoleCalc.setState({ view: 'fft', spectrum: spectrumResultFixture() })
    renderWithProviders(<DipolesDrawer />)

    const background = screen.getByTestId('fft-aperiodic-line')
    expect(background).toBeInTheDocument()
    // Фон рисуется той же сеткой частот, что и PSD
    expect((background.getAttribute('points') ?? '').split(' ').filter(Boolean)).toHaveLength(7)
    // Пик α 10.2 Гц из фикстуры — вертикальная метка с подписью центра
    const peak = screen.getByTestId('fft-peak-0')
    expect(peak).toHaveTextContent('10.2')
    // Пики схлопываются в null-поля — фон и метки не рисуются («не измерено»)
    useDipoleCalc.setState({
      spectrum: spectrumResultFixture({ peaks: [], aperiodic_fit_uv2: [] }),
    })
    renderWithProviders(<DipolesDrawer />)
    expect(screen.queryByTestId('fft-aperiodic-line')).not.toBeInTheDocument()
    expect(screen.queryByTestId('fft-peak-0')).not.toBeInTheDocument()
  })

  /**
   * Окно частот (срез 3.5) — интерактивное сужение АЧХ. Оно ничего не считает и
   * ничего не запрашивает: числа PSD уже в браузере, а сервер пересчитывается
   * только кнопкой.
   */
  it('сужает FFT-график по ритму и возвращает весь диапазон без запросов', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    useDipoleCalc.setState({ view: 'fft', spectrum: spectrumResultFixture() })
    renderWithProviders(<DipolesDrawer />)

    const pointsOf = () =>
      (screen.getByTestId('fft-psd-line').getAttribute('points') ?? '').split(' ').filter(Boolean)
    // В фикстуре 7 посчитанных частот: 1, 4, 8, 10, 13, 30, 40
    expect(pointsOf()).toHaveLength(7)
    expect(screen.getByTestId('fft-window-label')).toHaveTextContent('Весь диапазон: 1–40 Гц')

    await user.click(screen.getByTestId('fft-range-alpha'))

    // Окно сузилось до альфа-ритма: на ломаной остались только его частоты
    expect(pointsOf()).toHaveLength(3)
    expect(screen.getByTestId('fft-window-label')).toHaveTextContent('Показано 8–13 Гц из 1–40 Гц')
    expect(screen.getByTestId('fft-bar-alpha')).toHaveAttribute('data-in-range', 'true')
    expect(screen.getByTestId('fft-bar-delta')).toHaveAttribute('data-in-range', 'false')
    // Полосы вне окна остаются на месте (приглушены), а не исчезают: видно, что
    // ещё входит в запись
    expect(screen.getByTestId('fft-bar-gamma')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Весь диапазон' }))

    expect(pointsOf()).toHaveLength(7)
    expect(screen.getByTestId('fft-window-label')).toHaveTextContent('Весь диапазон: 1–40 Гц')
    expect(useDipoleCalc.getState().fftRangeHz).toBeNull()
  })

  it('правит окно полями «от/до» и зажимает его в измеренные частоты', async () => {
    useDipoleCalc.setState({ view: 'fft', spectrum: spectrumResultFixture() })
    renderWithProviders(<DipolesDrawer />)

    fireEvent.change(screen.getByLabelText('Окно от, Гц'), { target: { value: '8' } })
    expect(useDipoleCalc.getState().fftRangeHz).toEqual([8, 40])

    fireEvent.change(screen.getByLabelText('Окно до, Гц'), { target: { value: '13' } })
    expect(useDipoleCalc.getState().fftRangeHz).toEqual([8, 13])
    expect(screen.getByTestId('fft-window-label')).toHaveTextContent('Показано 8–13 Гц из 1–40 Гц')

    // Границы вне посчитанных частот зажимаются: окно [30, 999] → [30, 40]
    fireEvent.change(screen.getByLabelText('Окно до, Гц'), { target: { value: '999' } })
    fireEvent.change(screen.getByLabelText('Окно от, Гц'), { target: { value: '30' } })
    expect(screen.getByTestId('fft-window-label')).toHaveTextContent('Показано 30–40 Гц из 1–40 Гц')

    // Окно уже измеренной частоты честно сообщает, что частот в нём нет
    fireEvent.change(screen.getByLabelText('Окно до, Гц'), { target: { value: '29' } })
    fireEvent.change(screen.getByLabelText('Окно от, Гц'), { target: { value: '14' } })
    expect(screen.getByTestId('fft-empty-window')).toBeInTheDocument()
    expect(screen.queryByTestId('fft-psd-line')).not.toBeInTheDocument()
  })

  it('показывает предупреждение о каналах без позиций в монтаже', () => {
    useDipoleCalc.setState({
      view: 'topomap',
      spectrum: spectrumResultFixture({ missed_channels: ['T7'] }),
    })
    renderWithProviders(<DipolesDrawer />)

    expect(
      screen.getByText(/Без позиции в монтаже \(в топокарты не попали\): T7/),
    ).toBeInTheDocument()
  })

  it('кнопка «Закрыть панель» возвращает вид в «закрыто»', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({ view: 'topomap', spectrum: spectrumResultFixture() })
    renderWithProviders(<DipolesDrawer />)

    await user.click(screen.getByRole('button', { name: 'Закрыть выдвижную панель' }))

    expect(useDipoleCalc.getState().view).toBe('none')
    expect(screen.queryByTestId('dipoles-drawer')).not.toBeInTheDocument()
  })

  it('показывает ошибку спектра, если он так и не рассчитался', () => {
    useDipoleCalc.setState({ view: 'fft', spectrumError: 'Данные fsaverage недоступны' })
    renderWithProviders(<DipolesDrawer />)

    // Плашка состояния и заголовок блока ошибки — оба про одно: спектра нет
    expect(screen.getAllByText('Спектр не рассчитан')).toHaveLength(2)
    expect(screen.getByText('Данные fsaverage недоступны')).toBeInTheDocument()
  })

  it('ошибка расчёта диполей не выдаётся за ошибку спектра', () => {
    // Общий текст ошибки объяснял бы сбой диполей словами «спектр не рассчитан»
    useDipoleCalc.setState({ view: 'fft', error: 'Ни одной эпохи не удалось локализовать' })
    renderWithProviders(<DipolesDrawer />)

    expect(screen.queryByText('Ни одной эпохи не удалось локализовать')).not.toBeInTheDocument()
    expect(screen.getByText(/Спектр не рассчитан: нажмите/)).toBeInTheDocument()
  })

  it('не прячет ошибку пересчёта за прежним результатом', () => {
    useDipoleCalc.setState({
      view: 'fft',
      spectrum: spectrumResultFixture(),
      spectrumError: 'Том fsaverage недоступен',
    })
    renderWithProviders(<DipolesDrawer />)

    expect(
      screen.getByText(/последний запуск завершился ошибкой — Том fsaverage недоступен/),
    ).toBeInTheDocument()
    expect(screen.getByTestId('fft-histogram')).toBeInTheDocument()
  })
})
