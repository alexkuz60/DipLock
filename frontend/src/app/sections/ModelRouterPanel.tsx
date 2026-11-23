/**
 * Панель «Модельный роутер ИИ» раздела «Настройки»: провайдеры внешних API
 * полноценных моделей и маршруты chat/transcribe/decide (llama.cpp отклонён 10.10.2026).
 *
 * Правила: правка формы ничего не отправляет наружу (считает только кнопка
 * «Сохранить»), ключ вводится один раз и не возвращается сервером (только маска
 * `key_hint`), «Проверить связь» шлёт нейтральный запрос без материалов дела.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { llmRouterApi } from '@/shared/api/llmRouter'
import { apiErrorText } from '@/shared/api/client'
import type {
  LlmChatProbeResult,
  LlmChatProbeScenario,
  LlmDecideProbeResult,
  LlmProbeResult,
  LlmProviderIn,
  LlmRouterUpdate,
  LlmRoutes,
  RouteLlmModels,
} from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { SelectField } from '@/shared/ui/SelectField'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TextField } from '@/shared/ui/TextField'

type Protocol = LlmProviderIn['protocol']

/** Строка формы провайдера: id=null — новый (id назначит сервер). */
type ProviderRow = {
  id: string | null
  label: string
  protocol: Protocol
  baseUrl: string
  model: string
  enabled: boolean
  /** Введённый ключ: пусто — не менять серверный; «Забыть ключ» — очистить */
  apiKey: string
  /** Серверная маска (…abcd) для подсказки поля */
  keyHint: string | null
  clearKey: boolean
  /** Дополнительные параметры тела запроса как JSON-текст (пусто — без них) */
  extraText: string
}

type ProbeState = { pending: boolean; result: LlmProbeResult | null }

/** Состояние пробы советника (§10): выбранный провайдер и последний результат. */
type ChatProbeState = {
  providerId: string | null
  pending: boolean
  result: LlmChatProbeResult | null
}

/** Состояние пробы решающего классификатора (Jev): провайдер и последний результат. */
type DecideProbeState = {
  providerId: string | null
  pending: boolean
  result: LlmDecideProbeResult | null
}

/** Состояние каталога RouteLLM: выбранный провайдер, ответ и выбранные модели. */
type CatalogState = {
  providerId: string | null
  pending: boolean
  data: RouteLlmModels | null
  error: string | null
  selected: string[]
}

/** Сценарии проб §10: русский диалог, роль/структура, отказ при нехватке данных, вопросы. */
const CHAT_PROBE_SCENARIOS: { value: LlmChatProbeScenario; label: string }[] = [
  { value: 'dialog', label: 'Русский диалог' },
  { value: 'role', label: 'Роль и структура' },
  { value: 'insufficient', label: 'Отказ при нехватке данных' },
  { value: 'leading', label: 'Ненаводящие вопросы' },
]

/** Сводка проверки связи: для списка моделей — сколько ответили, иначе прежний текст. */
function probeSummary(result: LlmProbeResult | null): string {
  if (!result) return ''
  const models = result.models ?? []
  if (models.length > 1) {
    const okCount = models.filter((item) => item.ok).length
    return `Модели: ${okCount} из ${models.length} ответили`
  }
  return result.ok
    ? `Связь есть (${Math.round(result.latency_ms ?? 0)} мс)`
    : `Нет связи: ${result.error ?? 'неизвестная ошибка'}`
}

/** Построчный перебор моделей — только для списков из двух и больше. */
function probeModels(result: LlmProbeResult | null) {
  const models = result?.models ?? []
  return models.length > 1 ? models : []
}

const PROTOCOL_OPTIONS: { value: Protocol; label: string; hint: string }[] = [
  {
    value: 'openai',
    label: 'OpenAI-совместимый',
    hint: '/chat/completions: OpenAI, DeepSeek, Groq, OpenRouter, GigaChat/YandexGPT-совместимые',
  },
  { value: 'anthropic', label: 'Anthropic Messages', hint: 'Claude: /messages (без распознавания)' },
  {
    value: 'systemone',
    label: 'System One (Jev)',
    hint: 'Решающий классификатор: типизированные решения choice/score/noul; полный адрес вызова',
  },
]

