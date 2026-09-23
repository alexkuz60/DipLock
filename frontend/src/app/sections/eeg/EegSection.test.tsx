/**
 * Тесты рабочей области раздела «ЭЭГ» (срез 5).
 *
 * Проверяется то, что видно пользователю: пустое состояние без записи, две
 * половины (трек и спектрограмма) с **одной** полосой времени под треком, общий
 * курсор и жизнь до следующего клика, клик по спектрограмме (время — в общий
 * курсор, частота — в линию частоты этой половины), перетаскивание разделителя и
 * правой линейки (шкала меняется, запросов нет). Картинку холста jsdom не рисует,
 * поэтому проверяются контракт компонентов и состояние, а арифметика шкал покрыта
 * `shared/lib/eegView.test.ts` и `eegCanvas.test.ts`.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { EegSection } from './EegSection'
import { demoSpectrogramGrid } from '@/shared/lib/eegSpectrogram'
import { formatUvLevel, yToAmplitudeUv } from '@/shared/lib/eegView'
import { EEG_PARAM_DEFAULTS, useEegParams } from '@/shared/state/eegParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Запись открыта: кадры сигналов приедут из мока `GET /recordings/{id}/signals`. */
function openRecording() {
  useEdfRecording.setState({
    recording: recordingFixture,
    uploadProgress: null,
    uploadError: null,
    demo: null,
    signalFrames: {},
    signalsPending: 0,
    signalsError: null,
    layers: null,
  })
}

