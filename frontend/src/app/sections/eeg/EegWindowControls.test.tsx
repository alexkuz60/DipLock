/**
 * Тесты контролов окна раздела «ЭЭГ» (`EegWindowControls`).
 *
 * Контрол общий с EDF (разметка вынесена в `shared/ui/ZoomNavControls`), но
 * состояние у разделов своё: уровень зума пишется в свои параметры, а листание
 * окна уходит командой в свой стор (`eegNav`) — у «ЭЭГ» окно принадлежит
 * разделу, а не локальному вьюеру. Здесь проверяются три обещания разметки:
 * комбо пишет уровень в свой стор, кнопки `<< < > >>` пишут команду со растущим
 * `seq`, а правка зума **не** обесценивает результат расчёта.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { EegWindowControls } from './EegWindowControls'
import { EdfZoomSelect } from '../EdfZoomSelect'
import { EDF_PARAM_DEFAULTS, emptyStageSnapshot, useEdfParams } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { EEG_PARAM_DEFAULTS, eegSignature, useEegParams } from '@/shared/state/eegParams'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('контролы окна раздела «ЭЭГ»', () => {
  beforeEach(() => {
    localStorage.clear()
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, filter: { ...EEG_PARAM_DEFAULTS.filter } },
      eegNav: null,
      result: null,
      grid: null,
    })
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
    useEdfRecording.setState({ navRequest: null })
  })

  it('пишет уровень зума в свои параметры и не обесценивает расчёт', async () => {
    const user = userEvent.setup()
    const before = eegSignature(useEegParams.getState().params)
    renderWithProviders(<EegWindowControls />)

    await user.selectOptions(screen.getByLabelText('Зум окна ЭЭГ и спектрограммы'), '3')

    expect(useEegParams.getState().params.timeLevel).toBe(3)
    // Зум и листание — параметры просмотра: отпечаток расчёта не меняется
    expect(eegSignature(useEegParams.getState().params)).toBe(before)
  })

  it('выключает листание при ×1 и умеет листать при зуме', async () => {
    const user = userEvent.setup()
    renderWithProviders(<EegWindowControls />)

    // ×1 — вся запись в окне: листать нечего
    expect(screen.getByRole('button', { name: 'Следующее окно' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'В начало записи' })).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Зум окна ЭЭГ и спектрограммы'), '1')
    const next = screen.getByRole('button', { name: 'Следующее окно' })
    expect(next).toBeEnabled()

    await user.click(next)
    await user.click(next)
    const nav = useEegParams.getState().eegNav
    expect(nav?.command).toBe('next')
    // Счётчик растёт: повторная команда не «проигрывается» как старая
    expect(nav?.seq).toBe(2)
    // Команда идёт в свой стор: окно EDF не трогаем
    expect(useEdfRecording.getState().navRequest).toBeNull()
  })

  it('держится одного контрола с EDF: правки расходятся по своим сторам', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <>
        <EegWindowControls />
        <EdfZoomSelect />
      </>,
    )

    // Селектов два, они подписаны по-разному: пользователь не путает, что зумит
    await user.selectOptions(screen.getByLabelText('Зум отрисовки ЭЭГ'), '2')

    expect(useEdfParams.getState().params.timeLevel).toBe(2)
    expect(useEegParams.getState().params.timeLevel).toBe(0)
  })
})
