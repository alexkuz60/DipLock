/**
 * Тесты панели раздела EDF: значения из /meta, отсутствие авто-запусков
 * обработки и индикация устаревшего результата по стадиям.
 */
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { EdfPanel } from './EdfPanel'
import type { CleanReport } from '@/shared/api/types'
import {
  EDF_PARAM_DEFAULTS,
  emptyStageSnapshot,
  useEdfParams,
} from '@/shared/state/edfParams'
import { useEdfRecording, EMPTY_PASSPORT } from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { metaFixture, preprocessJobFixture, recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('панель раздела EDF', () => {
  beforeEach(() => {
    localStorage.clear()
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
    useEdfRecording.setState({
      recording: null,
      demo: null,
      layers: null,
      epochMarks: [],
      passport: { ...EMPTY_PASSPORT },
    })
  })

  it('показывает пороги, длины эпох и каналы из конфигурации сервера', async () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)

    // Ждём именно каналы из /meta: опция «2000 мс» есть и до ответа сервера
    expect(await screen.findByLabelText('Fp1')).toBeInTheDocument()
    expect(screen.getByLabelText('Длина эпохи')).toHaveValue('2000')
    expect(screen.getByLabelText('z-score')).toHaveValue(5)
    expect(screen.getByLabelText('peak-to-peak')).toHaveValue(100)
    expect(screen.getByLabelText('flat-line')).toHaveValue(1)
    expect(screen.getByRole('option', { name: '2000 мс' })).toBeInTheDocument()
    expect(screen.getByText(/Показан монтаж 10-20 по умолчанию/)).toBeInTheDocument()
  })

  it('правка параметров ничего не запускает и не делает запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    const callsBefore = fetchMock.mock.calls.length

    await user.selectOptions(screen.getByLabelText('Notch'), '50')
    await user.click(screen.getByLabelText('Fp1'))

    expect(useEdfParams.getState().params.notchHz).toBe(50)
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
    // Все обращения — только чтение метаданных, никаких заданий обработки
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/meta'))).toBe(true)
  })

  it('показывает устаревание результата и сбрасывает параметры к значениям сервера', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture, passport: { ...EMPTY_PASSPORT } })
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    expect(screen.getByText('Результат не рассчитан')).toBeInTheDocument()

    // Имитируем выполненный расчёт: параметры текущие, запись загружена
    act(() => {
      useEdfParams.getState().setAvailableChannels(metaFixture.standard_channels)
      useEdfParams.getState().markApplied()
    })
    expect(screen.getByText('Результат соответствует параметрам')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Notch'), '50')
    expect(screen.getByText('Параметры изменены — результат не пересчитан')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'К значениям сервера' }))
    expect(useEdfParams.getState().params.notchHz).toBe(0)
    expect(screen.getByText('Результат соответствует параметрам')).toBeInTheDocument()
  })

  it('не запускает обработку сама: перерасчёт — только кнопками шапки раздела', () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)

    expect(screen.getByText(/Расчёт запускается только кнопками шапки раздела/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Пересчитать/ })).not.toBeInTheDocument()
    // Пока записи нет, пересчитывать нечего — вместо статуса ясная причина
    expect(screen.getByText(/пересчитывать пока нечего/)).toBeInTheDocument()
  })

  it('зоны вклада чистки: чекбокс голосует отмену, ничего не запуская (шаг 2)', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    act(() => {
      useEdfRecording.setState({ cleanReport: cleanReportFixture() })
    })
    renderWithProviders(<EdfPanel />)

    const zones = await screen.findByTestId('clean-zones')
    expect(zones).toHaveTextContent('clean-1: 4.2–5.5 с · Fp1, Fp2 · 17.2 мкВ')

    const callsBefore = fetchMock.mock.calls.length
    const zone1 = screen.getByLabelText(/^clean-1:/)
    expect(zone1).toBeChecked() // чистка применена — по умолчанию отмен нет
    await user.click(zone1)

    expect(zone1).not.toBeChecked()
    expect(useEdfParams.getState().params.cleanExcludeZoneIds).toEqual(['clean-1'])
    // Правка параметра — не расчёт: ни одного нового запроса
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/meta'))).toBe(true)

    // Снятие отмены возвращает пустой список (чистка снова целиком)
    await user.click(zone1)
    expect(useEdfParams.getState().params.cleanExcludeZoneIds).toEqual([])
  })

  it('метрики потерь: наводка L1, полосы L3/L4 и дисперсия L5 (шаг 2)', async () => {
    act(() => {
      useEdfRecording.setState({ cleanReport: cleanReportFixture() })
    })
    renderWithProviders(<EdfPanel />)

    await screen.findByTestId('clean-loss')
    expect(screen.getByTestId('clean-loss-l1')).toHaveTextContent('50 Гц 12 → 4.5 дБ')
    expect(screen.getByTestId('clean-loss-band-delta')).toHaveTextContent('1.2')
    expect(screen.getByTestId('clean-loss-band-alpha')).toHaveTextContent('0.97')
    expect(screen.getByTestId('clean-loss-l5')).toHaveTextContent('15.5%')
    expect(screen.getByTestId('clean-loss-l5')).toHaveTextContent('компонент ICA')
  })

  it('вторая разметка ICLabel в отчёте очистки: сводка и advisory-рекомендация (01.10.2026)', async () => {
    act(() => {
      useEdfRecording.setState({
        cleanReport: {
          ...cleanReportFixture(),
          iclabel_labels: ['brain', 'brain', 'eye blink', 'brain', 'brain', 'other'],
          iclabel_probabilities: [0.9, 0.85, 0.71, 0.9, 0.8, 0.6],
          iclabel_recommended: [2, 4],
        },
      })
    })
    renderWithProviders(<EdfPanel />)

    const summary = await screen.findByTestId('iclabel-summary')
    expect(summary).toHaveTextContent('ICLabel (вторая разметка): brain 4, eye blink 1, other 1')
    // Advisory: #2 не удалён нами — показываем с вероятностью; #4 уже в
    // removed_components, «ещё» его не предлагаем (решение за пользователем)
    const recommend = screen.getByTestId('iclabel-recommend')
    expect(recommend).toHaveTextContent('#2 eye blink (0.71)')
    expect(recommend).not.toHaveTextContent('#4')
  })

  it('без записи (и в демо) контрола слоя нет: нечего переключать', async () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')
    expect(screen.queryByRole('group', { name: 'Слой сигнала' })).not.toBeInTheDocument()

    // Демо-кадр: сервера и параметров подготовки нет — слой тоже не показываем
    act(() => {
      useEdfRecording.setState({
        recording: recordingFixture,
        demo: { sourceId: 'demo' } as never,
      })
    })
    expect(screen.queryByRole('group', { name: 'Слой сигнала' })).not.toBeInTheDocument()
  })

  it('с записью показывает статус и подпись по стадиям перерасчёта', () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture, passport: { ...EMPTY_PASSPORT } })
    renderWithProviders(<EdfPanel />)

    expect(screen.getByText('Результат не рассчитан')).toBeInTheDocument()
    expect(
      screen.getByRole('progressbar', { name: 'Готовность перерасчётов в панели' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Фильтр и референс — не рассчитано/)).toBeInTheDocument()
    expect(screen.getByText(/Поиск артефактов — не рассчитано/)).toBeInTheDocument()
  })

  it('ошибка стадии показывает текст и разворот traceback (N31)', () => {
    mockApiFetch()
    useEdfRecording.setState({
      recording: recordingFixture,
      passport: { ...EMPTY_PASSPORT },
      stageJobs: {
        artifacts: {
          status: 'failed',
          progress: 0,
          message: '',
          stage: 'queued',
          error: 'Все эпохи отброшены reject-фильтром',
          errorTraceback: 'Traceback (most recent call last): ... ValueError: эпохи',
        },
      },
    })
    renderWithProviders(<EdfPanel />)

    expect(screen.getByText(/Поиск артефактов: Все эпохи отброшены/)).toBeInTheDocument()
    const details = screen.getByTestId('stage-traceback-artifacts')
    expect(details).toHaveTextContent('Технические детали ошибки')
    expect(details).toHaveTextContent('ValueError: эпохи')
  })

  it('в панели нет данных записи — они перенесены в диалог «Паспорт»', () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture, passport: { ...EMPTY_PASSPORT } })
    renderWithProviders(<EdfPanel />)

    expect(screen.queryByText(recordingFixture.filename)).not.toBeInTheDocument()
    expect(screen.queryByText('Единицы в БД')).not.toBeInTheDocument()
    expect(screen.queryByText(/Загрузка EDF — в рабочей области раздела/)).not.toBeInTheDocument()
  })

  it('секции «Единицы EDF» в опциях нет: единицы показывает диалог «Паспорт»', () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)

    // Секция убрана (правка 30.09.2026): в формы предподготовки параметр не
    // входил, показ и правка единиц — в диалоге «Паспорт» сессии
    expect(screen.queryByText('Единицы EDF')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Единицы')).not.toBeInTheDocument()
    // Переключатель «Амплитуда» при этом остался в панели «Отображение»
    expect(screen.getByRole('group', { name: 'Амплитуда' })).toBeInTheDocument()
  })

  it('легенда артефактов: цветные метки типов и тумблер видимости без запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    // Чекбоксы видимости — у типов с временной зоной: у ICA зоны нет
    // (компоненты не привязаны ко времени — фидбэк 24.09.2026), её чекбокс скрыт
    expect(screen.getAllByTestId('checkbox-swatch')).toHaveLength(10)
    expect(screen.queryByLabelText('ICA: EOG-компоненты')).not.toBeInTheDocument()
    expect(screen.getByLabelText('z-score выбросы')).toBeChecked()

    const callsBefore = fetchMock.mock.calls.length
    await user.click(screen.getByLabelText('z-score выбросы'))

    expect(useEdfParams.getState().params.artifactVisibility.zscore_outlier).toBe(false)
    expect(screen.getByLabelText('z-score выбросы')).not.toBeChecked()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('светофор записи: вердикт и причины из стадии artifacts (шаг 2.2)', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    useEdfRecording.setState({
      recording: recordingFixture,
      qcSummary: {
        goodDataPercent: 42,
        lineNoiseLevel: 9.2,
        badChannels: ['C3'],
        snrDbMedian: 3.5,
        deadChannels: ['P4'],
        recordStatus: 'bad',
        recordStatusReasons: ['чистых данных 42 %', 'SNR 4 дБ'],
      },
    })
    renderWithProviders(<EdfPanel />)

    const light = await screen.findByText(/Светофор: плохо/)
    expect(light).toHaveAttribute('title', 'чистых данных 42 %; SNR 4 дБ')
    expect(screen.getByText('SNR: 3.5 дБ')).toBeInTheDocument()

    // Мёртвый канал кнопкой подставляется в опцию интерполяции
    await user.click(screen.getByRole('button', { name: /Мёртвые каналы: P4/ }))
    expect(useEdfParams.getState().params.badChannels).toBe('P4')
  })

  it('показывает поля своего диапазона только для пресета «Свой диапазон»', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<EdfPanel />)

    expect(screen.queryByLabelText('От')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Полоса'), 'custom')

    expect(screen.getByLabelText('От')).toHaveValue(1)
    expect(screen.getByLabelText('До')).toHaveValue(40)
  })

  it('выключает все каналы кнопкой «Ничего» и включает кнопкой «Все»', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    await user.click(screen.getByRole('button', { name: 'Ничего' }))
    expect(useEdfParams.getState().params.visibleChannels).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Все' }))
    expect(useEdfParams.getState().params.visibleChannels).toEqual(metaFixture.standard_channels)
  })

  it('карта датчиков: клик по точке включает/выключает канал просмотра', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    act(() => useEdfParams.getState().setAvailableChannels(metaFixture.standard_channels))
    renderWithProviders(<EdfPanel />)
    await screen.findByTestId('head-channel-map')

    // Вместо чекбоксов — силуэт головы: датчик объявлен кнопкой с aria-pressed
    const fp1 = screen.getByRole('button', { name: 'Fp1' })
    expect(fp1).toHaveAttribute('aria-pressed', 'true')

    await user.click(fp1)

    expect(fp1).toHaveAttribute('aria-pressed', 'false')
    expect(useEdfParams.getState().params.visibleChannels).not.toContain('Fp1')
    // Клик — только состояние, запросов в сеть нет
    expect(useEdfParams.getState().params.visibleChannels).toContain('Fp2')
  })

  it('переключатель «Имена» меняет подписи 10-10/10-20 без запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    act(() => useEdfParams.getState().setAvailableChannels(['C3', 'T7']))
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('C3')

    // Дефолт — канонические имена 10-10: T7 есть, классического T3 нет
    expect(screen.getByLabelText('T7')).toBeInTheDocument()
    expect(screen.queryByLabelText('T3')).not.toBeInTheDocument()

    const callsBefore = fetchMock.mock.calls.length
    await user.click(screen.getByRole('button', { name: '10-20' }))

    expect(useEdfParams.getState().params.channelNaming).toBe('10-20')
    expect(screen.getByLabelText('T3')).toBeInTheDocument()
    expect(screen.queryByLabelText('T7')).not.toBeInTheDocument()
    // Параметр отрисовки: ни одного нового запроса (расчёт не запускается)
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('показывает число ручных пометок эпох и снимает их кнопкой (срез 2.10)', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    expect(screen.getByText('Ручных пометок: 0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Снять' })).toBeDisabled()

    // Пометку ставит вьюер (Ctrl+двойной клик) — панель лишь отзывается на неё
    const fetchMock = mockApiFetch()
    act(() =>
      useEdfRecording.getState().toggleEpochBlock({ onsetSec: 0, durationSec: 2 }, false),
    )

    expect(screen.getByText('Ручных пометок: 1')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Снять' }))
    expect(useEdfRecording.getState().epochMarks).toEqual([])
    expect(screen.getByText('Ручных пометок: 0')).toBeInTheDocument()
  })

  // Секция «Справка» (правка 29.09.2026): подпись слоя «треки:», пометка источника
  // слоёв «слои:» и расшифровка жестов переехали из инфо-строки над треками
  it('секция «Справка»: подпись слоя, пометка слоёв и расшифровка жестов', async () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    expect(screen.getByText('треки: исходный сигнал без фильтра')).toBeInTheDocument()
    expect(screen.getByText(/Колесо — прокрутка треков/)).toBeInTheDocument()
    expect(screen.getByText(/зум — селект «Зум отрисовки ЭЭГ»/)).toBeInTheDocument()
    // Слоёв пока нет — пометки «слои:» нет
    expect(screen.queryByText(/^слои:/)).not.toBeInTheDocument()

    // После расчёта пиуля называет источник зон и штриховки
    act(() => {
      useEdfRecording.setState({
        layers: {
          source: 'result',
          artifacts: [],
          rejectedEpochs: [],
          rejectChannels: {},
          epochLengthMs: null,
        },
      })
    })
    expect(screen.getByText('слои: результат расчёта')).toBeInTheDocument()
  })

  it('авто-длина: смена полосы подставляет длину эпохи в фиксированном режиме (п.4)', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    // «Свой диапазон» с нижней границей 8 Гц: ≥ 2 периодов = 250 мс
    useEdfParams.setState({ params: { ...EDF_PARAM_DEFAULTS, customBand: [8, 40] } })
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    await user.selectOptions(screen.getByLabelText('Полоса'), 'custom')

    // Кратчайшая длина списка (/meta), прошедшая правило периодов — «короче для высоких»
    expect(useEdfParams.getState().params.epochLengthMs).toBe(250)
    expect(screen.getByLabelText('Длина эпохи')).toHaveValue('250')
  })

  it('две половины правила (≥ 2 периодов и ≥ 3C) видны у длины эпохи (п.4)', async () => {
    // Запись: 10 каналов монтажа при 100 Гц → 3C = 30 отсчётов → минимум 300 мс
    useEdfRecording.setState({ recording: { ...recordingFixture, sfreq: 100 } })
    useEdfParams.setState({ params: { ...EDF_PARAM_DEFAULTS, epochLengthMs: 250 } })
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    const warnings = await screen.findByTestId('epoch-rule-warnings')
    // Полоса по умолчанию 1–40 Гц: 250 мс < 2 периодов 1 Гц (минимум 2000 мс)
    expect(warnings).toHaveTextContent('двух периодов нижней частоты полосы')
    // 250 мс при 100 Гц = 25 отсчётов — меньше 3C (3 × 10 = 30 отсчётов)
    expect(warnings).toHaveTextContent('3 × 10 = 30 отсчётов')
  })
})

