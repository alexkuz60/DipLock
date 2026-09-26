/**
 * Тесты тулс-хедара раздела EDF (срез 2.4): загрузка файла, раздельные кнопки
 * перерасчёта по стадиям, прогресс готовности, паспорт сессии и комбо-бокс зума.
 *
 * Рендерится весь раздел через `SectionRoute` — так проверяется связка
 * «действие в шапке → рабочая область/панель», а не компонент в вакууме.
 */
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECTION_ROUTES } from './registry'
import { SectionRoute } from './routes'
import { EDF_PARAM_DEFAULTS, emptyStageSnapshot, useEdfParams } from '@/shared/state/edfParams'
import { EMPTY_PASSPORT, useEdfRecording } from '@/shared/state/edfRecording'
import { useUiStore } from '@/shared/state/uiStore'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Кнопки стадий — по одной на каждый шаг предподготовки */
const STAGE_BUTTONS = [
  'Пересчитать: Фильтр и референс',
  'Пересчитать: Поиск артефактов',
  'Пересчитать: Нарезка эпох',
]

function renderSection() {
  return renderWithProviders(
    <Routes>
      {SECTION_ROUTES.map(({ path, id }) => (
        <Route key={path} path={path} element={<SectionRoute id={id} />} />
      ))}
    </Routes>,
    { route: '/edf' },
  )
}

