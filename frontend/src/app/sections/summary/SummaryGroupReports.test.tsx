/**
 * Тесты отчётов группового анализа в «Итогах» (Тип 1 «Сравнение», Тип 2
 * «Группа»): переключатель видов, выбор источника из истории **без** сборки
 * (правило «правка ≠ расчёт»), сборка только кнопкой в шапке и iframe по
 * `html_url` с `?v=` (версия ассета).
 *
 * Мок: `GET /jobs` отдаёт завершённое сравнение, `GET /group/analyses` —
 * историю прогонов; `GET …/report` — метаданные ленивой сборки
 * (`reportHtmlOutFixture`). iframe в jsdom `src` не грузит — проверяется адрес.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { SummaryPanel } from './SummaryPanel'
import { SummarySection } from './SummarySection'
import { SummaryToolActions } from './SummaryToolActions'
import { EMPTY_PASSPORT, useEdfRecording } from '@/shared/state/edfRecording'
import { useSummaryReport } from '@/shared/state/summaryReport'
import { mockApiFetch } from '@/test/apiMocks'
import { groupRunSummaryFixture, jobFixture, recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

const COMPARE_JOB = {
  ...jobFixture,
  job_id: 'job-compare-1',
  kind: 'compare',
  status: 'succeeded',
  stage: 'done',
  progress: 1,
  filename: 'rest.edf ↔ task.edf',
} as const

function setRecording(active: boolean) {
  useEdfRecording.setState({
    recording: active ? recordingFixture : null,
    demo: null,
    layers: null,
    epochMarks: [],
    passport: { ...EMPTY_PASSPORT },
  })
}

/** Полный сброс среза: вид и источники — состояние сессии, их чистит beforeEach. */
function resetSummary() {
  useSummaryReport.setState({
    bandKeys: null,
    gridMm: 7,
    job: null,
    jobId: null,
    result: null,
    error: null,
    kind: 'record',
    compareJobId: null,
    compareReport: null,
    compareBuilding: false,
    compareError: null,
    groupRunId: null,
    groupReport: null,
    groupBuilding: false,
    groupError: null,
  })
}

function renderSummary() {
  return renderWithProviders(
    <>
      <SummarySection />
      <SummaryToolActions />
      <SummaryPanel />
    </>,
  )
}

/** Сколько запросов ушло на сборку отчётов (`…/report` без `/html`). */
function reportBuildCalls(fetchMock: ReturnType<typeof mockApiFetch>): number {
  return fetchMock.mock.calls.filter((call) => {
    const url = String(call[0])
    return /\/report(\?|$)/.test(url)
  }).length
}

describe('«Итоги»: отчёты группового анализа (оба типа)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetSummary()
    setRecording(false)
  })

  it('переключатель видов есть; «Сравнение» без источника — кнопка выключена', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch({ jobs: [COMPARE_JOB] })
    renderSummary()

    expect(screen.getByTestId('summary-kind')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Сравнение (Тип 1)' }))

    // Групповые виды живут без открытой записи: плейсхолдер про EDF не показывается
    expect(screen.queryByText('Итоги — автоотчёт пайплайна')).not.toBeInTheDocument()
    expect(screen.getByText('Отчёт ещё не собран')).toBeInTheDocument()
    expect(screen.getByText(/Выберите сравнение из истории задач/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Собрать отчёт/ })).toBeDisabled()
    // Переключение — чистая отрисовка: сборка не запускалась
    expect(reportBuildCalls(fetchMock)).toBe(0)
  })

  it('Тип 1: выбор сравнения не считает; сборка по кнопке → iframe и ссылка', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch({ jobs: [COMPARE_JOB] })
    renderSummary()

    await user.click(screen.getByRole('button', { name: 'Сравнение (Тип 1)' }))
    const select = await screen.findByLabelText('Сравнение')
    await user.selectOptions(select, 'job-compare-1')

    // Правка источника: запроса сборки нет, кнопка уже активна
    expect(reportBuildCalls(fetchMock)).toBe(0)
    const runButton = screen.getByRole('button', { name: /Собрать отчёт/ })
    expect(runButton).toBeEnabled()

    await user.click(runButton)

    const frame = await screen.findByTestId('summary-frame')
    expect(frame.getAttribute('src')).toBe(
      '/api/v1/compare/job-compare-1/report/html?v=ghrep0rt0000abcd',
    )
    expect(screen.getByTestId('summary-strip')).toHaveTextContent('Сравнение: Покой ↔ Деятельность')
    expect(screen.getByTestId('summary-open')).toHaveAttribute(
      'href',
      '/api/v1/compare/job-compare-1/report/html?v=ghrep0rt0000abcd',
    )
    expect(reportBuildCalls(fetchMock)).toBe(1)
    expect(screen.getByRole('button', { name: /Пересобрать отчёт/ })).toBeInTheDocument()
  })

  it('Тип 2: выбор прогона из истории → сборка по кнопке → iframe с версией', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch({ groupRuns: [groupRunSummaryFixture()] })
    renderSummary()

    await user.click(screen.getByRole('button', { name: 'Группа (Тип 2)' }))
    const select = await screen.findByLabelText('Прогон')
    await user.selectOptions(select, '7')
    expect(reportBuildCalls(fetchMock)).toBe(0)

    await user.click(screen.getByRole('button', { name: /Собрать отчёт/ }))

    const frame = await screen.findByTestId('summary-frame')
    expect(frame.getAttribute('src')).toBe(
      '/api/v1/group/analyses/7/report/html?v=ghrep0rt0000abcd',
    )
    expect(screen.getByTestId('summary-strip')).toHaveTextContent(
      'Группа: покой vs деятельность (полоса alpha)',
    )
    expect(reportBuildCalls(fetchMock)).toBe(1)
  })

  it('смена источника убирает прежний документ — новый только по кнопке', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      groupRuns: [groupRunSummaryFixture(), groupRunSummaryFixture({ id: 8 })],
    })
    renderSummary()

    await user.click(screen.getByRole('button', { name: 'Группа (Тип 2)' }))
    await user.selectOptions(await screen.findByLabelText('Прогон'), '7')
    await user.click(screen.getByRole('button', { name: /Собрать отчёт/ }))
    await screen.findByTestId('summary-frame')

    // Правка источника не запускает расчёт и убирает старый документ
    // (результат принадлежит выбранному прогону)
    await user.selectOptions(screen.getByLabelText('Прогон'), '8')
    expect(screen.queryByTestId('summary-frame')).not.toBeInTheDocument()
    expect(screen.getByText('Отчёт ещё не собран')).toBeInTheDocument()
  })

  it('ошибка сборки показывается текстом сервера и не роняет раздел', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      groupRuns: [groupRunSummaryFixture()],
      groupReportFails: 'Прогон 7 не найден',
    })
    renderSummary()

    await user.click(screen.getByRole('button', { name: 'Группа (Тип 2)' }))
    await user.selectOptions(await screen.findByLabelText('Прогон'), '7')
    await user.click(screen.getByRole('button', { name: /Собрать отчёт/ }))

    expect(await screen.findByTestId('summary-error')).toHaveTextContent('Прогон 7 не найден')
    expect(screen.queryByTestId('summary-frame')).not.toBeInTheDocument()
  })
})

