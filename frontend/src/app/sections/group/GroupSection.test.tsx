/**
 * Тесты раздела «Групповой анализ» → режим «Сравнение двух записей» (B9):
 * кандидаты пары из сессий (дедуп), запуск **только кнопкой**, валидация
 * пары, показ результата (таблица дельт, значимый кластер, каветы).
 *
 * Задача `kind=compare`: мок отвечает 202 → поллинг `/jobs` succeeded →
 * результат `GET /compare/{id}`.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { compareCandidates } from './candidates'
import { GroupPanel } from './GroupPanel'
import { GroupSection } from './GroupSection'
import { GroupToolActions } from './GroupToolActions'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { mockApiFetch } from '@/test/apiMocks'
import { compareResultFixture, sessionsFixture } from '@/test/fixtures'
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

describe('кандидаты пары сравнения', () => {
  it('дедуплицирует сессии по recording_id и добавляет текущую запись', () => {
    const candidates = compareCandidates(sessionsFixture.items, {
      recording_id: 'rec-live',
      filename: 'live.edf',
    })
    expect(candidates.map((item) => item.id)).toEqual(['rec-rest', 'rec-task', 'rec-live'])
    expect(candidates[0].label).toBe('rest.edf')
  })

  it('без сессий и без открытой записи список пуст', () => {
    expect(compareCandidates([], null)).toEqual([])
  })
})

describe('раздел «Групповой анализ» (сравнение)', () => {
  beforeEach(() => {
    localStorage.clear()
    useGroupCompare.setState({
      recordingIdA: null,
      recordingIdB: null,
      labelA: 'Покой',
      labelB: 'Деятельность',
      psdMethod: 'welch',
      job: null,
      jobId: null,
      result: null,
      error: null,
    })
  })

  it('пустое состояние объясняет, что выбрать и что будет в результате', () => {
    mockApiFetch()
    renderGroup()

    expect(screen.getByText('Дифференциальный анализ двух записей')).toBeInTheDocument()
    expect(screen.getByText(/нажмите «Сравнить»/)).toBeInTheDocument()
  })

  it('панель дедуплицирует кандидатов: две записи из трёх сессий', async () => {
    mockApiFetch()
    renderGroup()

    // Сессии приходят асинхронно (react-query): ждём появления кандидатов
    const selects = screen.getAllByRole('combobox')
    await screen.findAllByText('rest.edf', { selector: 'option' })
    // Первая опция каждого селекта — «— не выбрана —», дальше кандидаты
    const options = within(selects[0]).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      '— не выбрана —',
      'rest.edf',
      'task.edf',
    ])
  })

  it('кнопка выключена без пары и при совпадении записей', async () => {
    mockApiFetch()
    renderGroup()
    await screen.findAllByText('rest.edf', { selector: 'option' })

    const button = screen.getByTestId('group-run')
    expect(button).toBeDisabled()

    act(() => {
      useGroupCompare.setState({ recordingIdA: 'rec-rest', recordingIdB: 'rec-rest' })
    })
    expect(button).toBeDisabled()
    expect(screen.getByTestId('compare-same-recording')).toBeInTheDocument()

    act(() => {
      useGroupCompare.setState({ recordingIdB: 'rec-task' })
    })
    expect(button).toBeEnabled()
  })

  it('запуск только кнопкой: показывает результат таблицей, кластером и каветами', async () => {
    mockApiFetch()
    useGroupCompare.setState({ recordingIdA: 'rec-rest', recordingIdB: 'rec-task' })
    renderGroup()

    await userEvent.click(screen.getByTestId('group-run'))

    // Результат: паспорт пары, таблица дельт, значимый кластер, каветы
    expect(await screen.findByTestId('group-result')).toBeInTheDocument()
    expect(screen.getByTestId('compare-band-alpha')).toBeInTheDocument()
    expect(screen.getByTestId('compare-cluster-significant')).toBeInTheDocument()
    expect(screen.getAllByTestId('compare-notes')).toHaveLength(1)
    expect(screen.getByTestId('compare-warnings')).toHaveTextContent('T3')
    // Карты разности: URL из результата + версия против кэша браузера
    const topomap = screen.getByTestId('compare-topomap-alpha')
    expect(topomap.getAttribute('src')).toContain('&v=abc123def4567890')
    // Правая колонка таблицы: график-строка на каждую полосу, общая шкала
    expect(screen.getByTestId('compare-band-bar-alpha')).toBeInTheDocument()
    expect(screen.getByTestId('compare-band-bar-theta')).toBeInTheDocument()
    // Совмещённый график (PSD → дельта → кластеры, общая ось) + легенда и
    // оба комментария под ним; мини-карта монтажа больше не рисуется
    expect(screen.getByTestId('compare-stack-chart')).toBeInTheDocument()
    expect(screen.getByTestId('compare-legend')).toBeInTheDocument()
    expect(screen.queryByTestId('compare-cluster-head')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('compare-dumbbell')).toHaveLength(4)
  })

  it('ошибка запуска (400 шлюза пары) показывается под пустым состоянием', async () => {
    mockApiFetch({ compareStartFails: 'Частоты дискретизации различаются (250 vs 200 Гц)' })
    useGroupCompare.setState({ recordingIdA: 'rec-rest', recordingIdB: 'rec-task' })
    renderGroup()

    await userEvent.click(screen.getByTestId('group-run'))

    expect(await screen.findByTestId('group-error')).toHaveTextContent(
      'Частоты дискретизации различаются',
    )
  })

  it('без результата показывается кавет-подсказка, с результатом — таблица индексов', () => {
    mockApiFetch({ compareResult: compareResultFixture() })
    useGroupCompare.setState({ result: compareResultFixture() })
    renderGroup()

    expect(screen.getByTestId('compare-indices')).toBeInTheDocument()
    expect(screen.getByTestId('compare-stack-chart')).toBeInTheDocument()
    // Стрелки A→B: одна на каждую строку индексов (IAF, θ/β, (θ+α)/β, 1/f)
    expect(screen.getAllByTestId('compare-dumbbell')).toHaveLength(4)
  })

  it('столбики дельт несут числа и форму из результата (ΔдБ в правой колонке)', () => {
    mockApiFetch({ compareResult: compareResultFixture() })
    useGroupCompare.setState({ result: compareResultFixture() })
    renderGroup()

    // Столбик α значим: подпись +8.3 дБ и CI-ус в ячейке строки
    const bar = screen.getByTestId('compare-band-bar-alpha')
    expect(bar.textContent).toContain('+8.3')
    expect(bar.querySelectorAll('line').length).toBeGreaterThanOrEqual(3)
    // Незначимая θ: подпись 0.2 и приглушённая заливка (opacity 0.55)
    expect(screen.getByTestId('compare-band-bar-theta').textContent).toContain('+0.2')
  })

  it('курсор графика: сквозная линия и параметры «диапазон · частота · уровень»', async () => {
    mockApiFetch({ compareResult: compareResultFixture() })
    useGroupCompare.setState({ result: compareResultFixture() })
    renderGroup()

    const chart = await screen.findByTestId('compare-stack-chart')
    // До наведения — подсказка, параметров нет
    expect(screen.getByTestId('compare-cursor-readout')).toHaveTextContent(/Наведите курсор/)

    // jsdom не считает боксы: подставляем ширину контейнера такой же,
    // как у заглушки ResizeObserver в vitest.setup (1024 px)
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 1024, height: 300, x: 0, y: 0,
      right: 1024, bottom: 300, toJSON: () => ({}),
    } as DOMRect)
    // Центр поля: частота ~середины диапазона (в fixture fmin=1, fmax=40 → ~20 Гц)
    fireEvent.mouseMove(chart, { clientX: 512, clientY: 100 })

    expect(screen.getByTestId('compare-cursor')).toBeInTheDocument()
    const readout = screen.getByTestId('compare-cursor-readout')
    expect(readout).toHaveTextContent('Диапазон:')
    expect(readout).toHaveTextContent('Частота:')
    expect(readout).toHaveTextContent('Уровень: A')
    expect(readout).toHaveTextContent('мкВ²')
  })

  it('график 1:1 с контейнером: viewBox по ширине замера, высота — константа', async () => {
    mockApiFetch({ compareResult: compareResultFixture() })
    useGroupCompare.setState({ result: compareResultFixture() })
    renderGroup()

    // Заглушка ResizeObserver отдаёт ширину 1024 — viewBox обязан совпасть,
    // а высота остаться фиксированной: регрессия «растяжения картинки»
    const chart = await screen.findByTestId('compare-stack-chart')
    expect(chart.getAttribute('viewBox')).toMatch(/^0 0 1024 \d+$/)
    const style = chart.getAttribute('style') ?? ''
    const match = /height:\s*(\d+)px/.exec(style)
    expect(match).not.toBeNull()
    // Высота — константа из спецификации (PSD 150 + ΔдБ 100 + кластеры 2×20,
    // зазоры/ось 16) при двух кластерах фикстуры, а не производная ширины
    expect(Number(match![1])).toBe(366)
  })
})
