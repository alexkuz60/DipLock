/**
 * Т5: черновик правила из профиля — кандидаты условий без авто-вердикта.
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { RuleDraftForm } from './RuleDraftForm'

describe('RuleDraftForm (Т5)', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      params: { ...CALC_PARAM_DEFAULTS },
      batch: null,
      batchJob: null,
      batchError: null,
      activeBandKey: null,
      playbackBandKeys: [],
      result: null,
    })
    useEdfRecording.setState({ recording: recordingFixture })
  })

  it('без записи и полосы объясняет, когда доступен черновик', () => {
    mockApiFetch()
    renderWithProviders(<RuleDraftForm bandKey={null} />)
    expect(screen.getByTestId('rule-draft-empty')).toBeInTheDocument()
  })

  it('собирает черновик из профиля: условия без min_share', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<RuleDraftForm bandKey="alpha" />)

    await user.click(screen.getByRole('button', { name: 'Собрать черновик' }))
    const list = await screen.findByTestId('rule-draft-conditions')
    expect(list).toHaveTextContent('kd_passed_share')
    expect(list).toHaveTextContent('rotation_ccw_share')
    expect(list).toHaveTextContent('min_share не задан')
  })

  it('сохраняет черновик в библиотеку по кнопке', async () => {
    const user = userEvent.setup()
    const fetchSpy = mockApiFetch()
    renderWithProviders(<RuleDraftForm bandKey="alpha" />)

    await user.click(screen.getByRole('button', { name: 'Собрать черновик' }))
    await screen.findByTestId('rule-draft-conditions')
    await user.click(screen.getByRole('button', { name: 'Сохранить в библиотеку' }))
    await waitFor(() =>
      expect(screen.getByText(/Сохранено в библиотеку/)).toBeInTheDocument(),
    )
    const saves = fetchSpy.mock.calls.filter(([input]) =>
      String(input).endsWith('/hypotheses'),
    )
    expect(saves.length).toBeGreaterThan(0)
    expect(saves.some(([, init]) => init?.method === 'POST')).toBe(true)
  })
})
