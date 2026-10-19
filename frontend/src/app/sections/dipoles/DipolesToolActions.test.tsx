/**
 * Тесты тулс-хедера раздела «Диполи» (срез 3.4 + пакетный сценарий).
 *
 * Проверяется правило «обработка — только по кнопке»: расчёт пакета (все полосы
 * каталога) запускается нажатием и показывается прогрессом по эпохам, пороги
 * отображения («GOF ≥ X %» и «Момент диполя ≥ X нАм») правят отображение (без
 * единого запроса), а кнопки панелей лишь открывают одну выдвижную панель за раз.
 * Покадровые кнопки «<»/«>» убраны: кадр перематывает индикатор эпох.
 */
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/shared/api/client'
import { CALC_PARAM_DEFAULTS, PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { defaultSlices } from '@/shared/lib/mriProjections'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { DIPOLE_PARAM_DEFAULTS, useDipoleParams } from '@/shared/state/dipoleParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { calcJobFixture, dipoleScanResultFixture, jobFixture, recordingFixture } from '@/test/fixtures'
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
      batchJob: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      batchError: null,
      spectrumError: null,
      refineJob: null,
      refiningEpoch: null,
      refinedPoints: {},
      refineError: null,
      eloretaJob: null,
      eloretaEpochIndex: null,
      eloretaResults: {},
      eloretaError: null,
      selectedPointId: null,
    })
    useEdfRecording.setState({ recording: null })
  })

  it('без записи кнопка расчёта выключена и объясняет причину', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    const button = screen.getByRole('button', { name: 'Рассчитать пакет' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('загрузите EDF'))

    await user.click(button)
    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('запускает расчёт пакета кнопкой: задача, поллинг и набор в состоянии', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Рассчитать пакет' }))

    const urls = stateCalls(fetchSpy).map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/dipole_batch')
    expect(useDipoleCalc.getState().batch?.bands?.length).toBeGreaterThan(0)
    // Кнопка меняет подпись: результат есть — предлагается пересчёт
    expect(screen.getByRole('button', { name: 'Пересчитать пакет' })).toBeInTheDocument()
    // Пилюля «Быстрый режим: N точек» убрана (дубль индикатора эпох, 19.10.2026)
    expect(screen.queryByText(/Быстрый режим: \d+ точек/)).not.toBeInTheDocument()
  })

  it('пока задача идёт, прогресс показывает индикатор эпох, а в шапке остаётся отмена (3.2)', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      batchJob: {
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

    // Полосы прогресса в шапке больше нет: её дублировал индикатор эпох
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('button', { name: 'Расчёт…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Отменить/ })).toBeInTheDocument()
  })

  it('кнопка «Отменить» шлёт DELETE и убирает себя вместе с идущей задачей (3.2)', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      batchJob: {
        status: 'running',
        progress: 0.5,
        message: 'Диполи: 2 из 4',
        stage: 'scan',
        epochsDone: 2,
        epochsTotal: 4,
        error: null,
        jobId: 'job-d1',
      },
    })
    const cancelSpy = vi
      .spyOn(api, 'jobCancel')
      .mockResolvedValue({ ...jobFixture, status: 'cancelled' })
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: /Отменить/ }))

    expect(cancelSpy).toHaveBeenCalledWith('job-d1')
    expect(useDipoleCalc.getState().batchJob?.status).toBe('cancelled')
    expect(screen.queryByRole('button', { name: /Отменить/ })).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('пороги отображения меняют состояние и не делают запросов', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    const field = screen.getByLabelText('Порог момента диполя, нАм')
    await user.clear(field)
    await user.type(field, '60')
    expect(useDipoleCalc.getState().amplitudeThresholdNam).toBe(60)

    // Основной порог — GOF, %: правится так же без запросов
    const gofField = screen.getByLabelText('Порог GOF отображения, %')
    await user.clear(gofField)
    await user.type(gofField, '80')
    expect(useDipoleCalc.getState().gofThresholdPercent).toBe(80)

    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('отправляет сетевой фильтр и параметры панели в задачу пакета (срез 3.6)', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS, notchHz: 50 },
    })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Рассчитать пакет' }))

    // Прогон шлёт все полосы каталога и параметры — не «где-то в состоянии,
    // но не в запросе»
    const [, init] = stateCalls(fetchSpy)[0]
    const form = init?.body as FormData
    expect(String(form.get('bands')).split(',').length).toBeGreaterThan(2)
    expect(form.get('notch_hz')).toBe('50')
    expect(form.get('epoch_length_ms')).toBe('1000')
    expect(form.get('grid_mm')).toBe('7')
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
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    expect(screen.getByRole('button', { name: 'Воспроизведение траектории' })).toBeDisabled()
    // Покадровых кнопок «<»/«>» больше нет: кадр перематывает индикатор эпох
    expect(screen.queryByRole('button', { name: 'Предыдущая эпоха' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Следующая эпоха' })).not.toBeInTheDocument()
    // Снимать нечего: кнопки снятия кадра и подписи кадра нет вовсе
    expect(screen.queryByRole('button', { name: 'Снять кадр' })).not.toBeInTheDocument()

    expect(useDipoleCalc.getState().playback.epochIndex).toBe(0)
    expect(stateCalls(fetchSpy)).toEqual([])
  })

  it('играет и меняет скорость — без запросов к серверу', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Воспроизведение траектории' }))
    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: true, active: true })
    // Играющая кнопка меняет доступное имя: пауза — это то же действие
    const pause = screen.getByRole('button', { name: 'Пауза воспроизведения' })
    expect(pause).toHaveClass('bg-accent-soft')

    // Пауза останавливает воспроизведение, кадр остаётся на своей эпохе
    await user.click(pause)
    expect(useDipoleCalc.getState().playback).toMatchObject({
      playing: false,
      active: true,
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

  it('не дублирует кадр в шапке и снимает его кнопкой «Снять кадр»', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      playback: { ...PLAYBACK_DEFAULTS, active: true, epochIndex: 2 },
      selectedEpochIndex: 2,
    })
    renderWithProviders(<DipolesToolHeaderActions />)

    // Подпись «Кадр: эпоха … из …» убрана: позицию кадра показывает индикатор эпох
    expect(screen.queryByText(/^Кадр: эпоха/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Снять кадр' }))

    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: false, active: false })
    // «Снять кадр» убирает и выделение эпохи: облако диполей в полный вид
    expect(useDipoleCalc.getState().selectedEpochIndex).toBeNull()
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

  it('кнопка eLORETA активна только с выбором и шлёт свою задачу (остаток B9)', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    // Без выбора точки — кнопка выключена, запросов нет
    const button = screen.getByTestId('eloreta-selected-button')
    expect(button).toBeDisabled()
    await user.click(button)
    expect(stateCalls(fetchSpy)).toEqual([])

    // Выбор точки активирует: POST уходит на /eloreta с той же нарезкой
    act(() => useDipoleCalc.setState({ selectedPointId: '2-60' }))
    const enabled = screen.getByTestId('eloreta-selected-button')
    expect(enabled).toBeEnabled()
    await user.click(enabled)

    const post = fetchSpy.mock.calls.find(
      ([url, init]) => String(url).includes('/eloreta') && init?.method === 'POST',
    )
    expect(post).toBeTruthy()
    const form = post?.[1]?.body as FormData
    expect(form.get('epoch_index')).toBe('2')
    expect(form.get('grid_mm')).toBe('7')

    // Результат фикстуры осел в сторе — карточка покажет его в разделе
    await vi.waitFor(() => {
      expect(Object.keys(useDipoleCalc.getState().eloretaResults)).toEqual(['2'])
    })
    const stored = useDipoleCalc.getState().eloretaResults[2]
    expect(stored.method).toBe('eloreta')
    expect(stored.peak.structure_name).toBe('Left Precentral')
  })

  it('переключатель «Проекции / 3D» меняет только вид (3.5, без запросов)', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    useDipoleParams.setState({ params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() } })
    renderWithProviders(<DipolesToolHeaderActions />)

    expect(screen.getByTestId('view-projections')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('view-3d')).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByTestId('view-3d'))
    expect(useDipoleParams.getState().params.view3d).toBe(true)
    expect(screen.getByTestId('view-3d')).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByTestId('view-projections'))
    expect(useDipoleParams.getState().params.view3d).toBe(false)

    // Правка вида — отрисовка: ни одной задачи расчёта не ушло
    expect(stateCalls(fetchSpy)).toEqual([])
  })
})
