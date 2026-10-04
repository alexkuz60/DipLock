/**
 * Тесты карточки результата eLORETA (остаток B9): пик с анатомией, ROI-доли
 * с «прочими», честные подписи при отсутствии атласа (п.5 dipoles.md).
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { eloretaResultFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'
import { EloretaCard } from './EloretaCard'

describe('EloretaCard', () => {
  it('показывает пик с анатомией, ROI-доли и «прочие»', () => {
    renderWithProviders(<EloretaCard epochIndex={2} result={eloretaResultFixture()} />)

    const card = screen.getByTestId('eloreta-card-2')
    expect(card).toHaveTextContent('eLORETA — эпоха 3')
    // Пик: координаты, структура, поле Бродмана, условная сила
    expect(card).toHaveTextContent('[-42, -18, 61] мм')
    expect(card).toHaveTextContent('Left Precentral')
    expect(card).toHaveTextContent('BA4')
    // ROI: доли в процентах + строка «Прочие»
    const table = screen.getByTestId('eloreta-roi-2')
    expect(table).toHaveTextContent('42.0 %')
    expect(table).toHaveTextContent('18.0 %')
    expect(screen.getByTestId('eloreta-other-2')).toHaveTextContent('29.0 %')
    // Кавет «не замена точечного фита» доезжает до пользователя
    expect(card).toHaveTextContent('не замена точечного фита')
  })

  it('без атласа: честная пустая ROI-подпись, координаты пика остаются', () => {
    renderWithProviders(
      <EloretaCard
        epochIndex={0}
        result={eloretaResultFixture({ roi: [], other_share: 1 })}
      />,
    )

    expect(screen.queryByTestId('eloreta-roi-0')).not.toBeInTheDocument()
    expect(screen.getByText('ROI-доли не посчитаны (атлас недоступен)')).toBeInTheDocument()
    // Пик при этом не пропадает — координаты есть всегда
    expect(screen.getByTestId('eloreta-card-0')).toHaveTextContent('[-42, -18, 61] мм')
  })
})