function emptyRow(): ProviderRow {
  return {
    id: null,
    label: '',
    protocol: 'openai',
    baseUrl: 'https://',
    model: '',
    enabled: true,
    apiKey: '',
    keyHint: null,
    clearKey: false,
    extraText: '',
  }
}

/** Пресет RouteLLM: OpenAI-совместимый шлюз Abacus.AI, ключ вводится владельцем. */
function routellmRow(): ProviderRow {
  return {
    ...emptyRow(),
    label: 'RouteLLM (Abacus.AI)',
    baseUrl: 'https://routellm.abacus.ai/v1',
    model: 'route-llm',
  }
}

/** Лимит токенов для таблицы каталога: 1 000 000 или «—». */
function formatLimit(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString('ru-RU') : '—'
}

/** Цена за 1M токенов: «$5» или «—». */
function formatCost(value: number | null | undefined): string {
  return typeof value === 'number' ? `$${value}` : '—'
}

/** Модальности модели: «текст, изображение» или «—». */
function formatModalities(values: string[] | null | undefined): string {
  if (!values || values.length === 0) return '—'
  const names: Record<string, string> = {
    text: 'текст',
    image: 'изображение',
    audio: 'аудио',
    video: 'видео',
    pdf: 'PDF',
  }
  return values.map((value) => names[value] ?? value).join(', ')
}

/**
 * Разбор JSON дополнительных параметров: объект верхнего уровня.
 * Пустой текст — «без параметров» (сервер получит `{}` и уберёт прежние).
 */
function parseExtra(text: string): { [key: string]: unknown } {
  const trimmed = text.trim()
  if (!trimmed) return {}
  const parsed: unknown = JSON.parse(trimmed)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('json')
  }
  return parsed as { [key: string]: unknown }
}

/** Список моделей провайдера: id через запятую (зеркало `services/llm_router.py`). */
function splitModels(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Локальный адрес: провайдеру без ключа (Ollama, LM Studio) ключ не нужен. */
function isLocalBaseUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(url.trim())
}

/** Тело PUT: api_key/extra отправляются по явному видимому состоянию формы. */
function toProviderIn(row: ProviderRow): LlmProviderIn {
  const base: LlmProviderIn = {
    id: row.id,
    label: row.label.trim(),
    protocol: row.protocol,
    base_url: row.baseUrl.trim(),
    model: row.model.trim(),
    enabled: row.enabled,
    extra: parseExtra(row.extraText),
  }
  if (row.clearKey) return { ...base, api_key: '' }
  const apiKey = row.apiKey.trim()
  if (apiKey) return { ...base, api_key: apiKey }
  return base
}

