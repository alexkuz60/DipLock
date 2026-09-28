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

  // Три слоя видимости (шаг 2 плана): каждый слой явно назван — это отдельные
  // срезы, а не тихая подмена сырого вьюера (N14 остаётся в силе)
  it('слой «после очистки» — явная пометка «сигнал расчётов», а не сырой трек', () => {
    renderWithProviders(<ViewerSignalCaption filterDesign={null} layer="cleaned" />)
    const pill = screen.getByText('треки: после очистки (сигнал расчётов)')
    expect(pill).toBeInTheDocument()
    const title = pill.closest('span[title]')?.getAttribute('title') ?? ''
    expect(title).toContain('Отдельный срез, а не подмена сырого вьюера')
    expect(title).toContain('«Фильтр и референс»')
    // Сырой слой больше не показан — старой подписи на экране нет
    expect(screen.queryByText('треки: исходный сигнал без фильтра')).not.toBeInTheDocument()
  })

  it('слой «разница» называет вклад очистки и его базу', () => {
    renderWithProviders(<ViewerSignalCaption filterDesign={null} layer="diff" />)
    const pill = screen.getByText('треки: разница — вклад очистки')
    const title = pill.closest('span[title]')?.getAttribute('title') ?? ''
    expect(title).toContain('без очистки) − (с очисткой)')
    expect(title).toContain('без запуска расчёта')
  })

  it('слой «по полосе» называет персист и ключ (Фаза B)', () => {
    renderWithProviders(<ViewerSignalCaption filterDesign={null} layer="band" />)
    const pill = screen.getByText('треки: подготовленная полоса (персист)')
    expect(pill).toBeInTheDocument()
    const title = pill.closest('span[title]')?.getAttribute('title') ?? ''
    expect(title).toContain('Персист подготовленного массива')
    expect(title).toContain('«запись + полоса + notch + референс»')
  })

  it('устаревший слой — отдельная warn-пилюля с объяснением обновления', () => {
    renderWithProviders(
      <ViewerSignalCaption filterDesign={null} layer="cleaned" stale />,
    )
    expect(screen.getByText('слой по прежним параметрам')).toBeInTheDocument()
    expect(
      screen.getByText('слой по прежним параметрам').closest('span[title]')?.getAttribute('title'),
    ).toContain('переключении слоя или уровня зума')
  })

  it('для сырого слоя warn-пилюля не показывается', () => {
    renderWithProviders(<ViewerSignalCaption filterDesign={null} layer="raw" stale />)
    expect(screen.queryByText('слой по прежним параметрам')).not.toBeInTheDocument()
  })
})