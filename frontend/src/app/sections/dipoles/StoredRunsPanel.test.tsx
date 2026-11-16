/**
 * Тесты секции «Прогоны в БД» панели «Диполи»: список записанных прогонов и
 * показ любого из них **без пересчёта** (ни одного POST). Показ из файла
 * задачи — полный контракт; из точек БД — с честным предупреждением, чего в
 * них нет.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { analysisSummaryFixture } from '@/test/fixtures'
import { StoredRunsPanel } from './StoredRunsPanel'

describe('секция «Прогоны в БД»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      batch: null,
      batchJob: null,
      batchError: null,
      storedRun: null,
      restoring: false,
      restoreError: null,
      result: null,
      activeBandKey: null,
      playbackBandKeys: [],
      playback: { ...PLAYBACK_DEFAULTS },
    })
  })

  it('показывает прогоны записи и загружает выбранный без пересчёта', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch({
      analyses: {
        total: 2,
        items: [
          analysisSummaryFixture({ id: 7, params_sig: 'sig-first-run-1' }),
          analysisSummaryFixture({
            id: 8,
            job_id: 'job-batch-2',
            params_sig: 'sig-second-run-2',
            created_at: '2026-11-15T09:00:00',
          }),
        ],
      },
    })
    renderWithProviders(<StoredRunsPanel recordingId="rec-1" />)

    // Обе строки прогонов видны с параметрами и коротким отпечатком
    expect(
      await screen.findByText(/полос 2 · точек 3 · sig-firs/),
    ).toBeInTheDocument()

    const rows = screen.getAllByRole('listitem')
    await user.click(within(rows[1]).getByRole('button', { name: 'Показать' }))

    await waitFor(() => {
      expect(useDipoleCalc.getState().storedRun?.analysisId).toBe(8)
    })
    expect(useDipoleCalc.getState().batch).not.toBeNull()
    expect(within(rows[1]).getByText('Показано')).toBeInTheDocument()
    // Показ — не обработка: ни одного POST
    expect(
      fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toHaveLength(0)
  })

  it('прогон из точек БД помечен честным предупреждением о неполном составе', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      analyses: { total: 1, items: [analysisSummaryFixture({ id: 7 })] },
      dipoleBatchResultFails: 'Результат не сохранён',
    })
    renderWithProviders(<StoredRunsPanel recordingId="rec-1" />)

    await user.click(await screen.findByRole('button', { name: 'Показать' }))

    expect(
      await screen.findByText(/Прогон показан из БД: без кластеров и сопоставления полос/),
    ).toBeInTheDocument()
    expect(useDipoleCalc.getState().storedRun?.source).toBe('db-points')
  })

  it('пустой список и ошибка чтения объясняются текстом, а не пустым экраном', async () => {
    mockApiFetch({ analyses: { total: 0, items: [] } })
    const view = renderWithProviders(<StoredRunsPanel recordingId="rec-1" />)
    expect(await screen.findByText(/Прогонов в БД нет/)).toBeInTheDocument()
    view.unmount()

    mockApiFetch({ analysesFails: 'БД недоступна' })
    renderWithProviders(<StoredRunsPanel recordingId="rec-1" />)
    expect(await screen.findByText('Не удалось прочитать прогоны из БД.')).toBeInTheDocument()
  })

  it('без записи секция просит открыть запись и не делает запросов', () => {
    const fetchSpy = mockApiFetch()
    renderWithProviders(<StoredRunsPanel recordingId={null} />)

    expect(screen.getByText(/Откройте запись/)).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})