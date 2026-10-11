/**
 * Тесты панели «Модельный роутер ИИ»: маскирование ключа, сохранение только
 * кнопкой, семантика «пустой ключ — не менять», проверка связи.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { ModelRouterPanel } from './ModelRouterPanel'
import { llmChatProbeFixture, llmProbeFixture, llmRouterFixture } from '@/test/fixtures'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Найти в вызовах fetch PUT /llm-router и разобрать его тело. */
function putBodies(fetchMock: ReturnType<typeof mockApiFetch>): unknown[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes('/llm-router') && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)))
}

/** Найти в вызовах fetch POST /llm-router/chat-probe и разобрать тела. */
function chatProbeBodies(fetchMock: ReturnType<typeof mockApiFetch>): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) => String(url).includes('/llm-router/chat-probe') && init?.method === 'POST',
    )
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

  it('пробы советника (§10): сценарий шлётся кнопкой и показывает ответ с задержкой', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch({ llmChatProbe: llmChatProbeFixture() })
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.selectOptions(screen.getByLabelText('Провайдер пробы'), 'prov-full')
    // Правка выбора провайдера ничего не отправляет — считает только кнопка
    expect(chatProbeBodies(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Роль и структура' }))
    expect(await screen.findByText(/Замечено: пик около 10 Гц/)).toBeInTheDocument()
    expect(screen.getByText('big-model-1 · 320 мс')).toBeInTheDocument()
    const bodies = chatProbeBodies(fetchMock) as { scenario: string }[]
    expect(bodies).toEqual([{ provider_id: 'prov-full', scenario: 'role' }])
  })

  it('проба советника: ошибка провайдера показывается честно', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      llmChatProbe: llmChatProbeFixture({
        ok: false,
        text: null,
        latency_ms: null,
        error: 'Провайдер ответил 401: нет доступа',
      }),
    })
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.selectOptions(screen.getByLabelText('Провайдер пробы'), 'prov-full')
    await user.click(screen.getByRole('button', { name: 'Отказ при нехватке данных' }))
    expect(
      await screen.findByText('Проба не прошла: Провайдер ответил 401: нет доступа'),
    ).toBeInTheDocument()
  })

  it('пробы советника недоступны без выбранного провайдера', async () => {
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    expect(screen.getByRole('button', { name: 'Русский диалог' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Ненаводящие вопросы' })).toBeDisabled()
  })

  it('проверка связи перебирает список моделей и показывает итог по каждой', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      llmProbe: llmProbeFixture({
        ok: false,
        error: '«alt-model»: Провайдер ответил 404: модель не найдена',
        models: [
          { model: 'big-model-1', ok: true, latency_ms: 420, error: null },
          {
            model: 'alt-model',
            ok: false,
            latency_ms: null,
            error: 'Провайдер ответил 404: модель не найдена',
          },
        ],
      }),
    })
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.click(screen.getByRole('button', { name: 'Проверить связь' }))

    expect(await screen.findByText('Модели: 1 из 2 ответили')).toBeInTheDocument()
    expect(screen.getByText('✓ big-model-1 — 420 мс')).toBeInTheDocument()
    expect(
      screen.getByText('✗ alt-model — Провайдер ответил 404: модель не найдена'),
    ).toBeInTheDocument()
  })

  it('пробы советника показывают ответ по каждой модели списка', async () => {
    const user = userEvent.setup()
    mockApiFetch({
      llmChatProbe: llmChatProbeFixture({
        models: [
          {
            model: 'big-model-1',
            ok: true,
            latency_ms: 320,
            text: 'Замечено: пик около 10 Гц.',
            error: null,
          },
          {
            model: 'alt-model',
            ok: true,
            latency_ms: 280,
            text: 'Замечено: ответ второй модели.',
            error: null,
          },
        ],
      }),
    })
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.selectOptions(screen.getByLabelText('Провайдер пробы'), 'prov-full')
    await user.click(screen.getByRole('button', { name: 'Роль и структура' }))

    expect(await screen.findByText('big-model-1 · 320 мс')).toBeInTheDocument()
    expect(screen.getByText('alt-model · 280 мс')).toBeInTheDocument()
    expect(screen.getByText(/Замечено: ответ второй модели/)).toBeInTheDocument()
  })

  it('модель маршрута chat выбирается списком моделей провайдера и сохраняется', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    const modelSelect = screen.getByLabelText('Модель советников (chat)')
    expect(modelSelect).toHaveValue('') // по умолчанию — первая модель списка
    await user.selectOptions(modelSelect, 'big-model-1')
    expect(modelSelect).toHaveValue('big-model-1')
    expect(putBodies(fetchMock)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1))
    const body = putBodies(fetchMock)[0] as { routes: { chat_model?: string | null } }
    expect(body.routes.chat_model).toBe('big-model-1')
  })

  it('смена провайдера маршрута chat сбрасывает выбранную модель', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.selectOptions(screen.getByLabelText('Модель советников (chat)'), 'big-model-1')
    await user.selectOptions(screen.getByLabelText('Советники (chat)'), '')
    expect(screen.getByLabelText('Модель советников (chat)')).toHaveValue('')
  })

  it('сохранение блокируется, если модель маршрута выпала из списка провайдера', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<ModelRouterPanel />)

    await screen.findByRole('textbox', { name: 'Имя' })
    await user.selectOptions(screen.getByLabelText('Модель советников (chat)'), 'big-model-1')
    const modelField = screen.getByLabelText('Модель')
    await user.clear(modelField)
    await user.type(modelField, 'other-model')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(
      await screen.findByText(/Модель маршрута chat не входит в список моделей/),
    ).toBeInTheDocument()
    expect(putBodies(fetchMock)).toHaveLength(0)
  })
})