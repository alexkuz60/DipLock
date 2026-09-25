/**
 * Подпись вьюера (N14, шаг 2.5): треки — исходный сигнал без фильтра.
 * Пирамида сигналов остаётся сырой намеренно, и UI обязан это называть.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ViewerSignalCaption } from './ViewerSignalCaption'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Тултип пилюли: в нём числа паспорта фильтра (N12/N14) */
function captionTitle(): string {
  return (
    screen.getByText('треки: исходный сигнал без фильтра').closest('span[title]')
      ?.getAttribute('title') ?? ''
  )
}

describe('ViewerSignalCaption', () => {
  it('всегда называет треки исходными — даже до первого расчёта', () => {
    renderWithProviders(<ViewerSignalCaption filterDesign={null} />)
    const pill = screen.getByText('треки: исходный сигнал без фильтра')
    expect(pill).toBeInTheDocument()
    expect(captionTitle()).toContain('без фильтра')
  })

  it('FIR: показывает ядро и краевой буфер из результата стадии', () => {
    renderWithProviders(
      <ViewerSignalCaption
        filterDesign={{ method: 'fir', lengthSec: 3.302, edgeBufferSec: 1.651 }}
      />,
    )
    const title = captionTitle()
    expect(title).toContain('FIR')
    expect(title).toContain('3.30 с')
    expect(title).toContain('±1.65 с')
    expect(title).toContain('BAD_edge')
  })

  it('IIR: честно сообщает, что края записи не режутся', () => {
    renderWithProviders(
      <ViewerSignalCaption
        filterDesign={{ method: 'iir', lengthSec: null, edgeBufferSec: 0 }}
      />,
    )
    const title = captionTitle()
    expect(title).toContain('IIR')
    expect(title).toContain('края записи не режутся')
  })
})