export function ModelRouterPanel() {
  const queryClient = useQueryClient()
  const routerQuery = useQuery({
    queryKey: ['llmRouter'],
    queryFn: ({ signal }) => llmRouterApi.get(signal),
    staleTime: 30_000,
    retry: false,
  })

  /** Черновик формы: null — ещё не заполнен из сервера (поздний ответ не мешает правке). */
  const [rows, setRows] = useState<ProviderRow[] | null>(null)
  const [routes, setRoutes] = useState<LlmRoutes>({
    chat: null,
    chat_model: null,
    transcribe: null,
    decide: null,
  })
  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Проба сразу после сохранения: без неё провал ключа терялся между перезагрузками. */
  const [saveProbe, setSaveProbe] = useState<ProbeState>({ pending: false, result: null })
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const [chatProbe, setChatProbe] = useState<ChatProbeState>({
    providerId: null,
    pending: false,
    result: null,
  })
  const [decideProbe, setDecideProbe] = useState<DecideProbeState>({
    providerId: null,
    pending: false,
    result: null,
  })
  const [catalog, setCatalog] = useState<CatalogState>({
    providerId: null,
    pending: false,
    data: null,
    error: null,
    selected: [],
  })

  useEffect(() => {
    const data = routerQuery.data
    if (!data || rows !== null) return
    setRows(
      data.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        protocol: provider.protocol,
        baseUrl: provider.base_url,
        model: provider.model,
        enabled: provider.enabled,
        apiKey: '',
        keyHint: provider.key_hint ?? null,
        clearKey: false,
        extraText: provider.extra ? JSON.stringify(provider.extra, null, 2) : '',
      })),
    )
    setRoutes({
      chat: data.routes.chat,
      chat_model: data.routes.chat_model ?? null,
      transcribe: data.routes.transcribe,
      decide: data.routes.decide ?? null,
    })
  }, [routerQuery.data, rows])

  const editRow = (index: number, patch: Partial<ProviderRow>) => {
    setRows((prev) => (prev ? prev.map((row, i) => (i === index ? { ...row, ...patch } : row)) : prev))
    setDirty(true)
  }

  const addRow = () => {
    setRows((prev) => [...(prev ?? []), emptyRow()])
    setDirty(true)
  }

  const removeRow = (index: number) => {
    setRows((prev) => {
      if (!prev) return prev
      const removed = prev[index]
      if (removed.id) {
        setRoutes((current) => ({
          chat: current.chat === removed.id ? null : current.chat,
          chat_model: current.chat === removed.id ? null : current.chat_model,
          transcribe: current.transcribe === removed.id ? null : current.transcribe,
          decide: current.decide === removed.id ? null : current.decide,
        }))
      }
      return prev.filter((_, i) => i !== index)
    })
    setDirty(true)
  }

  /** Собрать тело PUT из формы; null — форма невалидна, текст уже в saveError. */
  const collectPayload = (): LlmRouterUpdate | null => {
    const chosen = routes.chat_model ?? null
    const allowed = splitModels(chatProviderRow?.model ?? '')
    if (chosen && (!routes.chat || !allowed.includes(chosen))) {
      setSaveError(
        'Модель маршрута chat не входит в список моделей выбранного провайдера — выберите заново',
      )
      return null
    }
    try {
      return {
        providers: providerRows.map(toProviderIn),
        routes: {
          chat: routes.chat,
          chat_model: chosen,
          transcribe: routes.transcribe,
          decide: routes.decide,
        },
      }
    } catch {
      setSaveError(
        'Дополнительные параметры — некорректный JSON (нужен объект вида {"ключ": значение})',
      )
      return null
    }
  }

  /** «Сохранить и проверить»: PUT, затем проба маршрута chat по свежему состоянию. */
  const saveAndProbe = async () => {
    const payload = collectPayload()
    if (!payload) return
    setSaveProbe({ pending: true, result: null })
    try {
      const data = await save.mutateAsync(payload)
      const providerId = data.routes.chat
      if (!providerId) {
        setSaveProbe({
          pending: false,
          result: {
            ok: false,
            provider_id: '',
            route: 'chat',
            model: null,
            latency_ms: null,
            error: 'Маршрут «Советники (chat)» не выбран — проба невозможна',
          },
        })
        return
      }
      const result = await llmRouterApi.probe({ provider_id: providerId, route: 'chat' })
      setSaveProbe({ pending: false, result })
      setProbes((prev) => ({ ...prev, [providerId]: { pending: false, result } }))
    } catch (error) {
      setSaveProbe({
        pending: false,
        result: {
          ok: false,
          provider_id: '',
          route: 'chat',
          model: null,
          latency_ms: null,
          error: apiErrorText(error),
        },
      })
    }
  }

  const save = useMutation({
    mutationFn: (payload: LlmRouterUpdate) => llmRouterApi.update(payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['llmRouter'], data)
      setRows(
        data.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          baseUrl: provider.base_url,
          model: provider.model,
          enabled: provider.enabled,
          apiKey: '',
          keyHint: provider.key_hint ?? null,
          clearKey: false,
          extraText: provider.extra ? JSON.stringify(provider.extra, null, 2) : '',
        })),
      )
      setRoutes({
        chat: data.routes.chat,
        chat_model: data.routes.chat_model ?? null,
        transcribe: data.routes.transcribe,
        decide: data.routes.decide ?? null,
      })
      setDirty(false)
      setSaveError(null)
    },
    onError: (error) => setSaveError(apiErrorText(error)),
  })

  /** Нейтральная проверка связи (без материалов дела) — только по сохранённому провайдеру. */
  const runProbe = async (providerId: string, route: 'chat' | 'decide' = 'chat') => {
    setProbes((prev) => ({ ...prev, [providerId]: { pending: true, result: null } }))
    try {
      const result = await llmRouterApi.probe({ provider_id: providerId, route })
      setProbes((prev) => ({ ...prev, [providerId]: { pending: false, result } }))
    } catch (error) {
      setProbes((prev) => ({
        ...prev,
        [providerId]: {
          pending: false,
          result: {
            ok: false,
            provider_id: providerId,
            route,
            model: null,
            latency_ms: null,
            error: apiErrorText(error),
          },
        },
      }))
    }
  }

  /** Проба советника (§10): синтетический сценарий, только по кнопке, без материалов дела. */
  const runChatProbe = async (scenario: LlmChatProbeScenario) => {
    const providerId = chatProbe.providerId
    if (!providerId) return
    setChatProbe((prev) => ({ ...prev, pending: true, result: null }))
    try {
      const result = await llmRouterApi.chatProbe({ provider_id: providerId, scenario })
      setChatProbe((prev) => ({ ...prev, pending: false, result }))
    } catch (error) {
      setChatProbe((prev) => ({
        ...prev,
        pending: false,
        result: {
          ok: false,
          provider_id: providerId,
          scenario,
          model: null,
          latency_ms: null,
          text: null,
          error: apiErrorText(error),
          truncated: false,
        },
      }))
    }
  }

  /** Проба решающего классификатора (Jev): синтетический state, только кнопкой. */
  const runDecideProbe = async () => {
    const providerId = decideProbe.providerId
    if (!providerId) return
    setDecideProbe((prev) => ({ ...prev, pending: true, result: null }))
    try {
      const result = await llmRouterApi.decideProbe({ provider_id: providerId })
      setDecideProbe((prev) => ({ ...prev, pending: false, result }))
    } catch (error) {
      setDecideProbe((prev) => ({
        ...prev,
        pending: false,
        result: {
          ok: false,
          provider_id: providerId,
          model: null,
          latency_ms: null,
          answers: {},
          error: apiErrorText(error),
        },
      }))
    }
  }

  const panelHint =
    'Полноценные модели через внешние API (llama.cpp отклонён 10.10.2026). Ключи хранятся ' +
    'на сервере и в интерфейс не возвращаются; материалы дела уходят провайдеру только ' +
    'явным действием в разделе «Консилиум».'

  if (routerQuery.isPending) {
    return (
      <Panel title="Модельный роутер ИИ" hint={panelHint}>
        <LoadingBlock />
      </Panel>
    )
  }
  if (routerQuery.isError) {
    return (
      <Panel title="Модельный роутер ИИ" hint={panelHint}>
        <ErrorBlock message={apiErrorText(routerQuery.error)} />
      </Panel>
    )
  }

  const providerRows = rows ?? []
  const savedProviders = providerRows.filter((row) => row.id !== null)
  const routeOptions = [
    { value: '', label: '— не назначен' },
    ...savedProviders.map((row) => ({
      value: row.id as string,
      label: row.label.trim() || 'Без имени',
    })),
  ]
  const transcribeOptions = [
    { value: '', label: '— не назначен' },
    ...savedProviders.map((row) => ({
      value: row.id as string,
      label: row.label.trim() || 'Без имени',
      disabled: row.protocol !== 'openai',
    })),
  ]
  const decideOptions = [
    { value: '', label: '— не назначен' },
    ...savedProviders.map((row) => ({
      value: row.id as string,
      label: row.label.trim() || 'Без имени',
      disabled: row.protocol !== 'systemone',
    })),
  ]
  const chatProviderRow = providerRows.find((row) => row.id === routes.chat)
  const chatModelOptions = [
    { value: '', label: '— первая модель списка —' },
    ...splitModels(chatProviderRow?.model ?? '').map((model) => ({ value: model, label: model })),
  ]

  /** Каталог RouteLLM: список моделей провайдера — только по кнопке. */
  const loadCatalog = async () => {
    const providerId = catalog.providerId
    if (!providerId) return
    setCatalog((prev) => ({ ...prev, pending: true, data: null, error: null, selected: [] }))
    try {
      const data = await llmRouterApi.routellmModels(providerId)
      setCatalog((prev) => ({ ...prev, pending: false, data, selected: [] }))
    } catch (error) {
      setCatalog((prev) => ({ ...prev, pending: false, error: apiErrorText(error) }))
    }
  }

  const toggleCatalogModel = (modelId: string) => {
    setCatalog((prev) => ({
      ...prev,
      selected: prev.selected.includes(modelId)
        ? prev.selected.filter((item) => item !== modelId)
        : [...prev.selected, modelId],
    }))
  }

  /** Добавить выбранные модели в поле «Модель» провайдера (сохранение — кнопкой). */
  const addSelectedModels = () => {
    if (!catalog.providerId || catalog.selected.length === 0) return
    const index = providerRows.findIndex((row) => row.id === catalog.providerId)
    if (index < 0) return
    const merged = splitModels(providerRows[index].model)
    for (const modelId of catalog.selected) {
      if (!merged.includes(modelId)) merged.push(modelId)
    }
    editRow(index, { model: merged.join(', ') })
    setCatalog((prev) => ({ ...prev, selected: [] }))
  }

  return (
    <Panel title="Модельный роутер ИИ" hint={panelHint}>
      <p className="text-sm text-fg-2">
        Маршруты указывают, каким провайдером пользуются советники (chat), распознавание
        (transcribe) и решающий классификатор Jev (decide). «Проверить связь» шлёт нейтральный
        запрос без данных дела.
      </p>

      {providerRows.length === 0 ? (
        <p className="text-sm text-fg-2">
          Провайдеры не добавлены — ИИ-советники и распознавание недоступны.
        </p>
      ) : null}

      {providerRows.map((row, index) => {
        const probeState = row.id ? probes[row.id] : undefined
        return (
          <div key={row.id ?? `new-${index}`} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 pb-1">
              <span className="text-sm font-medium text-fg-0">
                {row.label.trim() || 'Новый провайдер'}
              </span>
              <Button variant="ghost" onClick={() => removeRow(index)}>
                Удалить
              </Button>
            </div>
            <TextField
              label="Имя"
              value={row.label}
              onChange={(value) => editRow(index, { label: value })}
            />
            <SelectField
              label="Протокол"
              value={row.protocol}
              options={PROTOCOL_OPTIONS}
              onChange={(value) => editRow(index, { protocol: value })}
            />
            <TextField
              label="Адрес API"
              mono
              value={row.baseUrl}
              hint={
                row.protocol === 'systemone'
                  ? 'Полный адрес вызова решений Jev (путь не дописывается): https://api.typesafe.ai/v1/systemone'
                  : 'Как у провайдера, с /v1 или без: https://api.deepseek.com, https://api.openai.com/v1, https://api.anthropic.com/v1'
              }
              onChange={(value) => editRow(index, { baseUrl: value })}
            />
            <TextField
              label="Модель"
              mono
              value={row.model}
              hint="Одна модель или список через запятую: пробы идут по каждой, маршруты используют первую. Например: deepseek-flash, deepseek-v4-pro, gpt-4o"
              onChange={(value) => editRow(index, { model: value })}
            />
            <div className="ui-list-row flex items-start gap-3 py-2">
              <span className="w-32 shrink-0 pt-1.5 text-sm text-fg-2">Параметры</span>
              <textarea
                aria-label="Дополнительные параметры"
                value={row.extraText}
                rows={2}
                placeholder='{"thinking": {"type": "enabled"}, "reasoning_effort": "high"}'
                onChange={(event) => editRow(index, { extraText: event.target.value })}
                className="w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 font-mono text-sm text-fg-0"
              />
            </div>
            <p className="pb-1 text-sm text-fg-2">
              JSON дополняет тело запроса (DeepSeek: thinking/reasoning_effort);
              model/messages/stream задаются роутером. Пусто — без параметров.
            </p>
            <CheckboxRow
              label="Включён"
              checked={row.enabled}
              onChange={(checked) => editRow(index, { enabled: checked })}
            />
            <div className="ui-list-row flex items-center gap-3 py-2">
              <span className="w-32 shrink-0 text-sm text-fg-2">Ключ API</span>
              <input
                type="password"
                value={row.clearKey ? '' : row.apiKey}
                disabled={row.clearKey}
                placeholder={
                  row.clearKey
                    ? 'ключ будет удалён'
                    : row.keyHint
                      ? `сохранён (${row.keyHint}); пустое поле оставит прежний`
                      : 'не задан'
                }
                onChange={(event) =>
                  editRow(index, { apiKey: event.target.value, clearKey: false })
                }
                className="w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-sm text-fg-0 disabled:cursor-not-allowed disabled:opacity-40"
              />
              {row.keyHint && !row.clearKey ? (
                <Button
                  variant="ghost"
                  onClick={() => editRow(index, { clearKey: true, apiKey: '' })}
                >
                  Забыть ключ
                </Button>
              ) : null}
              {row.clearKey ? (
                <Button variant="ghost" onClick={() => editRow(index, { clearKey: false })}>
                  Не удалять
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Button
                disabled={!row.id || probeState?.pending || save.isPending}
                onClick={() =>
                  row.id && runProbe(row.id, row.protocol === 'systemone' ? 'decide' : 'chat')
                }
              >
                {row.id ? 'Проверить связь' : 'Сохраните, чтобы проверить'}
              </Button>
              {probeState ? (
                <div className="space-y-1">
                  <span
                    role="status"
                    className={probeState.result?.ok ? 'text-sm text-fg-1' : 'text-sm text-danger'}
                  >
                    {probeState.pending ? 'Проверка…' : probeSummary(probeState.result)}
                  </span>
                  {probeModels(probeState.result).map((item) => (
                    <p
                      key={item.model}
                      className={item.ok ? 'text-sm text-fg-1' : 'text-sm text-danger'}
                    >
                      {item.ok
                        ? `✓ ${item.model} — ${Math.round(item.latency_ms ?? 0)} мс`
                        : `✗ ${item.model} — ${item.error ?? 'неизвестная ошибка'}`}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={addRow}>Добавить провайдера</Button>
        <Button onClick={() => { setRows((prev) => [...(prev ?? []), routellmRow()]); setDirty(true) }}>
          Добавить RouteLLM
        </Button>
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-fg-0">Каталог RouteLLM</p>
        <p className="text-sm text-fg-2">
          Список моделей провайдера с ценой за 1M токенов, модальностями и лимитами контекста.
          Запрос уходит провайдеру только по кнопке; ключ остаётся на сервере. Выбранные модели
          добавляются в поле «Модель» и сохраняются общей кнопкой «Сохранить».
        </p>
        <SelectField
          label="Провайдер каталога"
          value={catalog.providerId ?? ''}
          options={[
            { value: '', label: '— выберите —' },
            ...savedProviders.map((row) => ({
              value: row.id as string,
              label: row.label.trim() || 'Без имени',
              disabled: row.protocol === 'systemone',
            })),
          ]}
          onChange={(value) =>
            setCatalog({
              providerId: value || null,
              pending: false,
              data: null,
              error: null,
              selected: [],
            })
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!catalog.providerId || catalog.pending || save.isPending}
            onClick={() => void loadCatalog()}
          >
            {catalog.pending ? 'Загрузка...' : 'Загрузить модели'}
          </Button>
          <Button disabled={catalog.selected.length === 0} onClick={addSelectedModels}>
            Добавить выбранные ({catalog.selected.length})
          </Button>
        </div>
        {catalog.error ? (
          <p role="alert" className="text-sm text-danger">
            {catalog.error}
          </p>
        ) : null}
        {catalog.data ? (
          <div className="space-y-2">
            {(catalog.data.warnings ?? []).map((warning) => (
              <p key={warning} className="text-sm text-danger">
                ⚠ {warning}
              </p>
            ))}
            {(catalog.data.models ?? []).length === 0 ? (
              <p className="text-sm text-fg-2">Провайдер не вернул ни одной модели.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-fg-2">
                      <th className="py-1 pr-2 font-medium"> </th>
                      <th className="py-1 pr-2 font-medium">Модель</th>
                      <th className="py-1 pr-2 font-medium">Вход</th>
                      <th className="py-1 pr-2 font-medium">Контекст / ответ</th>
                      <th className="py-1 pr-2 font-medium">$ вход / выход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(catalog.data.models ?? []).map((model) => (
                      <tr key={model.id} className="border-t border-border align-top">
                        <td className="py-1 pr-2">
                          <input
                            type="checkbox"
                            aria-label={`Выбрать ${model.id}`}
                            checked={catalog.selected.includes(model.id)}
                            onChange={() => toggleCatalogModel(model.id)}
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <span className="font-mono text-xs text-fg-0">{model.id}</span>
                          {model.name ? (
                            <span className="block text-fg-2">{model.name}</span>
                          ) : null}
                        </td>
                        <td className="py-1 pr-2 text-fg-1">
                          {formatModalities(model.modalities_input)}
                        </td>
                        <td className="py-1 pr-2 text-fg-1">
                          {formatLimit(model.context)} / {formatLimit(model.output)}
                        </td>
                        <td className="py-1 pr-2 text-fg-1">
                          {formatCost(model.cost_input)} / {formatCost(model.cost_output)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-sm text-fg-2">
              Остаток кредитов:{' '}
              {catalog.data.credits.available ? 'доступен' : catalog.data.credits.note}{' '}
              <a
                className="underline"
                href={catalog.data.credits.billing_url}
                target="_blank"
                rel="noreferrer"
              >
                Billing and Invoices
              </a>
            </p>
          </div>
        ) : null}
      </div>

      <SelectField
        label="Советники (chat)"
        value={routes.chat ?? ''}
        options={routeOptions}
        hint="Кому поручать разговор в «Консилиуме» (Т3)"
        onChange={(value) => {
          setRoutes((prev) => ({
            ...prev,
            chat: value || null,
            chat_model: value === prev.chat ? prev.chat_model : null,
          }))
          setDirty(true)
        }}
      />
      {chatProviderRow &&
      !chatProviderRow.keyHint &&
      !chatProviderRow.apiKey &&
      !chatProviderRow.clearKey &&
      !isLocalBaseUrl(chatProviderRow.baseUrl) ? (
        <p role="alert" className="text-sm text-danger">
          У выбранного провайдера нет ключа API — маршрут «Советники» получит отказ
          провайдера. Введите ключ в карточке провайдера и сохраните.
        </p>
      ) : null}
      <SelectField
        label="Модель советников (chat)"
        value={routes.chat_model ?? ''}
        options={chatModelOptions}
        disabled={!chatProviderRow}
        hint="Какая модель списка провайдера отвечает в «Консилиуме» (Т3); «первая» — верхняя в поле «Модель»"
        onChange={(value) => {
          setRoutes((prev) => ({ ...prev, chat_model: value || null }))
          setDirty(true)
        }}
      />
      <SelectField
        label="Распознавание (transcribe)"
        value={routes.transcribe ?? ''}
        options={transcribeOptions}
        hint="Стенограмма беседы (Т2); только OpenAI-совместимый API"
        onChange={(value) => {
          setRoutes((prev) => ({ ...prev, transcribe: value || null }))
          setDirty(true)
        }}
      />
      <SelectField
        label="Решающий классификатор (decide)"
        value={routes.decide ?? ''}
        options={decideOptions}
        hint="Триаж досье «Консилиума» (Jev, §5.2): типизированные решения choice/score/noul; только protocol=systemone"
        onChange={(value) => {
          setRoutes((prev) => ({ ...prev, decide: value || null }))
          setDirty(true)
        }}
      />

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <Button
          variant="primary"
          disabled={!dirty || save.isPending || saveProbe.pending}
          onClick={() => {
            const payload = collectPayload()
            if (payload) save.mutate(payload)
          }}
        >
          Сохранить
        </Button>
        <Button
          variant="secondary"
          disabled={!dirty || save.isPending || saveProbe.pending}
          onClick={() => void saveAndProbe()}
        >
          Сохранить и проверить
        </Button>
        {save.isPending || saveProbe.pending ? (
          <span className="text-sm text-fg-2">
            {saveProbe.pending ? 'Сохранение и проба...' : 'Сохранение...'}
          </span>
        ) : null}
      </div>
      {saveError ? (
        <p role="alert" className="text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      {saveProbe.result ? (
        <p
          role="status"
          className={saveProbe.result.ok ? 'text-sm text-fg-1' : 'text-sm text-danger'}
        >
          {saveProbe.result.ok
            ? `Ключ принят: ${probeSummary(saveProbe.result)}`
            : `Ключ не принят: ${saveProbe.result.error ?? 'неизвестная ошибка'}`}
        </p>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-fg-0">Пробы советника (§10)</p>
        <p className="text-sm text-fg-2">
          Синтетические сценарии для выбора модели маршрута «Советники (chat)»: русский диалог,
          роль и структура ответа, отказ при недостаточности данных, ненаводящие вопросы. При
          списке моделей провайдера проба идёт по каждой. Запрос уйдёт внешнему провайдеру;
          материалы дела не отправляются. Запуск — только кнопкой.
        </p>
        <SelectField
          label="Провайдер пробы"
          value={chatProbe.providerId ?? ''}
          options={[
            { value: '', label: '— выберите —' },
            ...savedProviders.map((row) => ({
              value: row.id as string,
              label: row.label.trim() || 'Без имени',
            })),
          ]}
          onChange={(value) => setChatProbe((prev) => ({ ...prev, providerId: value || null }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          {CHAT_PROBE_SCENARIOS.map((scenario) => (
            <Button
              key={scenario.value}
              disabled={!chatProbe.providerId || chatProbe.pending || save.isPending}
              onClick={() => runChatProbe(scenario.value)}
            >
              {scenario.label}
            </Button>
          ))}
          {chatProbe.pending ? (
            <span role="status" className="text-sm text-fg-2">
              Запрос к модели…
            </span>
          ) : null}
        </div>
        {chatProbe.result ? (
          (chatProbe.result.models ?? []).length > 1 ? (
            <div className="space-y-2">
              {(chatProbe.result.models ?? []).map((item) =>
                item.ok ? (
                  <div key={item.model} className="space-y-1" role="status">
                    <p className="text-sm text-fg-1">
                      {item.model} · {Math.round(item.latency_ms ?? 0)} мс
                    </p>
                    <p className="whitespace-pre-wrap rounded-lg border border-border bg-bg-2 p-2.5 text-sm text-fg-0">
                      {item.text}
                    </p>
                    {item.truncated ? (
                      <p className="text-sm text-danger">
                        ⚠ Ответ обрезан по бюджету токенов — модель не закончила
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p key={item.model} role="alert" className="text-sm text-danger">
                    {item.model}: проба не прошла — {item.error ?? 'неизвестная ошибка'}
                  </p>
                ),
              )}
            </div>
          ) : chatProbe.result.ok ? (
            <div className="space-y-1" role="status">
              <p className="text-sm text-fg-1">
                {chatProbe.result.model ?? 'модель неизвестна'} ·{' '}
                {Math.round(chatProbe.result.latency_ms ?? 0)} мс
              </p>
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-bg-2 p-2.5 text-sm text-fg-0">
                {chatProbe.result.text}
              </p>
              {chatProbe.result.truncated ? (
                <p className="text-sm text-danger">
                  ⚠ Ответ обрезан по бюджету токенов — модель не закончила
                </p>
              ) : null}
            </div>
          ) : (
            <p role="alert" className="text-sm text-danger">
              Проба не прошла: {chatProbe.result.error ?? 'неизвестная ошибка'}
            </p>
          )
        ) : null}
      </div>

      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-fg-0">Проба решающего классификатора (Jev)</p>
        <p className="text-sm text-fg-2">
          Синтетический state (учебное описание досье) для маршрута «Решающий классификатор
          (decide)»: проверка протокола и русского языка инструкций. Материалы дела не
          отправляются; запуск — только кнопкой.
        </p>
        <SelectField
          label="Провайдер пробы (Jev)"
          value={decideProbe.providerId ?? ''}
          options={[
            { value: '', label: '— выберите —' },
            ...savedProviders.map((row) => ({
              value: row.id as string,
              label: row.label.trim() || 'Без имени',
            })),
          ]}
          onChange={(value) => setDecideProbe((prev) => ({ ...prev, providerId: value || null }))}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={!decideProbe.providerId || decideProbe.pending || save.isPending}
            onClick={() => void runDecideProbe()}
          >
            Проба Jev
          </Button>
          {decideProbe.pending ? (
            <span role="status" className="text-sm text-fg-2">
              Запрос к классификатору…
            </span>
          ) : null}
        </div>
        {decideProbe.result ? (
          decideProbe.result.ok ? (
            <div className="space-y-1" role="status">
              <p className="text-sm text-fg-1">
                {decideProbe.result.model ?? 'модель неизвестна'} ·{' '}
                {Math.round(decideProbe.result.latency_ms ?? 0)} мс
              </p>
              <pre className="overflow-x-auto rounded-lg border border-border bg-bg-2 p-2.5 font-mono text-xs text-fg-0">
                {JSON.stringify(decideProbe.result.answers, null, 2)}
              </pre>
            </div>
          ) : (
            <p role="alert" className="text-sm text-danger">
              Проба не прошла: {decideProbe.result.error ?? 'неизвестная ошибка'}
            </p>
          )
        ) : null}
      </div>
    </Panel>
  )
}