describe('тулс-хедер раздела EDF', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.getState().resetUiState()
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
    useEdfRecording.setState({
      recording: null,
      demo: null,
      uploadProgress: null,
      uploadError: null,
      passport: { ...EMPTY_PASSPORT },
      fileDialogRequest: 0,
      navRequest: null,
      stageJobs: {},
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('иконка «Загрузить EDF» открывает диалог выбора файла, не делая запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    const clickSpy = vi.spyOn(HTMLElement.prototype, 'click')
    renderSection()

    const callsBefore = fetchMock.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Загрузить EDF' }))

    // Диалог открывает тот же скрытый input, что и кнопка зоны загрузки
    expect(screen.getByLabelText('Выбрать файл EDF')).toBeInTheDocument()
    expect(clickSpy).toHaveBeenCalled()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('кнопка «Закрыть запись» выключена без записи и сбрасывает её состояние', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderSection()

    expect(screen.getByRole('button', { name: 'Закрыть запись' })).toBeDisabled()

    act(() => {
      useEdfRecording.setState({ recording: recordingFixture })
    })
    const closeButton = screen.getByRole('button', { name: 'Закрыть запись' })
    expect(closeButton).toBeEnabled()

    const callsBefore = fetchMock.mock.calls.length
    await user.click(closeButton)

    // Возврат к зоне загрузки и никаких запросов: закрытие — локальное действие
    expect(useEdfRecording.getState().recording).toBeNull()
    expect(screen.getByText('Файл записи не загружен')).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('показывает три раздельные кнопки перерасчёта и прогресс по стадиям', async () => {
    mockApiFetch()
    renderSection()

    for (const name of STAGE_BUTTONS) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    // До появления источника сигнала прогресс-бар не показываем
    expect(
      screen.queryByRole('progressbar', { name: 'Готовность перерасчётов' }),
    ).not.toBeInTheDocument()

    act(() => {
      useEdfRecording.setState({ recording: recordingFixture })
    })

    // С загруженной записью стадии можно считать — кнопки активны (срез 2.7)
    for (const name of STAGE_BUTTONS) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }

    const bar = await screen.findByRole('progressbar', { name: 'Готовность перерасчётов' })
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '3')

    act(() => {
      useEdfParams.getState().markStageApplied('filter')
    })
    expect(screen.getByRole('progressbar', { name: 'Готовность перерасчётов' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    )

    // Правка параметра стадии снова делает её устаревшей
    act(() => {
      useEdfParams.getState().setParams({ notchHz: 50 })
    })
    expect(screen.getByRole('progressbar', { name: 'Готовность перерасчётов' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    )
    expect(screen.getByText('Параметры изменены — результат не пересчитан')).toBeInTheDocument()
  })

  it('комбо-бокс зума меняет масштаб отрисовки без запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderSection()

    const callsBefore = fetchMock.mock.calls.length
    await user.selectOptions(screen.getByLabelText('Зум отрисовки ЭЭГ'), '2')

    expect(useEdfParams.getState().params.timeLevel).toBe(2)
    expect(screen.getByRole('option', { name: '×1 (вся сессия)' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('кнопки листания окна выключены при ×1 и кладут команду в стор (срез 2.9)', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderSection()

    const callsBefore = fetchMock.mock.calls.length
    // При ×1 видна вся запись — листать нечего
    expect(screen.getByRole('button', { name: 'Следующее окно' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'В конец записи' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Зум отрисовки ЭЭГ'), '2')
    const nextButton = screen.getByRole('button', { name: 'Следующее окно' })
    expect(nextButton).toBeEnabled()

    await user.click(nextButton)
    expect(useEdfRecording.getState().navRequest).toEqual({ command: 'next', seq: 1 })

    await user.click(screen.getByRole('button', { name: 'В начало записи' }))
    expect(useEdfRecording.getState().navRequest).toEqual({ command: 'start', seq: 2 })
    // Навигация — только перерисовка окна: сервер не пересчитывает экран
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('паспорт: кнопка выключена без записи, диалог сохраняет метаданные для БД', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderSection()

    expect(screen.getByRole('button', { name: 'Паспорт сессии' })).toBeDisabled()

    act(() => {
      useEdfRecording.setState({ recording: recordingFixture })
    })
    const callsBefore = fetchMock.mock.calls.length

    await user.click(screen.getByRole('button', { name: 'Паспорт сессии' }))
    expect(screen.getByRole('dialog', { name: 'Паспорт сессии' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Испытуемый'), 'S-01')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useEdfRecording.getState().passport.subject).toBe('S-01')
    // Паспорт — данные для БД: ни одного запроса на запись/изменение файла
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('кнопка стадии запускает задачу и заменяет демо-слои результатом (срез 2.7)', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderSection()

    act(() => {
      useEdfRecording.setState({ recording: recordingFixture })
    })

    // До нажатия стадии запросов предподготовки нет: UI не имитирует обработку
    const preprocessCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/preprocess'))
    expect(preprocessCalls()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Пересчитать: Поиск артефактов' }))

    await waitFor(() => {
      expect(useEdfRecording.getState().stageJobs.artifacts?.status).toBe('succeeded')
    })
    const layers = useEdfRecording.getState().layers
    expect(layers?.source).toBe('result')
    expect(layers?.artifacts.map((zone) => zone.kind)).toEqual(['zscore_outlier', 'peak_to_peak'])
    // Снимок стадии зафиксирован: готовность выросла на одну стадию из трёх
    expect(
      screen.getByRole('progressbar', { name: 'Готовность перерасчётов' }),
    ).toHaveAttribute('aria-valuenow', '1')
    expect(preprocessCalls().length).toBeGreaterThan(0)
  })
})

describe('кнопка «Нарезка эпох» в событийном режиме (N2/2.7)', () => {
  beforeEach(() => {
    localStorage.clear()
    useUiStore.getState().resetUiState()
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
    useEdfRecording.setState({
      recording: recordingFixture,
      demo: null,
      uploadProgress: null,
      uploadError: null,
      passport: { ...EMPTY_PASSPORT },
      fileDialogRequest: 0,
      navRequest: null,
      stageJobs: {},
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('без выбранного события кнопка выключена и запросов не шлёт', async () => {
    const fetchMock = mockApiFetch()
    renderSection()
    act(() => {
      useEdfParams.getState().setParams({ epochMode: 'events', eventId: '' })
    })

    const button = screen.getByRole('button', { name: 'Пересчитать: Нарезка эпох' })
    expect(button).toBeDisabled()

    // Задачу без события не ставим — никаких запросов предподготовки
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/preprocess'))).toBe(false)

    // Выбрали событие — кнопка включается (ссылку переполучаем: при снятии
    // `disabled` IconButton убирает обёртку и кнопка пересоздаётся в DOM)
    act(() => {
      useEdfParams.getState().setParams({ eventId: 'STIM/5' })
    })
    expect(
      screen.getByRole('button', { name: 'Пересчитать: Нарезка эпох' }),
    ).toBeEnabled()
  })

  it('для записи без событий кнопка тоже выключена (режим не на что переключиться)', () => {
    mockApiFetch()
    renderSection()
    act(() => {
      useEdfRecording.setState({
        recording: { ...recordingFixture, events: [], event_counts: {} },
      })
      useEdfParams.getState().setParams({ epochMode: 'events', eventId: '' })
    })

    expect(
      screen.getByRole('button', { name: 'Пересчитать: Нарезка эпох' }),
    ).toBeDisabled()
  })
})
