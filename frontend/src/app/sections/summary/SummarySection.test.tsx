/**
 * Тесты раздела «Итоги»: плейсхолдеры, запуск сборки отчёта **только кнопкой**,
 * показ результата (iframe на HTML MNE.Report) и обработка ошибки задачи.
 *
 * Задача `kind=report`: мок отвечает 202 → поллинг `/jobs` succeeded →
 * результат с `html_url`; iframe в jsdom `src` не грузит, поэтому проверяется
 * адрес, а не содержимое документа (живой HTML смотрит pytest).
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { SummaryPanel } from './SummaryPanel'
import { SummarySection } from './SummarySection'
import { SummaryToolActions } from './SummaryToolActions'
import { EmoLabSection, NeuroAudioSection } from '../Stubs'
import { EMPTY_PASSPORT, useEdfRecording } from '@/shared/state/edfRecording'
import { useSummaryReport } from '@/shared/state/summaryReport'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture, reportResultFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

function setRecording(active: boolean) {
  useEdfRecording.setState({
    recording: active ? recordingFixture : null,
    demo: null,
    layers: null,
    epochMarks: [],
    passport: { ...EMPTY_PASSPORT },
  })
}

function renderSummary() {
  return renderWithProviders(
    <>
      <SummarySection />
      <SummaryToolActions />
    </>,
  )
}

describe('раздел «Итоги»', () => {
  beforeEach(() => {
    localStorage.clear()
    useSummaryReport.setState({
      bandKeys: null,
      gridMm: 7,
      job: null,
      jobId: null,
      result: null,
      error: null,
    })
    setRecording(false)
  })

  it('без записи — плейсхолдер с просьбой загрузить EDF в разделе EDF', () => {
    mockApiFetch()
    renderSummary()

    expect(screen.getByText('Итоги — автоотчёт пайплайна')).toBeInTheDocument()
    expect(screen.getByText(/Загрузите EDF в разделе/)).toBeInTheDocument()
  })

  it('с записью без отчёта — описаны обе части, кнопка активна (расчёта нет)', () => {
    mockApiFetch()
    setRecording(true)
    renderSummary()

    expect(screen.getByText('Отчёт ещё не собран')).toBeInTheDocument()
    expect(screen.getByText(/Часть 1 — светофор и числа QC/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Собрать отчёт/ })).toBeEnabled()
    expect(screen.queryByTestId('summary-frame')).not.toBeInTheDocument()
  })

  it('сборка по кнопке: 202 → поллинг → результат → iframe и сводка QC', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    setRecording(true)
    renderSummary()

    await user.click(screen.getByRole('button', { name: /Собрать отчёт/ }))

    const frame = await screen.findByTestId('summary-frame')
    const htmlUrl = `/api/v1/recordings/${recordingFixture.recording_id}/report/job-report-1/html`
    expect(frame.getAttribute('src')).toBe(`${htmlUrl}?v=rep1234abcd0000`)
    expect(screen.getByTestId('summary-strip')).toHaveTextContent('QC: ок')
    expect(screen.getByTestId('summary-strip')).toHaveTextContent('Эпох: 9 из 10')
    expect(screen.getByTestId('summary-strip')).toHaveTextContent('Полос пакета: 2')
    // Ссылка «Открыть отчёт» ведёт на тот же HTML (в новую вкладку)
    expect(screen.getByTestId('summary-open')).toHaveAttribute('href', `${htmlUrl}?v=rep1234abcd0000`)
    // Запуск — только POST задачи отчёта (плюс чтение /meta)
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/report'))).toBe(true)
  })

  it('правки параметров панели не запускают сборку (запросов не прибавилось)', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    setRecording(true)
    renderWithProviders(<SummaryPanel />)
    const checkboxes = await screen.findAllByRole('checkbox')
    expect(checkboxes.length).toBeGreaterThan(1)

    const before = fetchMock.mock.calls.length
    await user.click(checkboxes[0])
    expect(fetchMock.mock.calls.length).toBe(before)
    expect(useSummaryReport.getState().bandKeys).not.toBeNull()
  })

  it('отказ запуска (404) — текст сервера в плейсхолдере ошибки', async () => {
    const user = userEvent.setup()
    mockApiFetch({ calcStartFails: true })
    setRecording(true)
    renderSummary()

    await user.click(screen.getByRole('button', { name: /Собрать отчёт/ }))

    expect(await screen.findByTestId('summary-error')).toHaveTextContent(
      'Запись не найдена или уже удалена',
    )
    expect(screen.getByText('Отчёт не собран')).toBeInTheDocument()
  })

  it('запись сменилась — результат прежней записи сбрасывается', () => {
    mockApiFetch()
    setRecording(true)
    useSummaryReport.setState({
      result: {
        recording_id: 'rec-old',
        filename: 'old.edf',
        html_sig: 'sig-old',
        report_version: 'v-old',
        html_url: '/api/v1/recordings/rec-old/report/job-old/html',
        qc: { status: 'ok', good_data_percent: 99, n_channels: 5 },
        reference: 'average',
        filter_method: 'fir',
        n_epochs_total: 5,
        n_epochs_used: 5,
        rejected_epochs: 0,
        duration_sec_calc: 1,
      },
    })
    renderSummary()

    // Сброс — в эффекте: плейсхолдер «не собран» вместо чужого iframe
    expect(screen.getByText('Отчёт ещё не собран')).toBeInTheDocument()
    expect(useSummaryReport.getState().result).toBeNull()
  })

  it('часть 3: вкладка «Динамика» — таймлайн, таблицы топов и переключение полосы', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    setRecording(true)
    useSummaryReport.setState({ result: reportResultFixture() })
    renderSummary()

    await user.click(screen.getByTestId('summary-view-dynamics'))

    // Вид сменился: динамика есть, документа (iframe) в этом виде нет
    expect(screen.getByTestId('summary-dynamics')).toBeInTheDocument()
    expect(screen.queryByTestId('summary-frame')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Полоса')).toHaveValue('theta')
    expect(screen.getByText('Таймлайн топ-структур (5 бинов по эпохам)')).toBeInTheDocument()
    expect(screen.getAllByText('Precuneus').length).toBeGreaterThan(0)
    expect(screen.getByText('BA7-lh')).toBeInTheDocument()
    expect(screen.getByTestId('summary-dynamics-export')).toBeInTheDocument()

    // Переключение полосы — чистая отрисовка, запросов не прибавилось
    const fetchMock = mockApiFetch()
    const before = fetchMock.mock.calls.length
    await user.selectOptions(screen.getByLabelText('Полоса'), 'alpha')
    expect(screen.getByLabelText('Полоса')).toHaveValue('alpha')
    expect(fetchMock.mock.calls.length).toBe(before)

    // Возврат к документу — тот же iframe
    await user.click(screen.getByTestId('summary-view-html'))
    expect(screen.getByTestId('summary-frame')).toBeInTheDocument()
    expect(screen.queryByTestId('summary-dynamics')).not.toBeInTheDocument()
  })

  it('4.5: вкладка «ROI» — таблицы агрегата, подпись GOF и переключение без запросов', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    setRecording(true)
    useSummaryReport.setState({ result: reportResultFixture() })
    renderSummary()

    await user.click(screen.getByTestId('summary-view-roi'))

    expect(screen.getByTestId('summary-roi')).toBeInTheDocument()
    expect(screen.queryByTestId('summary-frame')).not.toBeInTheDocument()
    // Обязательная подпись: GOF сравнивается только внутри полосы (принцип 3)
    expect(screen.getByText(/только внутри выбранной полосы/)).toBeInTheDocument()
    // Числа фикстуры: ячейка theta первой структуры + полушария
    expect(screen.getAllByText('Precuneus (слева)').length).toBeGreaterThan(0)
    expect(screen.getByTestId('summary-roi-meta')).toHaveTextContent('точек: 18')
    expect(screen.getByTestId('summary-roi-meta')).toHaveTextContent('полушария: слева 10 · справа 6')

    // Селект полосы и экспорт — чистая отрисовка/скачивание, запросов не прибавилось
    const fetchMock = mockApiFetch()
    const before = fetchMock.mock.calls.length
    await user.selectOptions(screen.getByLabelText('Полоса'), 'alpha')
    expect(screen.getByLabelText('Полоса')).toHaveValue('alpha')
    expect(fetchMock.mock.calls.length).toBe(before)
    expect(screen.getByTestId('summary-roi-export')).toBeInTheDocument()

    // Возврат к документу — тот же iframe
    await user.click(screen.getByTestId('summary-view-html'))
    expect(screen.getByTestId('summary-frame')).toBeInTheDocument()
  })

  it('4.5: результат без roi (старый отчёт) — честная заглушка вкладки', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    setRecording(true)
    useSummaryReport.setState({ result: reportResultFixture({ roi: null }) })
    renderSummary()

    await user.click(screen.getByTestId('summary-view-roi'))

    expect(screen.getByTestId('summary-roi-missing')).toBeInTheDocument()
    expect(screen.queryByTestId('summary-roi')).not.toBeInTheDocument()
  })
})

describe('заглушки новых направлений', () => {
  it('ЕмоЛаб показывает план раздела', () => {
    mockApiFetch()
    renderWithProviders(<EmoLabSection />)
    expect(screen.getByText(/ЕмоЛаб — психоэмоциональный фон/)).toBeInTheDocument()
    expect(screen.getByText(/Каталог маркеров аффективного фона/)).toBeInTheDocument()
  })

  it('Нейроаудио показывает план раздела', () => {
    mockApiFetch()
    renderWithProviders(<NeuroAudioSection />)
    expect(screen.getByText(/Нейроаудио — аудиовход и ритмы/)).toBeInTheDocument()
    expect(screen.getByText(/События аудиовхода из записи/)).toBeInTheDocument()
  })
})
