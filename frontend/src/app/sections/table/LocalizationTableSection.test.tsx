/**
 * Тесты раздела «Таблица локализации» (срез 4).
 *
 * Главное правило раздела: он **показывает результат и ничего не запрашивает** —
 * в тестах это проверяется напрямую (`fetch` не вызывался ни разу). Плюс
 * проверяется обещание «все результаты»: строки есть у всех точек результата,
 * включая точки без MNI (там прочерк), а порог «КД» из раздела «Диполи» таблицу
 * не фильтрует.
 */
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultColumnVisibility } from '@/shared/lib/tableRows'
import { CALC_PARAM_DEFAULTS, type CalcJob, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { TABLE_PARAM_DEFAULTS, useTableParams } from '@/shared/state/tableParams'
import { dipoleScanResultFixture, recordingFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { LocalizationTableSection } from './LocalizationTableSection'

/** Задача расчёта в состоянии: без обращения к серверу. */
function job(overrides: Partial<CalcJob> = {}): CalcJob {
  return {
    status: 'running',
    progress: 0.5,
    message: 'Быстрый расчёт по эпохам',
    stage: 'dipoles',
    epochsDone: 2,
    epochsTotal: 4,
    error: null,
    ...overrides,
  }
}

/** Порядок строк в DOM — как их видит пользователь. */
function rowOrder(): (string | null)[] {
  return screen.getAllByTestId(/^loc-row-/).map((row) => row.getAttribute('data-testid'))
}

describe('раздел «Таблица локализации»', () => {
  beforeEach(() => {
    localStorage.clear()
    useTableParams.setState({
      params: { ...TABLE_PARAM_DEFAULTS, columnVisibility: defaultColumnVisibility() },
    })
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS },
      amplitudeThresholdNam: 0,
      job: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      error: null,
      spectrumError: null,
      view: 'none',
    })
    useEdfRecording.setState({ recording: null })
    vi.stubGlobal('fetch', mockApiFetch())
  })

  it('без загруженной записи объясняет, что показать нечего, и не делает запросов', () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    renderWithProviders(<LocalizationTableSection />)

    expect(screen.getByText('Таблица локализации')).toBeInTheDocument()
    expect(screen.getByText(/Загрузите EDF в разделе «EDF» \(2\)/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('без результата показывает состояние задачи, а не пустую таблицу', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ job: job() })
    renderWithProviders(<LocalizationTableSection />)

    expect(screen.getByText('Расчёт диполей не выполнен')).toBeInTheDocument()
    expect(screen.getByText(/Расчёт выполняется: .*эпох 2 из 4/)).toBeInTheDocument()
    expect(screen.queryByTestId('localization-table-scroll')).not.toBeInTheDocument()
  })

  it('показывает ошибку расчёта, когда результата нет', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ error: 'Запись не найдена или уже удалена' })
    renderWithProviders(<LocalizationTableSection />)

    expect(
      screen.getByText('Ошибка расчёта: Запись не найдена или уже удалена'),
    ).toBeInTheDocument()
  })

  it('выводит все точки результата и сортирует их по номеру эпохи', () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<LocalizationTableSection />)

    // Четыре точки фикстуры — четыре строки, включая точку без MNI
    expect(rowOrder()).toEqual(['loc-row-0-120', 'loc-row-1-140', 'loc-row-2-60', 'loc-row-3-200'])
    expect(screen.getByText('Строк: 4 · расчёт актуален')).toBeInTheDocument()
    expect(screen.getByText('Быстрый режим, сетка 7 мм')).toBeInTheDocument()
    expect(screen.getByText('Сортировка: по номеру эпохи (возрастание)')).toBeInTheDocument()
    // Раздел сам ничего не запрашивает: результат уже в состоянии
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('переставляет строки по настройке панели и переворачивает таблицу', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    useTableParams.getState().setSortDirection('desc')
    renderWithProviders(<LocalizationTableSection />)

    expect(rowOrder()).toEqual(['loc-row-3-200', 'loc-row-2-60', 'loc-row-1-140', 'loc-row-0-120'])
    expect(screen.getByText('Сортировка: по номеру эпохи (убывание)')).toBeInTheDocument()
  })

  it('рисует только видимые колонки', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    useTableParams.getState().setColumnVisible('z', false)
    renderWithProviders(<LocalizationTableSection />)

    expect(screen.queryByTestId('loc-col-z')).not.toBeInTheDocument()
    expect(screen.queryByTestId('loc-cell-z-0-120')).not.toBeInTheDocument()
    expect(screen.getByTestId('loc-col-x')).toBeInTheDocument()
    expect(screen.getByText('Скрыто колонок: 1')).toBeInTheDocument()
  })

  it('показывает прочерк у точки без MNI и честно считает такие точки', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    renderWithProviders(<LocalizationTableSection />)

    const row = screen.getByTestId('loc-row-3-200')
    expect(within(row).getByTestId('loc-cell-x-3-200')).toHaveTextContent('—')
    expect(within(row).getByTestId('loc-cell-hemisphere-3-200')).toHaveTextContent('—')
    expect(row.getAttribute('title')).toContain('MNI нет')
    expect(
      screen.getByText('Точек без MNI: 1 — координаты «—» (на проекции не наводятся)'),
    ).toBeInTheDocument()
  })

  it('порог «КД» скрывает точки только на проекциях — в таблице остаются все', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture(), amplitudeThresholdNam: 200 })
    renderWithProviders(<LocalizationTableSection />)

    expect(screen.getAllByTestId(/^loc-row-/)).toHaveLength(4)
    expect(
      screen.getByText('Порог «КД ≥ 200 нАм» — только на проекциях: в таблице все точки'),
    ).toBeInTheDocument()
  })

  it('предупреждает, что результат посчитан на других параметрах', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      params: { ...CALC_PARAM_DEFAULTS, gridMm: 12 },
    })
    renderWithProviders(<LocalizationTableSection />)

    expect(
      screen.getByText('Параметры расчёта изменены — результат не пересчитан'),
    ).toBeInTheDocument()
    // Строки не пропадают: показывается то, что реально посчитано
    expect(screen.getAllByTestId(/^loc-row-/)).toHaveLength(4)
  })

  it('пустой результат объясняет причину, а не выглядит потерянным', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      result: dipoleScanResultFixture({ points: [], n_epochs_used: 0, n_epochs_total: 4 }),
    })
    renderWithProviders(<LocalizationTableSection />)

    expect(screen.getByText('В результате расчёта нет точек')).toBeInTheDocument()
    expect(screen.getByText(/Эпох прошло reject-фильтр: 0 из 4/)).toBeInTheDocument()
  })
})