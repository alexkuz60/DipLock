/**
 * Тесты тулс-хедера раздела «Диполи» (срез 3.4).
 *
 * Проверяется правило «обработка — только по кнопке»: расчёт запускается
 * нажатием и показывается прогрессом по эпохам, порог «КД ≥ X нАм» правит
 * отображение (без единого запроса), а кнопки панелей лишь открывают одну
 * выдвижную панель за раз.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { calcJobFixture, dipoleScanResultFixture, recordingFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { DipolesToolHeaderActions } from './DipolesToolActions'

describe('тулс-хедер раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      view: 'none',
      amplitudeThresholdNam: 0,
      params: { ...CALC_PARAM_DEFAULTS },
      job: null,
      result: null,
      spectrumJob: null,
      spectrum: null,
      error: null,
      spectrumError: null,
    })
    useEdfRecording.setState({ recording: null })
  })

  it('без записи кнопка расчёта выключена и объясняет причину', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    const button = screen.getByRole('button', { name: 'Рассчитать диполи' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('загрузите EDF'))

    await user.click(button)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('запускает расчёт кнопкой: задача, поллинг и точки в состоянии', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Рассчитать диполи' }))

    const urls = fetchSpy.mock.calls.map(
      ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
    )
    expect(urls[0]).toBe('POST /api/v1/recordings/rec-1/dipoles')
    expect(useDipoleCalc.getState().result?.points).toHaveLength(4)
    // Кнопка меняет подпись: результат есть — предлагается пересчёт
    expect(screen.getByRole('button', { name: 'Пересчитать диполи' })).toBeInTheDocument()
    expect(screen.getByText('Быстрый режим: 4 точек')).toBeInTheDocument()
  })

  it('показывает прогресс по эпохам, пока задача идёт', () => {
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      job: {
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

    const bar = screen.getByRole('progressbar', { name: 'Прогресс расчёта диполей' })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText('эпох 2/4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Расчёт…' })).toBeDisabled()
  })

  it('порог «КД ≥» меняет состояние отображения и не делает запросов', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const fetchSpy = mockApiFetch()
    renderWithProviders(<DipolesToolHeaderActions />)

    const field = screen.getByLabelText('Порог момента диполя, нАм')
    await user.clear(field)
    await user.type(field, '60')

    expect(useDipoleCalc.getState().amplitudeThresholdNam).toBe(60)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('отправляет полосу и сетевой фильтр из панели в задачу (срез 3.6)', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: recordingFixture })
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS, filterPreset: 'alpha', filterBandHz: [8, 13], notchHz: 50 },
    })
    const fetchSpy = mockApiFetch({ calcJob: calcJobFixture })
    renderWithProviders(<DipolesToolHeaderActions />)

    await user.click(screen.getByRole('button', { name: 'Рассчитать диполи' }))

    // Полоса формы фильтров уходит в задачу как band_min/band_max — не «где-то
    // в состоянии, но не в запросе»
    const [, init] = fetchSpy.mock.calls[0]
    const form = init?.body as FormData
    expect(form.get('band_min')).toBe('8')
    expect(form.get('band_max')).toBe('13')
    expect(form.get('notch_hz')).toBe('50')
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
})
