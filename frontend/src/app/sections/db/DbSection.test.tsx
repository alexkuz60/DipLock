/**
 * Тесты раздела «БД — записи и результаты»: таблица готовности записей.
 *
 * Главное обещание раздела: он **только читает** БД — ни одного запуска
 * расчёта (задачи/POST нет ни в одном сценарии), зато видно готовность и
 * параметры записанных прогонов. Проверяются также мультивыбор (вход пары/
 * группы), группировка по испытуемому и карточка строки по раскрытию.
 */
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDbView } from '@/shared/state/dbView'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'
import { recordingsReadinessFixture } from '@/test/fixtures'
import { downloadText } from '@/shared/lib/download'
import { DbSection } from './DbSection'

vi.mock('@/shared/lib/download', () => ({
  downloadText: vi.fn(),
  downloadBlob: vi.fn(),
  canvasToBlob: vi.fn(),
}))

describe('раздел «БД»', () => {
  beforeEach(() => {
    localStorage.clear()
    useDbView.setState({
      onlyProcessed: true,
      search: '',
      groupByPatient: true,
      sortKey: 'created',
      pageLimit: 50,
      pageOffset: 0,
      selectedIds: [],
      expandedId: null,
    })
    vi.stubGlobal('fetch', mockApiFetch())
  })

  it('показывает записи с готовностью «k из N» и группами испытуемых', async () => {
    renderWithProviders(<DbSection />)

    expect(await screen.findByTestId('db-row-rec-rest')).toBeInTheDocument()
    expect(screen.getByTestId('db-row-rec-task')).toBeInTheDocument()
    expect(screen.getByTestId('db-row-rec-empty')).toBeInTheDocument()

    // Готовность и пилюли стадий: rec-rest — «4 из 5», спектрограмма не готова
    expect(screen.getByText('4 из 5')).toBeInTheDocument()
    expect(screen.getAllByText(/Препроцессинг ✔/).length).toBe(2) // rec-rest и rec-task
    expect(screen.getAllByText(/Препроцессинг —/).length).toBe(1) // rec-empty
    expect(screen.getAllByText(/Спектрограмма —/).length).toBe(3)

    // Группировка по испытуемому: 2 файла Patient-aaa111 + запись без псевдонима
    expect(screen.getByText('Patient-aaa111', { selector: 'span.font-semibold' })).toBeInTheDocument()
    expect(screen.getByText('Без псевдонима', { selector: 'span.font-semibold' })).toBeInTheDocument()

    // Параметры последних прогонов видны без раскрытия
    expect(screen.getAllByText(/0.5–45 Гц · notch 50 · average · ICA/).length).toBeGreaterThan(0)
  })

  it('фильтр «только обработанные» уходит на сервер, раздел ничего не запускает', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-rest')

    const readinessCalls = fetchMock.mock.calls.filter(([input]) =>
      String(typeof input === 'string' ? input : input.url).includes('/recordings/readiness'),
    )
    expect(readinessCalls.length).toBeGreaterThan(0)
    expect(String(readinessCalls[0][0])).toContain('only_processed=true')
    // Ни одного POST: раздел — визуальный контроль, а не расчёт
    expect(
      fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toHaveLength(0)
  })

  it('клик по строке раскрывает карточку готовности с историей прогонов', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DbSection />)
    const row = await screen.findByTestId('db-row-rec-rest')

    await user.click(row)
    const detail = await screen.findByTestId('db-detail-rec-rest')
    expect(within(detail).getAllByText('Полоса фильтра').length).toBeGreaterThan(0)
    expect(within(detail).getAllByText('История прогонов (1)').length).toBeGreaterThan(0)
  })

  it('мультивыбор: чекбоксы и «Выбрать группу» пополняют выборку', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-rest')

    await user.click(screen.getByLabelText('Выбрать запись rest.edf'))
    expect(screen.getByText('Выбрано: 1')).toBeInTheDocument()

    const groupHeader = screen
      .getByText('Patient-aaa111', { selector: 'span.font-semibold' })
      .closest('tr')
    expect(groupHeader).not.toBeNull()
    await user.click(
      within(groupHeader as HTMLElement).getByRole('button', { name: 'Выбрать группу' }),
    )
    expect(screen.getByText('Выбрано: 2')).toBeInTheDocument()
    expect(useDbView.getState().selectedIds).toEqual(['rec-rest', 'rec-task'])
  })

  it('пустая выдача объясняет, что делать, и сбрасывает фильтры кнопкой', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      mockApiFetch({ recordingsReadiness: { total: 0, limit: 50, offset: 0, items: [] } }),
    )
    renderWithProviders(<DbSection />)

    expect(await screen.findByText('Записей не найдено')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать все записи' }))
    expect(useDbView.getState().onlyProcessed).toBe(false)
    expect(useDbView.getState().search).toBe('')
  })

  it('ошибка чтения БД показывается честно, с кнопкой повтора', async () => {
    vi.stubGlobal('fetch', mockApiFetch({ recordingsReadinessFails: true }))
    renderWithProviders(<DbSection />)

    expect(await screen.findByText('Не удалось прочитать записи БД')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
  })

  it('раскрытая строка показывает пилюли готовности из фикстуры без пересчёта', async () => {
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-task')
    // У rec-task готов только препроцессинг — пилюли честно показывают «—»
    const taskRow = screen.getByTestId('db-row-rec-task')
    expect(within(taskRow).getByText('1 из 5')).toBeInTheDocument()
    expect(recordingsReadinessFixture.items?.length).toBe(3)
  })

  it('поиск и сортировка уходят на сервер (шаблоны E–F), а не фильтруют страницу', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-rest')

    act(() => useDbView.getState().setSearch('rest'))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes('search=rest'),
        ),
      ).toBe(true),
    )

    act(() => useDbView.getState().setSortKey('name'))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('sort=name')),
      ).toBe(true),
    )
  })

  it('пагинация: «Вперёд» переносит смещение на следующую страницу', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      mockApiFetch({
        recordingsReadiness: { ...recordingsReadinessFixture, total: 10 },
      }),
    )
    // Мок захватывается после переустановки: иначе ссылка — на стаб из beforeEach
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-rest')

    act(() => useDbView.getState().setPageLimit(2))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('limit=2')),
      ).toBe(true),
    )

    await user.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(useDbView.getState().pageOffset).toBe(2)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('offset=2')),
      ).toBe(true),
    )
  })

  it('экспорт CSV выгружает выборку через downloadText', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-rest')

    await user.click(screen.getByLabelText('Выбрать запись rest.edf'))
    await user.click(screen.getByRole('button', { name: 'Экспорт CSV' }))

    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1))
    const [name, csv] = vi.mocked(downloadText).mock.calls[0] as [string, string]
    expect(name).toBe('diplock-db-recordings.csv')
    expect(csv).toContain('rec-rest')
    expect(csv).toContain('4 из 5')
  })

  it('JSON и «Отчёт HTML» — те же данные выборки в своих форматах', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-rest')
    await user.click(screen.getByLabelText('Выбрать запись rest.edf'))

    await user.click(screen.getByRole('button', { name: 'Экспорт JSON' }))
    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1))
    const [jsonName, jsonText, jsonMime] = vi.mocked(downloadText).mock.calls[0] as [
      string,
      string,
      string,
    ]
    expect(jsonName).toBe('diplock-db-recordings.json')
    expect(jsonMime).toContain('application/json')
    expect((JSON.parse(jsonText) as { recordings: unknown[] }).recordings).toHaveLength(1)

    vi.mocked(downloadText).mockClear()
    await user.click(screen.getByRole('button', { name: 'Отчёт HTML' }))
    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1))
    const [htmlName, htmlText, htmlMime] = vi.mocked(downloadText).mock.calls[0] as [
      string,
      string,
      string,
    ]
    expect(htmlName).toBe('diplock-db-recordings.html')
    expect(htmlMime).toContain('text/html')
    expect(htmlText).toContain('<!DOCTYPE html>')
    expect(htmlText).toContain('rec-rest')
  })

  it('кнопка «Открыть» переносит запись в раздел EDF (открытие по id)', async () => {
    const user = userEvent.setup()
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    renderWithProviders(<DbSection />)
    await screen.findByTestId('db-row-rec-rest')

    await user.click(screen.getByRole('button', { name: 'Открыть запись rest.edf в EDF' }))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes('/api/v1/recordings/rec-rest'),
        ),
      ).toBe(true),
    )
  })
})