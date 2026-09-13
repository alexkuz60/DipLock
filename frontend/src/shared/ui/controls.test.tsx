/** Тесты контролов правой панели: сегменты, список, число, чекбокс, статус. */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CheckboxRow } from './CheckboxRow'
import { NumberField } from './NumberField'
import { SegmentedControl } from './SegmentedControl'
import { SelectField } from './SelectField'
import { StatusPill } from './StatusPill'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('SegmentedControl', () => {
  it('помечает активный вариант и сообщает о выборе', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(
      <SegmentedControl
        label="Амплитуда"
        value="shared"
        options={[
          { value: 'shared', label: 'Общий' },
          { value: 'per_channel', label: 'Авто' },
        ]}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('group', { name: 'Амплитуда' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Общий' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Авто' }))

    expect(onChange).toHaveBeenCalledWith('per_channel')
  })
})

describe('SelectField', () => {
  it('отдаёт выбранное значение и связан с подписью', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(
      <SelectField
        label="Notch"
        value="0"
        options={[
          { value: '0', label: 'Выключен' },
          { value: '50', label: '50 Гц' },
        ]}
        onChange={onChange}
      />,
    )

    await user.selectOptions(screen.getByLabelText('Notch'), '50')

    expect(onChange).toHaveBeenCalledWith('50')
  })
})

describe('NumberField', () => {
  it('коммитит введённое число и показывает единицу измерения', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(<NumberField label="z-score" value={5} onChange={onChange} unit="мкВ" />)

    await user.clear(screen.getByLabelText('z-score'))
    await user.type(screen.getByLabelText('z-score'), '12')

    expect(onChange).toHaveBeenLastCalledWith(12)
    expect(screen.getByText('мкВ')).toBeInTheDocument()
  })

  it('зажимает значение по границам и нормализует поле на blur', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(
      <NumberField label="z-score" value={5} min={1} max={20} onChange={onChange} />,
    )
    const input = screen.getByLabelText('z-score')

    await user.clear(input)
    await user.type(input, '99')

    expect(onChange).toHaveBeenLastCalledWith(20)

    await user.tab()
    expect(input).toHaveValue(5)
  })

  it('не коммитит пустое и нечисловое значение', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(<NumberField label="z-score" value={5} onChange={onChange} />)
    const input = screen.getByLabelText('z-score')

    await user.clear(input)
    await user.type(input, 'e')

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('CheckboxRow', () => {
  it('переключает состояние кликом по подписи', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithProviders(<CheckboxRow label="Fp1" checked={false} onChange={onChange} mono />)

    await user.click(screen.getByLabelText('Fp1'))

    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('StatusPill', () => {
  it('подписывает статус текстом, а не только цветом', () => {
    renderWithProviders(<StatusPill tone="warn">Параметры изменены</StatusPill>)

    expect(screen.getByText('Параметры изменены')).toBeInTheDocument()
  })
})