describe('рабочая область раздела «ЭЭГ»', () => {
  beforeEach(() => {
    localStorage.clear()
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, filter: { ...EEG_PARAM_DEFAULTS.filter } },
      job: null,
      result: null,
      grid: null,
      error: null,
      gridError: null,
      eegNav: null,
    })
    useEdfRecording.setState({
      recording: null,
      uploadProgress: null,
      uploadError: null,
      demo: null,
      signalFrames: {},
      signalsPending: 0,
      signalsError: null,
      layers: null,
    })
  })

  it('без записи объясняет, где её взять, и не делает запросов за сигналами', () => {
    const fetchMock = mockApiFetch()
    renderWithProviders(<EegSection />)

    expect(screen.getByText('Запись не открыта')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Перейти в раздел EDF/ })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/signals'))).toBe(false)
  })

  it('рисует две половины, одну полосу времени и разделитель', async () => {
    mockApiFetch()
    openRecording()
    renderWithProviders(<EegSection />)

    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())
    expect(screen.getByTestId('eeg-spectrogram-canvas')).toBeInTheDocument()
    // Полоса времени одна на раздел: вторая, под спектрограммой, дублировала ось
    // и читалась как «вторые часы» с другим масштабом (в «обзоре» — вся запись)
    expect(screen.getByTestId('eeg-track-timeline')).toBeInTheDocument()
    expect(screen.queryByTestId('eeg-spectrogram-timeline')).not.toBeInTheDocument()
    expect(screen.getByTestId('eeg-splitter')).toHaveAttribute('role', 'separator')
    // Полоса времени осталась только у трека: её высота вычтена из его холста, а
    // спектрограмма занимает свою половину целиком (без пустой полосы внизу)
    expect(screen.getByTestId('eeg-track-canvas').style.height).toBe('276px')
    expect(screen.getByTestId('eeg-spectrogram-canvas').style.height).toBe('296px')
    // Спектрограмма до расчёта не выдумывается: раздел говорит, что её нет
    expect(screen.getByText('спектрограмма не рассчитана')).toBeInTheDocument()
    expect(
      screen.getByText(new RegExp(`Канал ${recordingFixture.channels[0]}`)),
    ).toBeInTheDocument()
  })

  it('не запускает расчёт сам: запросов к спектрограмме при отрисовке нет', async () => {
    const fetchMock = mockApiFetch()
    openRecording()
    renderWithProviders(<EegSection />)

    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())

    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.includes('/spectrogram'))).toBe(false)
  })

  it('ставит общий курсор кликом по треку', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    openRecording()
    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())

    // Клик ставим через user-event: jsdom без PointerEvent не передаёт координаты
    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByTestId('eeg-track-canvas'),
      coords: { clientX: 500, clientY: 100 },
    })

    // Курсор один на обе половины и подписан в полосе состояния
    await waitFor(() => expect(screen.getByText(/курсор \d+\.\d\d с/)).toBeInTheDocument())
    // Клик по треку не запускает обработку: данные уже в браузере
    expect(useEegParams.getState().job).toBeNull()
  })

  it('отвечает на клик по треку уровнем сигнала, а метки держит у одной точки клика', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    openRecording()
    useEegParams.setState({ grid: demoSpectrogramGrid('Oz') })
    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())

    const track = screen.getByTestId('eeg-track-canvas')
    // Высоту берём из разметки: шкала уровня считается по ней, а не по раскладке
    // (в jsdom прямоугольники нулевые)
    const height = Number.parseFloat(track.style.height)
    const uvAt = (clientY: number) =>
      yToAmplitudeUv(clientY, EEG_PARAM_DEFAULTS.amplitudeUv, height)

    // Клик по спектрограмме отвечает частотой…
    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByTestId('eeg-spectrogram-canvas'),
      coords: { clientX: 500, clientY: 100 },
    })
    await waitFor(() =>
      expect(screen.getByText(/курсор \d+\.\d\d с · [\d.]+ Гц/)).toBeInTheDocument(),
    )

    // …а клик по треку — уровнем сигнала, и частота прежней точки к новой не относится
    await user.pointer({ keys: '[MouseLeft]', target: track, coords: { clientX: 500, clientY: 70 } })
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(`курсор \\d+\\.\\d\\d с · ${formatUvLevel(uvAt(70))}`)),
      ).toBeInTheDocument(),
    )

    // Ниже по холсту — уровень меньше: та же шкала, что у линейки мкВ
    await user.pointer({
      keys: '[MouseLeft]',
      target: track,
      coords: { clientX: 500, clientY: 200 },
    })
    expect(uvAt(200)).toBeLessThan(uvAt(70))
    const bottomLevel = formatUvLevel(uvAt(200))
    await waitFor(() => expect(screen.getByText(new RegExp(bottomLevel))).toBeInTheDocument())
    // Просмотр, а не расчёт: клики ничего не запускают
    expect(useEegParams.getState().job).toBeNull()

    // Двойной клик по треку снимает метки точки клика — она одна на обе половины
    await user.dblClick(track)
    await waitFor(() => expect(screen.queryByText(/курсор \d+\.\d\d с/)).not.toBeInTheDocument())
  })

  it('ставит общий курсор и линию частоты кликом по спектрограмме (и подтягивает окно в «обзоре»)', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    openRecording()
    // Сетка уже показана, окно сужено ×8, а спектрограмма — «обзор»: точка клика
    // лежит вне окна трека, и без подтягивания окна курсор был бы виден только на
    // спектрограмме (выглядело как «метка ставится локально»)
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, timeLevel: 3, spectrogramMode: 'overview' },
      grid: demoSpectrogramGrid('Oz'),
    })
    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-spectrogram-canvas')).toBeInTheDocument())

    const before = useEegParams.getState().params.windowCenterSec
    // Клик ставим через user-event: jsdom без PointerEvent не передаёт координаты
    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByTestId('eeg-spectrogram-canvas'),
      coords: { clientX: 500, clientY: 100 },
    })

    // Время ушло в общий курсор: подпись в полосе состояния та же, что при клике по треку
    await waitFor(() => expect(screen.getByText(/курсор 14\.45 с/)).toBeInTheDocument())
    // Частота — рядом с курсором: «время и частота точки клика»
    expect(screen.getByText(/· 26\.5 Гц/)).toBeInTheDocument()
    // Окно трека подтянулось к точке клика — это просмотр, а не расчёт
    expect(useEegParams.getState().params.windowCenterSec).toBeGreaterThan(before)
    expect(useEegParams.getState().job).toBeNull()

    // Двойной клик по области снимает и курсор, и линию частоты (как у трека)
    await user.dblClick(screen.getByTestId('eeg-spectrogram-canvas'))
    await waitFor(() => expect(screen.queryByText(/курсор \d+\.\d\d с/)).not.toBeInTheDocument())
  })

  it('в режиме «связано» клик по спектрограмме окно трека не двигает', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    openRecording()
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, timeLevel: 3 },
      grid: demoSpectrogramGrid('Oz'),
    })
    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-spectrogram-canvas')).toBeInTheDocument())

    const before = useEegParams.getState().params.windowCenterSec
    await user.pointer({
      keys: '[MouseLeft]',
      target: screen.getByTestId('eeg-spectrogram-canvas'),
      coords: { clientX: 500, clientY: 100 },
    })

    // Спектрограмма показывает то же окно, что трек: точка клика уже внутри,
    // и окно остаётся на месте (курсор виден на обеих половинах)
    await waitFor(() => expect(screen.getByText(/курсор 1\.78 с/)).toBeInTheDocument())
    expect(useEegParams.getState().params.windowCenterSec).toBe(before)
  })

  it('меняет шкалу перетаскиванием правой линейки без запросов', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    openRecording()
    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())

    const before = useEegParams.getState().params.amplitudeUv
    const canvas = screen.getByTestId('eeg-track-canvas')
    await user.pointer([
      // Правая линейка значений: x за пределами области графика
      { keys: '[MouseLeft>]', target: canvas, coords: { clientX: 1000, clientY: 20 } },
      { coords: { clientX: 1000, clientY: 80 } },
      { keys: '[/MouseLeft]', coords: { clientX: 1000, clientY: 80 } },
    ])

    expect(useEegParams.getState().params.amplitudeUv).toBeGreaterThan(before)
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/spectrogram'))).toBe(false)
    // Перетаскивание линейки курсор не ставит: это разные жесты
    expect(screen.queryByText(/курсор \d+\.\d\d с/)).not.toBeInTheDocument()
  })

  it('двигает разделитель с клавиатуры и перетаскиванием', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    openRecording()
    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-splitter')).toBeInTheDocument())

    const splitter = screen.getByTestId('eeg-splitter')
    fireEvent.keyDown(splitter, { key: 'ArrowDown' })
    expect(useEegParams.getState().params.splitRatio).toBeGreaterThan(
      EEG_PARAM_DEFAULTS.splitRatio,
    )

    await user.pointer([
      { keys: '[MouseLeft>]', target: splitter, coords: { clientX: 10, clientY: 300 } },
      { coords: { clientX: 10, clientY: 100 } },
      { keys: '[/MouseLeft]', coords: { clientX: 10, clientY: 100 } },
    ])
    expect(useEegParams.getState().params.splitRatio).toBeLessThan(0.5)
  })

  it('ставит курсор и по полосе времени (там его проще поймать)', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    openRecording()
    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-track-timeline')).toBeInTheDocument())
    const timeline = screen.getByTestId('eeg-track-timeline')

    // Столбец значений справа (ширина 1024: область графика кончается на 968 px) —
    // не время: клик по линейке курсор не ставит
    await user.pointer({
      keys: '[MouseLeft]',
      target: timeline,
      coords: { clientX: 1024, clientY: 10 },
    })
    expect(screen.queryByText(/курсор \d+\.\d\d с/)).not.toBeInTheDocument()

    // Клик по области графика — та же шкала времени, что у трека
    await user.pointer({
      keys: '[MouseLeft]',
      target: timeline,
      coords: { clientX: 500, clientY: 10 },
    })
    await waitFor(() => expect(screen.getByText(/курсор \d+\.\d\d с/)).toBeInTheDocument())
  })

  it('открывает виртуальный канал: подпись микса и никакого расчёта (срез 5+)', async () => {
    const fetchMock = mockApiFetch()
    openRecording()
    // Канал из паспорта записи: микс «Лобные» — состояние раздела назначения
    // (так же его выставляет панель или переход из EDF кликом по названию)
    useEegParams.getState().setChannel('mix:frontal')

    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())

    // Подпись честно говорит, что это среднее группы, а не электрод
    expect(screen.getByText(/Микс: Лобные/)).toBeInTheDocument()
    // Выбор канала — параметр расчёта, но задачу он не запускает: только кнопка
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/spectrogram'))).toBe(
      false,
    )
  })

  it('показывает артефакты результата, относящиеся к выбранному каналу (срез 5+)', async () => {
    mockApiFetch()
    openRecording()
    useEdfRecording.setState({
      layers: {
        artifacts: [
          { id: 'own', kind: 'zscore_outlier', onsetSec: 1, durationSec: 0.5, channels: ['Fp1'] },
          // ICA находит компоненты, а не каналы: зона относится ко всему монтажу
          { id: 'montage', kind: 'ica_eog', onsetSec: 2, durationSec: 1, channels: [] },
          { id: 'other', kind: 'peak_to_peak', onsetSec: 3, durationSec: 0.2, channels: ['O1'] },
        ],
        rejectedEpochs: [],
        rejectChannels: {},
        rejectThresholdUv: null,
        epochLengthMs: null,
        source: 'result',
      },
    })

    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())

    // Канал по умолчанию — Fp1: своя зона плюс зона всего монтажа; зона O1 чужая
    expect(screen.getByText('артефактов в окне: 2')).toBeInTheDocument()
    expect(screen.getByLabelText('Легенда слоёв')).toBeInTheDocument()
    expect(screen.queryByText('артефакты не рассчитаны')).not.toBeInTheDocument()
  })

  it('говорит «артефакты не рассчитаны» вместо выдуманных зон', async () => {
    mockApiFetch()
    openRecording() // Стадию «Артефакты» в EDF ещё не считали: layers === null

    renderWithProviders(<EegSection />)
    await waitFor(() => expect(screen.getByTestId('eeg-track-canvas')).toBeInTheDocument())

    expect(screen.getByText('артефакты не рассчитаны')).toBeInTheDocument()
    expect(screen.queryByLabelText('Легенда слоёв')).not.toBeInTheDocument()
  })
})

