/**
 * Тесты тулс-хедера раздела «Диполи» (срез 3.4).
 *
 * Проверяется правило «обработка — только по кнопке»: расчёт запускается
 * нажатием и показывается прогрессом по эпохам, порог «КД ≥ X нАм» правит
 * отображение (без единого запроса), а кнопки панелей лишь открывают одну
 * выдвижную панель за раз.
 */
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS, PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { calcJobFixture, dipoleScanResultFixture, recordingFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DipolesToolHeaderActions } from './DipolesToolActions'

type FetchCall = [input: unknown, init?: RequestInit]

/**
 * Запросы, которые **что-то считают на сервере**. Статический `/meta` (оценка
 * времени уточнения — шаг 1.5) в счёт не идёт: хедер читает его всегда, а
 * правило «правка параметра ничего не запускает» проверяется по задачам.
 */
function stateCalls(fetchSpy: { mock: { calls: FetchCall[] } }): FetchCall[] {
  return fetchSpy.mock.calls.filter(([input]) => !String(input).includes('/meta'))
}

describe('тулс-хедер раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      view: 'none',
      amplitudeThresholdNam: 0,
      params: { ...CALC_PARAM_DEFAULTS },
      playback: { ...PLAYBACK_DEFAULTS },
      job: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      error: null,
      spectrumError: null,
      refineJob: null,
      refiningEpoch: null,
      refinedPoints: {},
      refineError: null,
      selectedPointId: null,
    })
    useEdfRecording.setState({ recording: null })
  })

  it('без записи кнопка расчёта выключена и объясняет причину', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    const button = screen.getByRole('button', { name: 'Рассчитать диполи' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('загрузите EDF'))

    await user.click(button)
    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('запускает расчёт кнопкой: задача, поллинг и точки в состоянии', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Рассчитать диполи' }))

    const urls = stateCalls(fetchSpy).map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/dipoles')
    expect(useDipoleCalc.getState().result?.points).toHaveLength(4)
    // Кнопка меняет подпись: результат есть — предлагается пересчёт
    expect(screen.getByRole('button', { name: 'Пересчитать диполи' })).toBeInTheDocument()
    expect(screen.getByText('Быстрый режим: 4 точек')).toBeInTheDocument()
  })

  it('показывает прогресс по эпохам, пока задача идёт', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      job: {
        status: 'running',
        progress: 0.5,
        message: 'Диполи: 2 из 4',
        stage: 'scan',
        epochsDone: 2,
        epochsTotal: 4,
        error: null,
      },
    })
    renderWithProviders(<DipolesToolHeaderActions />)

    const bar = screen.getByRole('progressbar', { name: 'Прогресс расчёта диполей' })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText('эпох 2/4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Расчёт…' })).toBeDisabled()
  })

  it('порог «КД ≥» меняет состояние отображения и не делает запросов', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    const field = screen.getByLabelText('Порог момента диполя, нАм')
    await user.clear(field)
    await user.type(field, '60')

    expect(useDipoleCalc.getState().amplitudeThresholdNam).toBe(60)
    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('отправляет полосу и сетевой фильтр из панели в задачу (срез 3.6)', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS, filterPreset: 'alpha', filterBandHz: [8, 13], notchHz: 50 },
    })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Рассчитать диполи' }))

    // Полоса формы фильтров уходит в задачу как band_min/band_max — не «где-то
    // в состоянии, но не в запросе»
    const [, init] = stateCalls(fetchSpy)[0]
    const form = init?.body as FormData
    expect(form.get('band_min')).toBe('8')
    expect(form.get('band_max')).toBe('13')
    expect(form.get('notch_hz')).toBe('50')
  })

  it('кнопки панелей открывают одну выдвижную панель за раз', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Топокарты ритмов' }))
    expect(useDipoleCalc.getState().view).toBe('topomap')

    await user.click(screen.getByRole('button', { name: 'FFT-гистограмма' }))
    expect(useDipoleCalc.getState().view).toBe('fft')

    await user.click(screen.getByRole('button', { name: 'FFT-гистограмма' }))
    expect(useDipoleCalc.getState().view).toBe('none')
  })

  /**
   * Кадр воспроизведения (срез 3.7): шапка отправляет **команды** в состояние, а
   * сам кадр ведут часы в рабочей области. Без результата расчёта командовать
   * нечем — кнопки выключены.
   */
  it('выключает кнопки кадра без расчёта', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    expect(screen.getByRole('button', { name: 'Воспроизведение траектории' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Предыдущая эпоха' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Следующая эпоха' })).toBeDisabled()
    // Снимать нечего: кнопки снятия кадра и подписи кадра нет вовсе
    expect(screen.queryByRole('button', { name: 'Снять кадр' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Следующая эпоха' }))
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(0)
    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('играет, шагает покадрово и меняет скорость — без запросов к серверу', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Воспроизведение траектории' }))
    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: true, active: true })
    // Играющая кнопка меняет доступное имя: пауза — это то же действие
    const pause = screen.getByRole('button', { name: 'Пауза воспроизведения' })
    expect(pause).toHaveClass('bg-accent-soft')

    await user.click(screen.getByRole('button', { name: 'Следующая эпоха' }))
    // Покадровый шаг ставит на паузу: кадр остаётся на выбранной эпохе
    expect(useDipoleCalc.getState().playback).toMatchObject({
      playing: false,
      active: true,
      epochIndex: 1,
    })

    // Скорость — выпадающим списком (поправка ручной проверки: экономия места в хедере)
    const speed = screen.getByLabelText('Скорость воспроизведения')
    expect(within(speed).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '×0.25',
      '×0.5',
      '×1',
      '×2',
      '×4',
    ])
    expect(speed).toHaveValue('1')

    await user.selectOptions(speed, '4')
    expect(useDipoleCalc.getState().playback.speed).toBe(4)
    expect(speed).toHaveValue('4')

    // Замедление (поправка ручной проверки): ×0.25 и ×0.5 — чтобы успеть прочитать подписи
    await user.selectOptions(speed, '0.25')
    expect(useDipoleCalc.getState().playback.speed).toBe(0.25)
    await user.selectOptions(speed, '0.5')
    expect(useDipoleCalc.getState().playback.speed).toBe(0.5)
    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('подписывает текущий кадр и снимает его отдельной кнопкой', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 2 },
    })
    renderWithProviders(<DipolesToolHeaderActions />)

    // Нарезка 1000 мс: третья эпоха начинается на 2.00 с
    expect(screen.getByText('Кадр: эпоха 3 из 4 · 2.00 с · ×1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Снять кадр' }))

    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: false, active: false })
    expect(screen.queryByText(/^Кадр: эпоха/)).not.toBeInTheDocument()
  })

  /**
   * Справка (поправка ручной проверки): пояснения к фигурам читают один-два раза
   * за сеанс, поэтому они открываются диалогом по кнопке, а не занимают рабочую
   * область абзацем. Диалог — чистое состояние: ни одного запроса.
   */
  it('открывает справку кнопкой и закрывает её Esc — без запросов', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    expect(screen.queryByTestId('dipoles-help-dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Справка' }))

    const dialog = screen.getByTestId('dipoles-help-dialog')
    // В справке названы и метод расчёта, и производность BA-разметки: UI не
    // обещает точности, которой у быстрого режима нет
    expect(within(dialog).getByText(/перебор узлов объёмной сетки/)).toBeInTheDocument()
    expect(within(dialog).getByTestId('dipoles-help-note')).toHaveTextContent('nearest_cortex_vertex')
    expect(within(dialog).getByText(/Кадр идёт по сетке эпох результата/)).toBeInTheDocument()
    expect(stateCalls(fetchSpy)).toEqual([])

    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('dipoles-help-dialog')).not.toBeInTheDocument()

    // Повторное открытие и закрытие кнопкой — тоже без запросов
    await user.click(screen.getByRole('button', { name: 'Справка' }))
    await user.click(screen.getByRole('button', { name: 'Закрыть справку' }))
    expect(screen.queryByTestId('dipoles-help-dialog')).not.toBeInTheDocument()
    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('кнопка-очки неактивна без выбранной точки и уточняет выбранную (F19)', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    // Без выбора на проекциях кнопка выключена, запросов нет
    const glasses = screen.getByTestId('refine-selected-button')
    expect(glasses).toBeDisabled()
    await user.click(glasses)
    expect(stateCalls(fetchSpy)).toEqual([])

    // Выбор точки на проекции (кладёт id в стор) активирует кнопку.
    // Узел перезапрашиваем: у IconButton смена disabled меняет обёртку
    // (tooltip-контейнер), и React пересоздаёт кнопку — старая ссылка протухла.
    act(() => useDipoleCalc.setState({ selectedPointId: '2-60' }))
    const enabled = screen.getByTestId('refine-selected-button')
    expect(enabled).toBeEnabled()
    // Текст подсказки (окно + ожидаемое время) собирается из `/meta` и проверен
    // юнит-тестами `refineCostHint`/`refineHalfwinLabel`: Radix-тултип в jsdom
    // не открывается по hover, и «ждать» его здесь значило бы тест на Radix.

    await user.click(enabled)

    // Ушёл POST на dipole_refine с эпохой выбранной точки и нарезкой результата
    const post = fetchSpy.mock.calls.find(
      ([url, init]) => String(url).includes('/dipole_refine') && init?.method === 'POST',
    )
    expect(post).toBeTruthy()
    const form = post?.[1]?.body as FormData
    expect(form.get('epoch_index')).toBe('2')
    expect(form.get('grid_mm')).toBe('7')
    // Окно свободного фитинга уходит явно: 0 — только пик GFP (шаг 1.5)
    expect(form.get('halfwin_ms')).toBe('0')

    // После уточнения кнопка помечает эпоху как уточнённую
    await screen.findByRole('button', { name: 'Эпоха 3 уточнена точным профилем' })
  })
})
