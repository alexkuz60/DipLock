/**
 * Тесты панели «Пакет поддиапазонов» (С1/С2).
 *
 * Прогон всегда идёт по всему каталогу кнопкой «Рассчитать пакет» в шапке — в
 * панели выбора полос прогона, чипов полос и кнопки запуска нет (правка
 * **ничего не запускает**, из запросов возможны только статические `/meta`).
 * Результат — набор: активная полоса (для таблицы) выбирается в разделе
 * «Таблица локализации», здесь — чекбоксы отображения. Таблицы «Сопоставление
 * полос» и «Кластеры диполей (С2)» — там же, во вкладках просмотра
 * (16.11.2026); в панели остаётся форма «Черновик правила из профиля» (Т5) —
 * она делает запросы.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CALC_PARAM_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { dipoleBatchResultFixture, recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { BatchPanel } from './BatchPanel'

describe('панель «Пакет поддиапазонов»', () => {
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

  it('без результата объясняет запуск из шапки и не делает запросов', async () => {
    const fetchSpy = mockApiFetch()
    renderWithProviders(<BatchPanel />)

    expect(
      screen.getByText(/Прогон идёт по всем полосам каталога кнопкой «Рассчитать пакет»/),
    ).toBeInTheDocument()
    // Ни чекбоксов полос прогона, ни кнопки запуска здесь больше нет
    expect(screen.queryByRole('button', { name: 'Считать пакет' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })

  it('показывает набор: чекбоксы отображения', async () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
      playbackBandKeys: ['alpha', 'beta'],
    })
    renderWithProviders(<BatchPanel />)

    // Секция «Полосы прогона» (чипы) удалена вместе с выбором полос прогона:
    // полосу таблицы выбирает сама таблица, здесь — только отображение
    expect(screen.queryByRole('button', { name: 'alpha (8–13 Гц)' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'alpha' })).toBeInTheDocument()
    expect(useDipoleCalc.getState().activeBandKey).toBe('alpha')
  })

  it('таблицы сопоставления и кластеров — в разделе «Таблица локализации»', async () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    // Таблицы перенесены во вкладки просмотра (16.11.2026): в панели остались
    // чекбоксы отображения и форма черновика правила
    expect(screen.queryByTestId('band-comparison')).not.toBeInTheDocument()
    expect(screen.queryByTestId('batch-cluster-features')).not.toBeInTheDocument()
    expect(
      screen.getByText(/Сопоставление полос и кластеры диполей — в разделе «Таблица/),
    ).toBeInTheDocument()
  })

  it('форма черновика правила остаётся в панели — она делает запросы', () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    expect(screen.getByTestId('rule-draft-form')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Собрать черновик' })).toBeInTheDocument()
  })

  it('переключение активной полосы — забота таблицы: панель её не трогает', async () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    // Ни чипов, ни списка полос в панели нет — активную полосу меняет только
    // «Полоса таблицы» в разделе «Таблица локализации»
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(useDipoleCalc.getState().activeBandKey).toBe('alpha')
  })

  it('чекбоксы полос управляют анимацией и облаком: от всех до одной', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
      playbackBandKeys: ['alpha', 'beta'],
    })
    renderWithProviders(<BatchPanel />)

    // Снять полосу — её больше нет в кадре и облаке
    await user.click(screen.getByRole('checkbox', { name: 'alpha' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['beta'])
    // Вернуть — снова обе
    await user.click(screen.getByRole('checkbox', { name: 'alpha' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['beta', 'alpha'])
    // Быстрая комбинация «только активная»
    await user.click(screen.getByRole('button', { name: 'Только активная' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['alpha'])
    // …и «все полосы»
    await user.click(screen.getByRole('button', { name: 'Все полосы' }))
    expect(useDipoleCalc.getState().playbackBandKeys).toEqual(['alpha', 'beta'])
  })

  it('кластерных таблиц в панели нет — они во вкладке раздела «Таблица локализации»', () => {
    useDipoleCalc.setState({
      batch: dipoleBatchResultFixture(),
      activeBandKey: 'alpha',
    })
    renderWithProviders(<BatchPanel />)

    // Кластерные таблицы — во вкладке «Кластеры диполей (С2)» раздела
    // «Таблица локализации» (проверяет LocalizationTableSection.test)
    expect(screen.queryByTestId('batch-cluster-features')).not.toBeInTheDocument()
  })
})
