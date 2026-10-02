/**
 * Тесты карты каналов EDF: силуэт головы, датчики с именами, вкл/выкл по клику
 * и чекбокс-фолбэк для каналов вне монтажа (без позиций из /meta).
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HeadChannelMap } from './HeadChannelMap'
import { renderWithProviders } from '@/test/renderWithProviders'

const POSITIONS = {
  Fp1: [-0.253, 0.722],
  Cz: [0.003, -0.079],
  O1: [-0.253, -0.967],
}

describe('HeadChannelMap', () => {
  it('рисует силуэт с именованными датчиками и переключает канал по клику', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderWithProviders(
      <HeadChannelMap
        channels={['Fp1', 'Cz', 'O1']}
        positions={POSITIONS}
        selected={['Fp1', 'Cz']}
        onToggle={onToggle}
      />,
    )

    expect(screen.getByTestId('head-channel-map')).toBeInTheDocument()
    const fp1 = screen.getByRole('button', { name: 'Fp1' })
    expect(fp1).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'O1' })).toHaveAttribute('aria-pressed', 'false')

    await user.click(fp1)
    expect(onToggle).toHaveBeenCalledWith('Fp1')

    // Клавиатура: роль button обязана работать с Enter/Space
    screen.getByRole('button', { name: 'Cz' }).focus()
    await user.keyboard('{Enter}')
    expect(onToggle).toHaveBeenLastCalledWith('Cz')
  })

  it('канал вне монтажа не пропадает — остаётся чекбоксом под картой', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderWithProviders(
      <HeadChannelMap channels={['Fp1', 'X9']} positions={POSITIONS} selected={['Fp1']} onToggle={onToggle} />,
    )

    // Датчик на карте и чекбокс под ней — одно и то же действие
    await user.click(screen.getByRole('button', { name: 'Fp1' }))
    await user.click(screen.getByLabelText('X9'))

    expect(onToggle).toHaveBeenNthCalledWith(1, 'Fp1')
    expect(onToggle).toHaveBeenNthCalledWith(2, 'X9')
  })

  it('без позиций (/meta не ответил) — прежний список чекбоксов', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderWithProviders(
      <HeadChannelMap channels={['Fp1', 'Fp2']} positions={{}} selected={['Fp1']} onToggle={onToggle} />,
    )

    expect(screen.queryByTestId('head-channel-map')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Fp1')).toBeChecked()

    await user.click(screen.getByLabelText('Fp2'))
    expect(onToggle).toHaveBeenCalledWith('Fp2')
  })

  it('схема 10-20 подписывает датчики классическими именами, клик — по каноническому', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderWithProviders(
      <HeadChannelMap
        channels={['T7', 'Cz']}
        positions={{ ...POSITIONS, T7: [0.8, 0.1] }}
        selected={['T7']}
        onToggle={onToggle}
        naming="10-20"
      />,
    )

    // T7 показан под классическим именем T3, канонического «T7» на карте нет
    expect(screen.getByRole('button', { name: 'T3' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'T7' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'T3' }))
    // Действие — каноническое имя: расчёт и состояние его и знают
    expect(onToggle).toHaveBeenCalledWith('T7')
  })
})
