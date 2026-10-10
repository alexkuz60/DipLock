/**
 * Тесты панели «Модельный роутер ИИ»: маскирование ключа, сохранение только
 * кнопкой, семантика «пустой ключ — не менять», проверка связи.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ModelRouterPanel } from './ModelRouterPanel'
import { llmProbeFixture, llmRouterFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Найти в вызовах fetch PUT /llm-router и разобрать его тело. */
function putBodies(fetchMock: ReturnType<typeof mockApiFetch>): unknown[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes('/llm-router') && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)))
}

describe('панель «Модельный роутер ИИ»', () => {
  beforeEach(() => {
    mockApiFetch()
  })

  it('показывает провайдера, маску ключа и маршруты', async () => {
    renderWithProviders(<ModelRouterPanel />)

    expect(await screen.findByRole('textbox', { name: 'Имя' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('big-model-1')).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText(/сохранён \(…1234\); пустое поле оставит прежний/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Советники (chat)')).toHaveValue('prov-full')
  })

  it('правка формы не отправляет запрос, сохранение — только кнопкой', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    const label = await screen.findByLabelText('Имя')
    await user.clear(label)
    await user.type(label, 'Новое имя')
    expect(putBodies(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
  })

  it('пустое поле ключа не удаляет прежний (api_key не отправляется)', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    // Любая правка активирует «Сохранить» (без правок он честно заблокирован)
    await user.click(screen.getByRole('checkbox', { name: 'Включён' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    const body = putBodies(fetchMock)[0] as {
      providers: { api_key?: string; id: string }[]
    }
    expect(body.providers[0].id).toBe('prov-full')
    expect(body.providers[0]).not.toHaveProperty('api_key')
  })

  it('«Забыть ключ» отправляет пустой api_key', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.click(screen.getByRole('button', { name: 'Забыть ключ' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    const body = putBodies(fetchMock)[0] as { providers: { api_key?: string }[] }
    expect(body.providers[0].api_key).toBe('')
  })

  it('ввод ключа отправляет его только с сохранением', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    const keyField = await screen.findByPlaceholderText(/сохранён/)
    await user.type(keyField, 'sk-new-key-5678')
    expect(putBodies(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    const body = putBodies(fetchMock)[0] as { providers: { api_key?: string }[] }
    expect(body.providers[0].api_key).toBe('sk-new-key-5678')
  })

  it('проверка связи показывает успех с задержкой', async () => {
    const user = userEvent.setup()
    mockApiFetch({ llmProbe: llmProbeFixture() })
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.click(screen.getByRole('button', { name: 'Проверить связь' }))

    expect(await screen.findByText('Связь есть (420 мс)')).toBeInTheDocument()
  })

  it('ошибка провайдера показывается честно, без ложного успеха', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      llmProbe: llmProbeFixture({
        ok: false,
        latency_ms: null,
        error: 'Провайдер ответил 401: нет доступа',
      }),
    })
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.click(screen.getByRole('button', { name: 'Проверить связь' }))

    expect(await screen.findByText('Нет связи: Провайдер ответил 401: нет доступа')).toBeInTheDocument()
  })

  it('новый провайдер: проба недоступна до сохранения', async () => {
    const user = userEvent.setup()
    mockApiFetch({ llmRouter: llmRouterFixture({ providers: [], routes: { chat: null, transcribe: null } }) })
    renderWithProviders(<ModelRouterPanel />)

    expect(
      await screen.findByText('Провайдеры не добавлены — ИИ-советники и распознавание недоступны.'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Добавить провайдера' }))
    expect(screen.getByText('Новый провайдер')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сохраните, чтобы проверить' })).toBeDisabled()
  })

  it('дополнительные параметры (JSON) уходят только с сохранением', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    const extra = await screen.findByLabelText('Дополнительные параметры')
    fireEvent.change(extra, {
      target: { value: '{"thinking": {"type": "enabled"}, "reasoning_effort": "high"}' },
    })
    expect(putBodies(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    const body = putBodies(fetchMock)[0] as {
      providers: { extra?: { [key: string]: unknown } }[]
    }
    expect(body.providers[0].extra).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })

  it('некорректный JSON параметров показывает ошибку и не отправляет', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    const extra = await screen.findByLabelText('Дополнительные параметры')
    await user.type(extra, 'не json')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(
      await screen.findByText(/Дополнительные параметры — некорректный JSON/),
    ).toBeInTheDocument()
    expect(putBodies(fetchMock)).toHaveLength(0)
  })

  it('пустое поле параметров убирает прежние (отправляется {})', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch({
      llmRouter: llmRouterFixture({
        providers: [
          {
            id: 'prov-full',
            label: 'Полная модель',
            protocol: 'openai',
            base_url: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            enabled: true,
            key_hint: '…1234',
            extra: { reasoning_effort: 'high' },
          },
        ],
        routes: { chat: 'prov-full', transcribe: null },
      }),
    })
    renderWithProviders(<ModelRouterPanel />)

    const extra = await screen.findByLabelText('Дополнительные параметры')
    expect(extra).toHaveValue(JSON.stringify({ reasoning_effort: 'high' }, null, 2))
    await user.clear(extra)
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    const body = putBodies(fetchMock)[0] as { providers: { extra?: unknown }[] }
    expect(body.providers[0].extra).toEqual({})
  })
})