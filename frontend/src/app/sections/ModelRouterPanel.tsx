/**
 * Панель «Модельный роутер ИИ» раздела «Настройки»: провайдеры внешних API
 * полноценных моделей и маршруты chat/transcribe (llama.cpp отклонён 10.10.2026).
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
  LlmProbeResult,
  LlmProviderIn,
  LlmRouterUpdate,
  LlmRoutes,
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
  if (row.apiKey) return { ...base, api_key: row.apiKey }
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
  const [routes, setRoutes] = useState<LlmRoutes>({ chat: null, chat_model: null, transcribe: null })
  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const [chatProbe, setChatProbe] = useState<ChatProbeState>({
    providerId: null,
    pending: false,
    result: null,
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
        }))
      }
      return prev.filter((_, i) => i !== index)
    })
    setDirty(true)
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
      })
      setDirty(false)
      setSaveError(null)
    },
    onError: (error) => setSaveError(apiErrorText(error)),
  })

  /** Нейтральная проверка связи (без материалов дела) — только по сохранённому провайдеру. */
  const runProbe = async (providerId: string) => {
    setProbes((prev) => ({ ...prev, [providerId]: { pending: true, result: null } }))
    try {
      const result = await llmRouterApi.probe({ provider_id: providerId, route: 'chat' })
      setProbes((prev) => ({ ...prev, [providerId]: { pending: false, result } }))
    } catch (error) {
      setProbes((prev) => ({
        ...prev,
        [providerId]: {
          pending: false,
          result: {
            ok: false,
            provider_id: providerId,
            route: 'chat',
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
  const chatProviderRow = providerRows.find((row) => row.id === routes.chat)
  const chatModelOptions = [
    { value: '', label: '— первая модель списка —' },
    ...splitModels(chatProviderRow?.model ?? '').map((model) => ({ value: model, label: model })),
  ]

  return (
    <Panel title="Модельный роутер ИИ" hint={panelHint}>
      <p className="text-sm text-fg-2">
        Маршруты указывают, каким провайдером пользуются советники (chat) и распознавание
        (transcribe). «Проверить связь» шлёт нейтральный запрос без данных дела.
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
              hint="Как у провайдера, с /v1 или без: https://api.deepseek.com, https://api.openai.com/v1, https://api.anthropic.com/v1"
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
                onClick={() => row.id && runProbe(row.id)}
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

      <Button onClick={addRow}>Добавить провайдера</Button>

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

      <div className="flex items-center gap-3 pt-2">
        <Button
          variant="primary"
          disabled={!dirty || save.isPending}
          onClick={() => {
            const chosen = routes.chat_model ?? null
            const allowed = splitModels(chatProviderRow?.model ?? '')
            if (chosen && (!routes.chat || !allowed.includes(chosen))) {
              setSaveError(
                'Модель маршрута chat не входит в список моделей выбранного провайдера — выберите заново',
              )
              return
            }
            try {
              save.mutate({
                providers: providerRows.map(toProviderIn),
                routes: {
                  chat: routes.chat,
                  chat_model: chosen,
                  transcribe: routes.transcribe,
                },
              })
            } catch {
              setSaveError(
                'Дополнительные параметры — некорректный JSON (нужен объект вида {"ключ": значение})',
              )
            }
          }}
        >
          Сохранить
        </Button>
        {save.isPending ? <span className="text-sm text-fg-2">Сохранение…</span> : null}
      </div>
      {saveError ? (
        <p role="alert" className="text-sm text-danger">
          {saveError}
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
    </Panel>
  )
}