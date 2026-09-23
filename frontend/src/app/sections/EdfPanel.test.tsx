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
    useEdfRecording.setState({
      recording: null,
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

  it('легенда артефактов: цветные метки типов и тумблер видимости без запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<EdfPanel />)
    await screen.findByLabelText('Fp1')

    // 4 типа артефактов: у каждого чекбокс с цветной меткой зоны вьюера (срез 2.6)
    expect(screen.getAllByTestId('checkbox-swatch')).toHaveLength(11)
    expect(screen.getByLabelText('z-score выбросы')).toBeChecked()

    const callsBefore = fetchMock.mock.calls.length
    await user.click(screen.getByLabelText('z-score выбросы'))

    expect(useEdfParams.getState().params.artifactVisibility.zscore_outlier).toBe(false)
    expect(screen.getByLabelText('z-score выбросы')).not.toBeChecked()
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
})
