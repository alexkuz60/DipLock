/**
 * Тесты режима «Группа (N>2)» раздела «Групповой анализ» (остаток 4.7, §3.5):
 * переключатель режима, выбор участников, запуск **только кнопкой**
 * (правка фильтра не шлёт запрос), показ результата (паспорт, таблицы,
 * тепловая карта 1:1, каветы), ошибка шлюза 400 и история прогонов.
 *
 * Мок `POST /group/aggregate` — синхронный JSON (не задача): поллинга нет.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { GroupPanel } from './GroupPanel'
import { GroupSection } from './GroupSection'
import { GroupToolActions } from './GroupToolActions'
import { useGroupRun } from '@/shared/state/groupRun'
import { mockApiFetch } from '@/test/apiMocks'
import { groupAggregateFixture, groupRunSummaryFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

function renderGroup() {
  return renderWithProviders(
    <>
      <GroupSection />
      <GroupPanel />
      <GroupToolActions />
    </>,
  )
}

/** Перевод раздела в режим «Группа» и ожидание панели участников. */
async function enterGroupMode() {
  fireEvent.click(screen.getByRole('button', { name: 'Группа (N>2)' }))
  await waitFor(() => expect(screen.getByTestId('group-members')).toBeInTheDocument())
}

describe('режим «Группа (N>2)»', () => {
  beforeEach(() => {
    localStorage.clear()
    useGroupRun.setState({
      mode: 'pair',
      recordingIds: [],
      bandKey: 'alpha',
      gofMin: '',
      epochLengthMs: '',
      dateFrom: '',
      dateTo: '',
      names: '',
      topN: 12,
      runName: '',
      aggregate: null,
      loading: false,
      error: null,
      saved: null,
      history: null,
      historyLoading: false,
      historyError: null,
    })
  })

  it('переключатель режима показывает участников и фильтры', async () => {
    mockApiFetch()
    renderGroup()
    // Пара — по умолчанию
    expect(screen.getByText('Пара записей')).toBeInTheDocument()
    await enterGroupMode()
    expect(screen.getByText('Групповые фильтры (§3.5)')).toBeInTheDocument()
    expect(screen.getByText('История прогонов')).toBeInTheDocument()
  })

  it('кнопка «Считать» заблокирована без участников; выбор включает', async () => {
    mockApiFetch()
    renderGroup()
    await enterGroupMode()

    const runButton = screen.getByTestId('group-run-aggregate')
    expect(runButton).toBeDisabled()

    // Кандидаты приходят из GET /sessions (две записи в фикстуре)
    const checkboxes = await screen.findAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    expect(screen.getByTestId('group-members-count')).toHaveTextContent('1 из')
    expect(runButton).not.toBeDisabled()
  })

  it('правка фильтра не запускает расчёт — только кнопка', async () => {
    const fetchMock = mockApiFetch()
    renderGroup()
    await enterGroupMode()

    const runButton = screen.getByTestId('group-run-aggregate')
    fireEvent.click((await screen.findAllByRole('checkbox'))[0])

    // Меняем фильтр (GOF): запросов агрегата не прибавилось
    const count = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/group/aggregate'))
        .length
    const before = count()
    fireEvent.change(screen.getByPlaceholderText('0.8'), { target: { value: '0.7' } })
    expect(count()).toBe(before)
    expect(runButton).not.toBeDisabled()

    // Считает только кнопка
    fireEvent.click(runButton)
    await screen.findByTestId('group-run-result')
    expect(count()).toBe(before + 1)
  })

  it('результат: паспорт, таблицы, каветы и экспорт CSV', async () => {
    mockApiFetch({ groupAggregate: groupAggregateFixture() })
    useGroupRun.setState({ recordingIds: ['rec-rest', 'rec-task'] })
    renderGroup()
    await enterGroupMode()

    fireEvent.click(screen.getByTestId('group-run-aggregate'))
    await screen.findByTestId('group-run-result')

    expect(screen.getByTestId('group-passport')).toHaveTextContent('Полоса:')
    expect(screen.getByTestId('group-participants')).toHaveTextContent('rest.edf')
    expect(screen.getByTestId('group-table-brodmann')).toHaveTextContent('BA7-lh')
    expect(screen.getByTestId('group-table-structures')).toHaveTextContent(
      'таламус (слева)',
    )
    // Обязательные каветы показываются без редактирования
    expect(screen.getByTestId('group-run-notes')).toHaveTextContent(
      'только внутри своей полосы',
    )
    expect(screen.getByTestId('group-export-csv')).toBeInTheDocument()
  })

  it('тепловая карта: viewBox = ширина контейнера (заглушка 1024), высота — константа', async () => {
    mockApiFetch({ groupAggregate: groupAggregateFixture() })
    useGroupRun.setState({ recordingIds: ['rec-rest', 'rec-task'] })
    renderGroup()
    await enterGroupMode()
    fireEvent.click(screen.getByTestId('group-run-aggregate'))

    const map = await screen.findByTestId('group-heatmap')
    const svg = within(map).getByRole('img')
    // 1:1 с контейнером: ширина замера, высота = 96 (шапка) + 2 строки × 22 + 8
    expect(svg.getAttribute('viewBox')).toBe('0 0 1024 148')
    // Доли ячеек подписаны (share из фикстуры: 67 % и 100 %)
    expect(map).toHaveTextContent('67%')
    expect(map).toHaveTextContent('100%')
  })

  it('ошибка шлюза 400 показывается с текстом сервера', async () => {
    mockApiFetch({ groupAggregateFails: 'Неизвестная полоса: alpja' })
    useGroupRun.setState({ recordingIds: ['rec-rest'] })
    renderGroup()
    await enterGroupMode()

    fireEvent.click(screen.getByTestId('group-run-aggregate'))
    const error = await screen.findByTestId('group-run-error')
    expect(error).toHaveTextContent('Неизвестная полоса: alpja')
  })

  it('история: кнопка «Обновить» даёт список, клик — свежий пересчёт прогона', async () => {
    mockApiFetch({ groupRuns: [groupRunSummaryFixture()] })
    useGroupRun.setState({ recordingIds: ['rec-rest'] })
    renderGroup()
    await enterGroupMode()

    fireEvent.click(screen.getByTestId('group-history-reload'))
    const item = await screen.findByTestId('group-history-run-7')
    expect(item).toHaveTextContent('покой vs деятельность')

    fireEvent.click(item)
    await screen.findByTestId('group-run-result')
    expect(screen.getByTestId('group-table-structures')).toHaveTextContent(
      'таламус (слева)',
    )
  })
})

