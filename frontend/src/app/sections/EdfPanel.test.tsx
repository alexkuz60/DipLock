/**
 * Тесты панели раздела EDF: значения из /meta, отсутствие авто-запусков
 * обработки и индикация устаревшего результата по стадиям.
 */
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { EdfPanel } from './EdfPanel'
import {
  EDF_PARAM_DEFAULTS,
  emptyStageSnapshot,
  useEdfParams,
} from '@/shared/state/edfParams'
import { useEdfRecording, EMPTY_PASSPORT } from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { metaFixture, recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('панель раздела EDF', () => {
  beforeEach(() => {
    localStorage.clear()
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
    useEdfRecording.setState({ recording: null, passport: { ...EMPTY_PASSPORT } })
  })

  it('показывает пороги, длины эпох и каналы из конфигурации сервера', async () => {
    mockApiFetch()
    renderWithProviders(<EdfPanel />)

    // Ждём именно каналы из /meta: опция «2000 мс» есть и до ответа сервера
    expect(await screen.findByLabelText('Fp1')).toBeInTheDocument()
    expect(screen.getByLabelText('Длина эпохи')).toHaveValue('2000')
    expect(screen.getByLabelText('z-score')).toHaveValue(5)
    expect(screen.getByLabelText('peak-to-peak')).toHaveValue(100)
    expect(screen.getByLabelText('flat-line')).toHaveValue(5)
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

  it('в секции «Запись» — краткая инфа о файле вместо поясняющего текста', () => {
    mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture, passport: { ...EMPTY_PASSPORT } })
    renderWithProviders(<EdfPanel />)

    expect(screen.getByText(recordingFixture.filename)).toBeInTheDocument()
    expect(screen.getByText('Каналов')).toBeInTheDocument()
    expect(screen.getByText(`${recordingFixture.sfreq} Гц`)).toBeInTheDocument()
    expect(screen.getByText(`${recordingFixture.duration_sec} с`)).toBeInTheDocument()
    expect(screen.queryByText(/Загрузка EDF — в рабочей области раздела/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Каналы 10-20/)).not.toBeInTheDocument()
  })

  it('единицы для БД правятся в паспорте и не делают запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture, passport: { ...EMPTY_PASSPORT } })
    renderWithProviders(<EdfPanel />)

    const callsBefore = fetchMock.mock.calls.length
    await user.selectOptions(screen.getByLabelText('Единицы в БД'), 'uV')

    expect(useEdfRecording.getState().passport.units).toBe('uV')
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
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
})
