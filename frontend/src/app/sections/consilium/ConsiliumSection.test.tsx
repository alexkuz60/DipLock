/** Т1 UI: ручные действия, раскрытие оснований, ошибки и поздний ответ соседнего дела. */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConsiliumSection } from './ConsiliumSection'
import { EvidenceDetails } from './CaseMaterials'
import { renderWithProviders } from '@/test/renderWithProviders'
import type {
  ConsiliumCase,
  ConsiliumContext,
  ConsiliumEvidence,
  ConsiliumSnapshot,
} from '@/shared/api/types'

const makeCase = (id = 'case-a'): ConsiliumCase => ({
  id,
  title: id === 'case-a' ? 'Музыка' : 'Медитация',
  question: `Вопрос ${id}`,
  version: 1,
  status: 'open',
  direction: 'music',
  subject_codes: ['V-1'],
  recording_ids: ['rec-a'],
  created_at: '2026-10-10T10:00:00',
  updated_at: '2026-10-10T10:00:00',
})
const material: ConsiliumEvidence = {
  id: 'e-1',
  case_id: 'case-a',
  title: 'Спектр',
  revision: 1,
  source_kind: 'job',
  source_id: 'job-1',
  recording_ids: ['rec-a'],
  payload: { power: null },
  parameters: null,
  signal_state: null,
  versions: {},
  units: {},
  completeness: 'aggregate',
  warnings: ['Редкий монтаж'],
  missing: ['signal_state'],
  sha256: 'a'.repeat(64),
  captured_at: '2026-10-10T10:00:00',
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockServer(
  options: { empty?: boolean; conflict?: boolean; delayed?: Promise<Response> } = {},
) {
  let cases = options.empty ? [] : [makeCase(), makeCase('case-b')]
  const contexts: ConsiliumContext[] = []
  const evidence: ConsiliumEvidence[] = []
  const snapshots: ConsiliumSnapshot[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1/consilium', '')
    const method = init?.method ?? 'GET'
    const payload = init?.body ? JSON.parse(String(init.body)) : {}
    if (path === '/recordings')
      return response([{ id: 'rec-a', filename: 'rest.edf', sfreq: 250, duration_sec: 10 }])
    if (path === '/cases' && method === 'GET')
      return response({ total: cases.length, items: cases })
    if (path === '/cases' && method === 'POST') {
      const created = { ...makeCase(), ...payload, id: 'case-new' }
      delete created.request_id
      cases = [...cases, created]
      return response(created, 201)
    }
    const id = path.split('/')[2]
    const current = cases.find((item) => item.id === id)
    if (!current) return response({ detail: 'Исследование не найдено' }, 404)
    if (path === `/cases/${id}`) {
      if (method === 'PATCH') {
        Object.assign(current, payload, { version: current.version + 1 })
        delete (current as unknown as Record<string, unknown>).request_id
      }
      if (method === 'DELETE') {
        cases = cases.filter((item) => item.id !== id)
        return new Response(null, { status: 204 })
      }
      return response(current)
    }
    if (path.endsWith('/deletion-preview'))
      return response({
        case_id: id,
        version: current.version,
        context_revisions: contexts.length,
        message_revisions: 0,
        evidence_items: evidence.length,
        snapshots: snapshots.length,
        recording_ids: ['rec-a'],
        warnings: ['Исходные ЭЭГ не удаляются'],
      })
    if (path.endsWith('/sources'))
      return response({
        total: 1,
        warnings: [],
        items: [
          {
            kind: 'job',
            id: 'job-1',
            title: 'Спектр по записи',
            recording_ids: ['rec-a'],
            available: true,
          },
        ],
      })
    if (path.endsWith('/context')) {
      if (id === 'case-a' && options.delayed && method === 'GET') return options.delayed
      if (method === 'POST') {
        if (options.conflict)
          return response({ detail: 'Исследование изменилось — обновите данные' }, 409)
        current.version++
        const item = {
          ...payload,
          id: 'ctx-1',
          case_id: id,
          revision: 1,
          created_at: '2026-10-10T10:00:00',
        }
        delete item.request_id
        delete item.expected_version
        contexts.push(item)
        return response(item, 201)
      }
      return response({ total: contexts.length, items: contexts })
    }
    if (path.endsWith('/messages')) return response({ total: 0, items: [] })
    if (path.endsWith('/evidence')) {
      if (method === 'POST') {
        current.version++
        evidence.push(material)
        return response(material, 201)
      }
      return response({ total: evidence.length, items: evidence })
    }
    if (path.endsWith('/snapshots')) {
      if (method === 'POST') {
        const item = {
          id: 's-1',
          case_id: id,
          case_version: current.version,
          created_at: '2026-10-10T10:00:00',
          question: current.question,
          title: current.title,
          evidence: [...evidence],
          context: [...contexts],
          sha256: 'b'.repeat(64),
          warnings: [],
        }
        snapshots.push(item)
        current.version++
        return response(item, 201)
      }
      return response({ total: snapshots.length, items: snapshots })
    }
    return response({ detail: `Unexpected ${method} ${path}` }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('Консилиум: ручное исследование Т1', () => {
  it('создаёт дело только кнопкой, без расчётов и чувствительного localStorage', async () => {
    const fetchMock = mockServer({ empty: true })
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    renderWithProviders(<ConsiliumSection />)
    await screen.findByText(/Исследований пока нет/)
    fireEvent.click(screen.getByRole('button', { name: 'Новое исследование' }))
    fireEvent.change(screen.getByLabelText('Название исследования'), {
      target: { value: 'Новое дело' },
    })
    fireEvent.change(screen.getByLabelText('Исследовательский вопрос'), {
      target: { value: 'Что менялось?' },
    })
    const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length
    expect(posts()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Создать исследование' }))
    await screen.findByRole('heading', { name: 'Новое дело' })
    expect(posts()).toBe(1)
    expect(storage).not.toHaveBeenCalled()
    storage.mockRestore()
  })

  it('сохраняет рассказ, принимает материал и публикует досье явными действиями', async () => {
    const fetchMock = mockServer()
    renderWithProviders(<ConsiliumSection />, { route: '/consilium?case=case-a' })
    await screen.findByRole('heading', { name: 'Музыка' })
    fireEvent.change(screen.getByLabelText('Источник контекста'), {
      target: { value: 'volunteer_report' },
    })
    fireEvent.change(screen.getByLabelText('Текст контекста'), {
      target: { value: 'Мне спокойно' },
    })
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Добавить контекст' }))
    await screen.findByText('Мне спокойно')
    await waitFor(() => expect(screen.getByText(/версия 2/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Материалы и досье' }))
    await screen.findByText('Спектр по записи')
    fireEvent.click(screen.getByRole('button', { name: 'Добавить материал' }))
    await screen.findByLabelText('В досье: Спектр')
    await waitFor(() => expect(screen.getByText(/версия 3/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText('В досье: Спектр'))
    fireEvent.click(screen.getByRole('button', { name: 'Опубликовать снимок досье' }))
    await screen.findByText(/Досье · 2026/)
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input).includes('/snapshots') && init?.method === 'POST',
      ),
    ).toHaveLength(1)
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input).includes('/preprocess') || String(input).includes('/jobs'),
      ),
    ).toBe(false)
  })

  it('показывает 409 и сохраняет введённый контекст', async () => {
    mockServer({ conflict: true })
    renderWithProviders(<ConsiliumSection />, { route: '/consilium?case=case-a' })
    await screen.findByRole('heading', { name: 'Музыка' })
    fireEvent.change(screen.getByLabelText('Текст контекста'), { target: { value: 'Черновик' } })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить контекст' }))
    await screen.findByText('Исследование изменилось — обновите данные')
    expect(screen.getByLabelText('Текст контекста')).toHaveValue('Черновик')
  })

  it('повтор отправляет прежний запрос целиком, даже если форма изменена после ошибки', async () => {
    const fetchMock = mockServer({ conflict: true })
    renderWithProviders(<ConsiliumSection />, { route: '/consilium?case=case-a' })
    await screen.findByRole('heading', { name: 'Музыка' })
    fireEvent.change(screen.getByLabelText('Текст контекста'), {
      target: { value: 'Первый ответ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Добавить контекст' }))
    await screen.findByText('Исследование изменилось — обновите данные')
    fireEvent.change(screen.getByLabelText('Источник контекста'), { target: { value: 'answer' } })
    fireEvent.change(screen.getByLabelText('Автор / код добровольца'), { target: { value: 'V-2' } })
    fireEvent.change(screen.getByLabelText('Текст контекста'), {
      target: { value: 'Другой ответ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => {
      const writes = fetchMock.mock.calls.filter(
        ([input, init]) => String(input).includes('/context') && init?.method === 'POST',
      )
      expect(writes).toHaveLength(2)
      expect(writes[1][1]?.body).toBe(writes[0][1]?.body)
    })
  })

  it('раскрывает основания локально без запроса', () => {
    const fetchMock = mockServer()
    renderWithProviders(<EvidenceDetails material={material} />)
    fireEvent.click(screen.getByText('На чём основано? · Спектр'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByText(/Состояние сигнала: не установлено/)).toBeInTheDocument()
  })

  it('архивирует и блокирует запись до открытия', async () => {
    mockServer()
    renderWithProviders(<ConsiliumSection />, { route: '/consilium?case=case-a' })
    await screen.findByRole('heading', { name: 'Музыка' })
    fireEvent.click(screen.getByRole('button', { name: 'Архивировать' }))
    await screen.findByText(/Архив · только чтение/)
    expect(screen.getByLabelText('Текст контекста')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Открыть исследование' }))
    await waitFor(() => expect(screen.getByLabelText('Текст контекста')).not.toBeDisabled())
  })

  it('удаляет только после предпросмотра и явного подтверждения', async () => {
    const fetchMock = mockServer()
    renderWithProviders(<ConsiliumSection />, { route: '/consilium?case=case-a' })
    await screen.findByRole('heading', { name: 'Музыка' })
    fireEvent.click(screen.getByRole('button', { name: 'Посмотреть удаление' }))
    await screen.findByRole('dialog', { name: 'Удаление исследования' })
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Удалить исследование окончательно' }))
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Музыка' })).not.toBeInTheDocument(),
    )
    const deletion = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(String(deletion?.[0])).toContain('expected_version=1')
  })

  it('поздний ответ контекста не попадает в другое выбранное дело', async () => {
    let resolve: (value: Response) => void = () => undefined
    const pending = new Promise<Response>((done) => {
      resolve = done
    })
    mockServer({ delayed: pending })
    renderWithProviders(<ConsiliumSection />, { route: '/consilium?case=case-a' })
    await screen.findByRole('heading', { name: 'Музыка' })
    fireEvent.click(screen.getByRole('button', { name: 'Медитация' }))
    await screen.findByRole('heading', { name: 'Медитация' })
    resolve(
      response({
        total: 1,
        items: [
          {
            id: 'late',
            text: 'Чужой поздний ответ',
            revision: 1,
            kind: 'observation',
            author: 'Исследователь',
          },
        ],
      }),
    )
    await waitFor(() => expect(screen.queryByText('Чужой поздний ответ')).not.toBeInTheDocument())
  })
})
