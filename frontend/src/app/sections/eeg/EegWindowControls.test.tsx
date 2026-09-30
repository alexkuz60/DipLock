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
import type { SignalFrame } from '@/shared/lib/signalFrame'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Кадр с пиками ±30 мкВ на весь срок записи: автозум обязан выбрать 20 мкВ/дел. */
function peakFrame(): SignalFrame {
  const channels = recordingFixture.channels ?? []
  const n = 30
  const duration = recordingFixture.duration_sec
  const min: Record<string, Float32Array> = {}
  const max: Record<string, Float32Array> = {}
  for (const name of channels) {
    min[name] = Float32Array.from({ length: n }, () => -30)
    max[name] = Float32Array.from({ length: n }, () => 30)
  }
  return {
    sourceId: recordingFixture.recording_id,
    channels: [...channels],
    durationSec: duration,
    times: Float32Array.from({ length: n }, (_, i) => (i + 0.5) * (duration / n)),
    min,
    max,
    decimated: true,
    level: 1,
  }
}

describe('контролы окна раздела «ЭЭГ»', () => {
  beforeEach(() => {
    localStorage.clear()
    // Компонент читает /meta (уровни пирамиды для автозума) — как и шапка в UI
    mockApiFetch()
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
    useEdfRecording.setState({ navRequest: null, recording: null, demo: null, signalFrames: {} })
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

  it('шагает шкалу амплитуды кнопками и не старит расчёт', async () => {
    const user = userEvent.setup()
    const before = eegSignature(useEegParams.getState().params)
    renderWithProviders(<EegWindowControls />)
    // Дефолт 50 мкВ/дел: приблизить — ступень вниз (20), отдалить — вверх (100)
    expect(screen.getByText('50 мкВ/дел')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Увеличить масштаб амплитуды' }))
    expect(useEegParams.getState().params.amplitudeUv).toBe(20)

    await user.click(screen.getByRole('button', { name: 'Уменьшить масштаб амплитуды' }))
    expect(useEegParams.getState().params.amplitudeUv).toBe(50)

    // Шкала — параметр просмотра: отпечаток расчёта не изменился, запросов нет
    expect(eegSignature(useEegParams.getState().params)).toBe(before)
  })

  it('на краях ряда амплитуды кнопки выключаются, а не «залипают» на пределе', () => {
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, amplitudeUv: 2, filter: { ...EEG_PARAM_DEFAULTS.filter } },
    })
    const view = renderWithProviders(<EegWindowControls />)
    // 2 мкВ/дел — минимум ряда: приблизить больше некуда
    expect(screen.getByRole('button', { name: 'Увеличить масштаб амплитуды' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Уменьшить масштаб амплитуды' })).toBeEnabled()
    view.unmount()

    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, amplitudeUv: 500, filter: { ...EEG_PARAM_DEFAULTS.filter } },
    })
    renderWithProviders(<EegWindowControls />)
    expect(screen.getByRole('button', { name: 'Уменьшить масштаб амплитуды' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Увеличить масштаб амплитуды' })).toBeEnabled()
  })

  it('автозум амплитуды подгоняет шкалу под пики видимого окна', async () => {
    const user = userEvent.setup()
    useEegParams.setState({
      params: { ...EEG_PARAM_DEFAULTS, amplitudeUv: 500, filter: { ...EEG_PARAM_DEFAULTS.filter } },
    })
    useEdfRecording.setState({
      recording: recordingFixture,
      demo: null,
      signalFrames: { raw: { sig: '', frames: { 1: peakFrame() } } },
    })
    renderWithProviders(<EegWindowControls />)

    await user.click(screen.getByRole('button', { name: 'Автозум амплитуды' }))

    // Пики ±30 → нужно деление ≥ 15 → ступень 20 мкВ/дел (было 500)
    expect(useEegParams.getState().params.amplitudeUv).toBe(20)
    // Автозум — параметр просмотра: отпечаток расчёта не изменился
    expect(eegSignature(useEegParams.getState().params)).toBe(
      eegSignature({ ...EEG_PARAM_DEFAULTS, amplitudeUv: 20, filter: { ...EEG_PARAM_DEFAULTS.filter } }),
    )
  })

  it('без кадров сигнала автозум выключена, а не «подгоняет» пустоту', () => {
    useEdfRecording.setState({
      recording: recordingFixture,
      demo: null,
      signalFrames: {},
    })
    renderWithProviders(<EegWindowControls />)

    expect(screen.getByRole('button', { name: 'Автозум амплитуды' })).toBeDisabled()
    expect(useEegParams.getState().params.amplitudeUv).toBe(EEG_PARAM_DEFAULTS.amplitudeUv)
  })
})
