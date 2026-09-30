/**
 * Тесты раздела Wiki: оглавление, хеш-пермалинки, перекрёстные ссылки,
 * листание статей и клик по термину глоссария.
 */
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SectionRoute } from '@/app/sections/routes'
import { WikiSection } from './WikiSection'
import { WIKI_ARTICLES } from './wikiNav'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('раздел Wiki', () => {
  let scrollSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockApiFetch()
    // jsdom не реализует scrollIntoView — паттерн RightPanel/LocalizationTable:
    // компонент зовёт его только при наличии, здесь подменяем на шпиона
    scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView
  })

  it('рисуется внутри каркаса: тулс-хедер раздела и оглавление', () => {
    // Через SectionRoute — как в реальном роутере: шапка и статусбар берут
    // метаданные из реестра, контент — из модуля раздела
    renderWithProviders(
      <Routes>
        <Route path="/wiki" element={<SectionRoute id="wiki" />} />
      </Routes>,
      { route: '/wiki' },
    )

    expect(
      screen.getByRole('heading', { level: 1, name: 'Wiki — документация' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Оглавление Wiki' })).toBeInTheDocument()
  })

  it('открывает первую статью без хеша и рисует оглавление из реестра', () => {
    renderWithProviders(<WikiSection />)

    expect(
      screen.getByRole('heading', { level: 2, name: 'Введение: путь от файла до эпох' }),
    ).toBeInTheDocument()

    const toc = screen.getByRole('navigation', { name: 'Оглавление Wiki' })
    const links = within(toc).getAllByRole('link')
    expect(links).toHaveLength(WIKI_ARTICLES.length)
    expect(links.map((link) => link.textContent)).toEqual(
      WIKI_ARTICLES.map((article) => article.short),
    )
    expect(links[0]).toHaveAttribute('aria-current', 'page')

    // Пять шагов рабочего цикла (0…4) — каркас «Введения»
    for (let n = 0; n <= 4; n += 1) {
      expect(screen.getByTestId(`wiki-step-${n}`)).toBeInTheDocument()
    }
  })

  it('открывает статью по хешу-пермалинку', () => {
    renderWithProviders(<WikiSection />, { route: '/wiki#artifacts' })

    expect(
      screen.getByRole('heading', { level: 2, name: 'Шаг 2. Поиск артефактов' }),
    ).toBeInTheDocument()
    const toc = screen.getByRole('navigation', { name: 'Оглавление Wiki' })
    expect(within(toc).getByRole('link', { name: 'Артефакты' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('часть «Диполи» открывается по хешу и стоит в оглавлении перед глоссарием', () => {
    renderWithProviders(<WikiSection />, { route: '/wiki#dipole-calc' })

    expect(
      screen.getByRole('heading', { level: 2, name: 'Диполи: расчёт и уточнение' }),
    ).toBeInTheDocument()

    const toc = screen.getByRole('navigation', { name: 'Оглавление Wiki' })
    const names = within(toc)
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(names).toContain('Диполи: обзор')
    expect(names).toContain('Диполи: расчёт')
    expect(names).toContain('Диполи: кадр')
    expect(names.indexOf('Диполи: обзор')).toBeLessThan(names.indexOf('Глоссарий'))
  })

  it('неизвестный хеш открывает «Введение», а не пустой экран', () => {
    renderWithProviders(<WikiSection />, { route: '/wiki#nope' })

    expect(
      screen.getByRole('heading', { level: 2, name: 'Введение: путь от файла до эпох' }),
    ).toBeInTheDocument()
  })

  it('переход по оглавлению меняет статью и прокручивает к её началу', async () => {
    const user = userEvent.setup()
    renderWithProviders(<WikiSection />)

    const toc = screen.getByRole('navigation', { name: 'Оглавление Wiki' })
    await user.click(within(toc).getByRole('link', { name: 'Эпохи' }))

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Шаг 4. Нарезка эпох и диапазоны' }),
    ).toBeInTheDocument()
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'start' })
  })

  it('перекрёстная ссылка внутри статьи ведёт на другую статью', async () => {
    const user = userEvent.setup()
    renderWithProviders(<WikiSection />)

    await user.click(screen.getByRole('link', { name: '«Открытие записи»' }))

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Шаг 0. Открытие записи' }),
    ).toBeInTheDocument()
  })

  it('кнопки внизу листают статьи по порядку', async () => {
    const user = userEvent.setup()
    renderWithProviders(<WikiSection />)

    // У «Введения» вперёд только «Открытие», назад — некуда
    expect(screen.queryByRole('button', { name: 'Введение' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Открытие' }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Шаг 0. Открытие записи' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Введение' }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Введение: путь от файла до эпох' }),
    ).toBeInTheDocument()
  })

  it('клик по термину открывает глоссарий и прокручивает к якорю', async () => {
    const user = userEvent.setup()
    renderWithProviders(<WikiSection />)

    await user.click(screen.getByRole('button', { name: 'стадиями' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Глоссарий' })).toBeInTheDocument()
    expect(document.getElementById('term-stage')).not.toBeNull()
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'start' })
  })

  it('глоссарий печатает все термины словаря с якорями', () => {
    renderWithProviders(<WikiSection />, { route: '/wiki#glossary' })

    expect(screen.getByText('Отношение мощности полезного сигнала 2–30 Гц к высокочастотному шуму в децибелах. Медиана по каналам: ≥ 10 дБ — хорошо, < 5 дБ — плохо.')).toBeInTheDocument()
    expect(document.getElementById('term-snr')).not.toBeNull()
    expect(document.getElementById('term-ica')).not.toBeNull()
    // Термины части «Диполи» — в группе «Диполи»
    expect(document.getElementById('term-kd')).not.toBeNull()
    expect(document.getElementById('term-fastgrid')).not.toBeNull()
  })
})