describe('событийный режим и блок ERP (N2/2.7)', () => {
  beforeEach(() => {
    localStorage.clear()
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
    useEdfRecording.setState({
      recording: recordingFixture,
      layers: null,
      epochMarks: [],
      passport: { ...EMPTY_PASSPORT },
      evoked: {
        status: 'idle', progress: 0, message: '',
        error: null, errorTraceback: null, result: null,
      },
    })
  })

  it('включение режима «По событиям» сразу подставляет первое событие записи', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')
    expect(useEdfParams.getState().params.eventId).toBe('')

    await user.click(screen.getByRole('button', { name: 'По событиям' }))

    // Пустой выбор давал 400 «требует event_id» при нажатии «Нарезка эпохи»
    expect(useEdfParams.getState().params.epochMode).toBe('events')
    expect(useEdfParams.getState().params.eventId).toBe('STIM/5')
  })

  it('режим «По событиям» открывает селект событий и окно до/после', async () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    // Фиксированный режим: событийных контролов нет, длина эпохи на месте
    expect(screen.queryByLabelText('Событие')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Длина эпохи')).toBeInTheDocument()

    act(() => {
      useEdfParams.getState().setParams({ epochMode: 'events' })
    })

    expect(screen.getByLabelText('Событие')).toBeInTheDocument()
    // Селект событий — из паспорта записи (счётчики по описаниям)
    expect(screen.getByRole('option', { name: 'STIM/5 — 2' })).toBeInTheDocument()
    expect(screen.getByLabelText('До события')).toHaveValue(200)
    expect(screen.getByLabelText('После события')).toHaveValue(800)
    expect(screen.queryByLabelText('Длина эпохи')).not.toBeInTheDocument()
  })

  it('в режиме «По событиям» авто-длина не трогает окна ERP (п.4)', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    // Свой диапазон 8–40 Гц: в фиксированном режиме подставил бы 250 мс
    useEdfParams.getState().setParams({
      epochMode: 'events',
      customBand: [8, 40],
    })
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    await user.selectOptions(screen.getByLabelText('Полоса'), 'custom')

    // Длина эпохи скрыта (ERP режется окнами до/после) и не подставляется
    expect(screen.queryByLabelText('Длина эпохи')).not.toBeInTheDocument()
    expect(useEdfParams.getState().params.epochLengthMs).toBe(
      EDF_PARAM_DEFAULTS.epochLengthMs,
    )
    expect(useEdfParams.getState().params.epochPreMs).toBe(EDF_PARAM_DEFAULTS.epochPreMs)
    expect(useEdfParams.getState().params.epochPostMs).toBe(EDF_PARAM_DEFAULTS.epochPostMs)
  })

  it('кнопка ERP disabled без события и включается с выбранным событием', async () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    const button = screen.getByRole('button', { name: 'Усреднить (ERP)' })
    expect(button).toBeDisabled()

    act(() => {
      useEdfParams.getState().setParams({ epochMode: 'events', eventId: 'STIM/5' })
    })
    expect(button).toBeEnabled()
  })

  it('кнопка считает ERP, правка параметров — нет; волна и числа приходят в блок', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    useEdfParams.getState().setParams({ epochMode: 'events', eventId: 'STIM/5' })
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    // Правка канала графика — просмотр результата, запросов не шлёт
    const callsBefore = fetchMock.mock.calls.length
    await user.selectOptions(screen.getByLabelText('Канал графика'), 'F4')
    expect(fetchMock.mock.calls.length).toBe(callsBefore)

    await user.click(screen.getByRole('button', { name: 'Усреднить (ERP)' }))

    expect(await screen.findByTestId('evoked-result')).toBeInTheDocument()
    expect(screen.getByText(/Событий в среднем: 2 из 2/)).toBeInTheDocument()
    expect(screen.getByTestId('evoked-chart')).toBeInTheDocument()
    // Запустилась именно задача ERP, а не стадия предподготовки
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/evoked')),
    ).toBe(true)
  })

  it('ошибка задачи ERP показывается текстом, а не молчанием', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      preprocessJob: {
        ...preprocessJobFixture,
        status: 'failed',
        error: 'События «STIM/9» не найдены в записи',
      },
    })
    useEdfParams.getState().setParams({ epochMode: 'events', eventId: 'STIM/9' })
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    await user.click(screen.getByRole('button', { name: 'Усреднить (ERP)' }))

    expect(await screen.findByTestId('evoked-error')).toHaveTextContent(/не найдены/)
  })

  // Три слоя видимости (шаг 2 плана): контрол — параметр отрисовки
  it('«Слой сигнала» у записи: переключение меняет вид без запросов и без устаревания стадий', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture, passport: { ...EMPTY_PASSPORT } })
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')
    useEdfParams.getState().markApplied()

    const group = screen.getByRole('group', { name: 'Слой сигнала' })
    const callsBefore = fetchMock.mock.calls.length

    await user.click(within(group).getByRole('button', { name: 'После очистки' }))

    expect(useEdfParams.getState().params.signalLayer).toBe('cleaned')
    // Ни запроса, ни «параметры изменены»: слой вне STAGE_PARAM_KEYS
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
    expect(screen.getByText('Результат соответствует параметрам')).toBeInTheDocument()

    await user.click(within(group).getByRole('button', { name: 'Сырой' }))
    expect(useEdfParams.getState().params.signalLayer).toBe('raw')
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })
})

/** Отчёт стадии «Фильтр и референс» с зонами и метриками (шаг 2). */
function cleanReportFixture(): CleanReport {
  return {
    method: 'ica',
    notch_harmonics: 1,
    interpolated_channels: [],
    n_components_removed: 2,
    removed_components: [1, 4],
    n_projectors: 0,
    amplitude_p95_uv_before: 12.5,
    amplitude_p95_uv_after: 9.8,
    warnings: [],
    zones: [
      {
        id: 'clean-1',
        onset_sec: 4.2,
        duration_sec: 1.3,
        channels: ['Fp1', 'Fp2'],
        amplitude_uv: 17.2,
        excluded: false,
      },
      {
        id: 'clean-2',
        onset_sec: 8,
        duration_sec: 0.5,
        channels: ['C3'],
        amplitude_uv: 4.1,
        excluded: false,
      },
    ],
    loss: {
      line_noise: [{ freq_hz: 50, before_db: 12, after_db: 4.5 }],
      bands: [
        { name: 'delta', delta_db: 1.2, correlation: 0.98 },
        { name: 'alpha', delta_db: 0.4, correlation: 0.97 },
      ],
      removed_variance_percent: 15.5,
      removed_variance_source: 'ica_components',
    },
  }
}
