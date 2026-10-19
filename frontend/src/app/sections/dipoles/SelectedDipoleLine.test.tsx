/**
 * Тесты строки выделенного диполя (с 19.10.2026 — секция «Локализация» панели
 * «Опции»; перенесена из рабочей области вместе с кнопкой «Снять выделение»).
 *
 * Проверяют обещание строки: у выбора есть читаемая подпись (эпоха, MNI,
 * атрибуция, момент, GOF), она не «теряется» при подъёме порога отображения
 * (порог — отрисовка, выбор — состояние просмотра), и выбор снимается кнопкой,
 * не требуя попадания мышью в точку. Точки берутся из того же слоя, что рисуют
 * проекции (`useDipoleLayer`).
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { dipoleScanResultFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { SelectedDipoleLine } from './SelectedDipoleLine'

describe('строка выделенного диполя (секция «Локализация»)', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      result: null,
      batch: null,
      gofThresholdPercent: 0,
      amplitudeThresholdNam: 0,
      selectedPointId: null,
    })
  })

  it('молчит, пока диполь не выбран', () => {
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })
    const { container } = renderWithProviders(<SelectedDipoleLine />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Снять выделение' })).not.toBeInTheDocument()
  })

  it('показывает подпись выбранного диполя: эпоху, MNI и атрибуцию', () => {
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      selectedPointId: '0-120',
    })
    renderWithProviders(<SelectedDipoleLine />)

    const pill = screen.getByText(/Выделен диполь: Эпоха 1, 0.120 с/)
    expect(pill).toBeInTheDocument()
    // Полная подпись (MNI, атрибуция, момент и GOF) — в самом тексте пилюли
    expect(pill).toHaveTextContent('MNI 12.0 / -34.5 / 18.0')
    expect(pill).toHaveTextContent('нАм, GOF')
    // Тултип-дубль убран: он дословно повторял текст пилюли
    expect(pill).not.toHaveAttribute('title')
    expect(screen.getByRole('button', { name: 'Снять выделение' })).toBeInTheDocument()
  })

  it('снимает выделение кнопкой «Снять выделение»', async () => {
    const user = userEvent.setup()
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      selectedPointId: '0-120',
    })
    renderWithProviders(<SelectedDipoleLine />)

    await user.click(screen.getByRole('button', { name: 'Снять выделение' }))

    expect(useDipoleCalc.getState().selectedPointId).toBeNull()
  })

  it('показывает подпись выделенного диполя и после подъёма порога отображения', () => {
    // Порог скрывает точку из отрисовки, но выделение не должно «теряться» в
    // подписи: выбор сделан раньше, а порог — параметр отображения
    useDipoleCalc.setState({
      result: dipoleScanResultFixture(),
      amplitudeThresholdNam: 500,
      selectedPointId: '0-120',
    })
    renderWithProviders(<SelectedDipoleLine />)

    expect(screen.getByText(/Выделен диполь: Эпоха 1, 0.120 с/)).toBeInTheDocument()
  })
})