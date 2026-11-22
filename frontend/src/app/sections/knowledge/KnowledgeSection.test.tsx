/**
 * «Знания»: подвкладки «Источники»/«База знаний», оглавление с аннотацией
 * и честный режим поиска без эмбеддингов.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeSection } from './KnowledgeSection'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

afterEach(() => vi.unstubAllGlobals())

describe('KnowledgeSection', () => {
  it('показывает папки и документы, открывает оглавление с аннотацией', async () => {
    mockApiFetch()
    renderWithProviders(<KnowledgeSection />, { route: '/consilium?view=knowledge' })

    expect(
      await screen.findByRole('button', { name: 'Источники (1)' }),
    ).toBeInTheDocument()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Бета-активность в височной области' }),
    )

    expect((await screen.findAllByText('Височная область')).length).toBeGreaterThan(0)
    expect(screen.getByText('Сверить с монтажом 10-20.')).toBeInTheDocument()
    expect(screen.getByText(/Теги: ЭЭГ/)).toBeInTheDocument()
  })

  it('переключает подвкладки через адрес', async () => {
    mockApiFetch()
    renderWithProviders(<KnowledgeSection />, { route: '/consilium?view=knowledge' })

    fireEvent.click(await screen.findByRole('button', { name: 'База знаний' }))
    expect(await screen.findByText('Поиск по библиотеке')).toBeInTheDocument()
    expect(screen.getByText('Граф знаний')).toBeInTheDocument()
  })

  it('ищет по базе и честно показывает лексический режим', async () => {
    mockApiFetch()
    renderWithProviders(<KnowledgeSection />, {
      route: '/consilium?view=knowledge&tab=base',
    })

    fireEvent.change(await screen.findByLabelText('Запрос'), {
      target: { value: 'бета' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Искать' }))

    expect(await screen.findByText(/только лексика/)).toBeInTheDocument()
    expect(
      await screen.findByText('В левой височной области бета связана с речевыми зонами.'),
    ).toBeInTheDocument()
  })
})
