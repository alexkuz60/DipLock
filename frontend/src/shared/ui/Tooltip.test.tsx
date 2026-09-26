/**
 * Тесты тултипа: сторона по умолчанию — снизу под триггером (подсказки кнопок в
 * хедерах не перекрывают соседние кнопки; зазор между кнопками `gap-2` даёт
 * сброс hover) и прокидка явной стороны (`side`).
 *
 * `Content` мокается: реальный Radix в jsdom без layout по collision detection
 * инвертирует запрошенную сторону — здесь проверяется сторона, которую компонент
 * просит у Radix, а не фактическое размещение.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Tooltip } from './Tooltip'
import { renderWithProviders } from '@/test/renderWithProviders'

vi.mock('@radix-ui/react-tooltip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@radix-ui/react-tooltip')>()
  return {
    ...actual,
    Content: ({ side, children }: { side?: string; children?: ReactNode }) => (
      // Строки children — текст подсказки; Arrow и прочие элементы не рендерим
      // (они ждут контекст Popper реального Content)
      <div role="tooltip" data-side={side}>
        {Array.isArray(children) ? children.filter((child) => typeof child === 'string') : children}
      </div>
    ),
  }
})

describe('тултип', () => {
  it('по умолчанию открывается снизу под триггером', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Tooltip label="Подсказка кнопки">
        <button type="button">Кнопка</button>
      </Tooltip>,
    )

    // Наведение открывает подсказку после delayDuration (300 мс)
    await user.hover(screen.getByRole('button', { name: 'Кнопка' }))
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent('Подсказка кнопки')
    expect(tip).toHaveAttribute('data-side', 'bottom')
  })

  it('явная сторона триггера прокидывается в контент', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Tooltip label="Подсказка рейла" side="right">
        <button type="button">Иконка</button>
      </Tooltip>,
    )

    await user.hover(screen.getByRole('button', { name: 'Иконка' }))
    expect(await screen.findByRole('tooltip')).toHaveAttribute('data-side', 'right')
  })
})
